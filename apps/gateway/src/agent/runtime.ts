import { randomUUID } from 'node:crypto';
import type { MCPClient } from '@ai-sdk/mcp';
import { LEARNING_SESSION_CHANNEL, type ModelConfig, type Run } from '@jian/contracts';
import {
  generateText,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  stepCountIs,
  ToolLoopAgent,
  type ToolSet,
  tool,
} from 'ai';
import { z } from 'zod';
import { fitPrompt, promptTokens, tokenCounter } from '../context/budget.js';
import { compactPrompt, needsCompaction } from '../context/compaction.js';
import type { ContextSource } from '../context/port.js';
import type { Learning } from '../learning/service.js';
import type { Media } from '../media/service.js';
import { anthropicCredential, withClaudeCodeIdentity } from '../providers/claude-subscription.js';
import { lightEffort, reasoningProviderOptions } from '../providers/effort.js';
import { resolveModel } from '../providers/models.js';
import { readModelDefaults } from '../providers/repository.js';
import type { Providers } from '../providers/service.js';
import { providerSecret } from '../providers/service.js';
import { createSafeFetch } from '../security/outbound.js';
import {
  type CavemanMode,
  cavemanMode,
  type PonytailMode,
  ponytailMode,
} from '../sessions/repository.js';
import { findSkill } from '../skills/builtin/index.js';
import type { Stickers } from '../stickers/service.js';
import type { WebSearch } from '../web/service.js';
import { type CacheTtl, cacheable, cacheableInstructions, withOpenAiPromptCache } from './cache.js';
import { ACTION_KINDS, actionGuard, guardTools, mcpActionKind } from './guard.js';
import { availableNote, connectMcpTools, unavailableNote } from './mcp.js';
import { Narrator } from './narrator.js';
import { ProgressReporter } from './progress.js';
import { boundToolResult, redactOutput, redactText } from './results.js';
import { deferTools, profileTools, type ToolServices } from './tools.js';
import type { ModelResolver, RuntimeOptions } from './types.js';
import { markSteering, outsideContent } from './untrusted.js';
import { prepareWorkerWorkspace } from './worker-workspace.js';

/**
 * How long a model call or a tool may go without a sign of life before the turn is given up.
 * Longer than a machine command may run (two minutes) or a colleague is waited for, so it
 * fires on something that hung, not on work that takes its time.
 */
const STALLED_AFTER_MS = 5 * 60_000;

/**
 * Keys and tokens by their look — OpenAI and Anthropic, Google, Groq, GitHub — and whatever
 * follows a bearer or an `api_key=`: an error can quote a credential this run never held.
 */
const CREDENTIAL_SHAPES =
  /\b(sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,}|gsk_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b|\bBearer\s+\S+|\b(?:cookie|set-cookie|headers)\s*[:=][^\r\n]+|\b(api[_-]?key|token|secret|password|authorization)(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi;

export type { RuntimeOptions } from './types.js';

/** The run services the runtime drives, plus what it hands to the tool set it builds. */
export type RuntimeServices = ToolServices & {
  contexts: ContextSource;
  providers?: Pick<Providers, 'selectedModel'> & Partial<Pick<Providers, 'modelDefaults'>>;
  media?: Pick<Media, 'prepare' | 'tools'>;
  web?: Pick<WebSearch, 'tools'>;
  learning?: Pick<Learning, 'consider'>;
  stickers?: Pick<Stickers, 'tools'>;
};

/**
 * What a look back may touch: its memories and its skills, nothing that reaches a person or
 * the machine. A review that could send a message would be a turn nobody asked for.
 */
const LEARNING_TOOLS = new Set([
  'read_memories',
  'remember',
  'forget_memory',
  'link_memories',
  'unlink_memories',
  'create_skill',
  'update_skill',
  'delete_skill',
  'load_skill',
]);
/** A look back is short: a few reads and a write or two. */
const LEARNING_STEPS = 8;

export class AgentRuntime {
  private controllers = new Map<string, AbortController>();

  constructor(
    private services: RuntimeServices,
    private model: ModelResolver = resolveModel,
    private options: RuntimeOptions = {},
  ) {}

  /** Naming is cosmetic and must not spend a separate, uncounted model request. */
  private async nameConversation(run: Run, secrets: Set<string>) {
    const opening = redactText(run.input, secrets).trim().replace(/\s+/g, ' ');
    const title = opening.length <= 60 ? opening : `${opening.slice(0, 59).trimEnd()}…`;
    await this.services.sessions.nameIfUnnamed(run.profileId, run.sessionId, title).catch(() => {});
  }

  /**
   * The answer a loop never got round to writing, asked for without tools so it cannot start
   * another round. What it says is bounded by what already happened: every tool result of the
   * run is in the messages it is handed.
   */
  private async closingWords(
    model: LanguageModel,
    instructions: string,
    messages: ModelMessage[],
    config: { provider: string; modelId: string },
    account: (
      usage: LanguageModelUsage,
      inputTokens: number,
      text: string,
      steps: number,
    ) => Promise<unknown>,
    policy: NonNullable<Run['contextPolicy']>,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      const fitted = fitPrompt({
        ...config,
        policy,
        messages,
        tools: {},
        instructions: `${instructions}\n\nThis turn ended without a final report. Answer now with what you already have, and call nothing further. Say plainly what you found, what you did, and what is still unknown. Never imply you finished work you did not.`,
      });
      const { text, usage } = await generateText({
        model,
        system: fitted.instructions,
        maxRetries: 0,
        maxOutputTokens: policy.outputTokens,
        abortSignal: signal,
        messages: fitted.messages,
      });

      await account(usage, fitted.tokens, text, 0);
      return text.trim();
    } catch {
      return '';
    }
  }

  cancel(runId: string) {
    this.controllers.get(runId)?.abort();
  }

  stop() {
    for (const controller of this.controllers.values()) {
      controller.abort();
    }
  }

  async execute(profileId: string, runId: string) {
    const owner = randomUUID();
    const run = await this.services.lifecycle.claim(runId, profileId, owner);

    if (!run) {
      return;
    }

    const controller = new AbortController();

    this.controllers.set(runId, controller);

    // No clock on the whole turn: a long conversation doing its work is never cut. What stops
    // a turn is the owner's Cancel, the step and token budgets, and this: a model call or a
    // tool that has produced nothing for STALLED_AFTER_MS is not coming back.
    const stalled = new AbortController();
    let lastSign = Date.now();
    const alive = () => {
      lastSign = Date.now();
    };
    const watchdog = setInterval(() => {
      if (Date.now() - lastSign > STALLED_AFTER_MS) stalled.abort();
    }, 5_000);

    watchdog.unref();

    const signal = AbortSignal.any([controller.signal, stalled.signal]);
    const clients: MCPClient[] = [];
    const outbound = this.options.outbound ?? createSafeFetch();
    const ownsOutbound = !this.options.outbound;
    const secrets = new Set<string>();
    let externalUncertain = false;
    let externalUncertainDetail: string | undefined;
    let lastCompactionAttempt = -4;
    let compactionRequested = false;

    const progress = new ProgressReporter((snapshot) =>
      this.services.lifecycle.progress(runId, owner, snapshot),
    );

    const pulse = setInterval(() => {
      void this.services.lifecycle
        .heartbeat(profileId, runId, owner)
        .catch(() => controller.abort());
    }, 10_000);

    pulse.unref();

    try {
      const defaults = await this.services.providers?.modelDefaults?.(profileId);
      const policy = run.contextPolicy ?? run.profile.contextPolicy;
      const config = run.model ?? run.profile.model;
      let providerKey: string | undefined;

      if (config.provider === 'openai-codex' && config.providerId) {
        if (!this.options.codexLogin) throw new Error('ChatGPT login is unavailable');
        providerKey = await this.options.codexLogin.accessToken(config.providerId);
        secrets.add(providerKey);
      } else if (config.providerId) {
        providerKey = await this.options.gatewayVault?.read(providerSecret(config.providerId));

        if (!providerKey) {
          throw new Error('Provider key is not configured');
        }

        secrets.add(providerKey);
      }

      if (config.apiKeyEnv) {
        const selectedEnvKey = process.env[config.apiKeyEnv];

        if (selectedEnvKey) {
          secrets.add(selectedEnvKey);
        }
      }

      // Anthropic checks that a subscription request comes from Claude Code, and the system
      // prompt is part of that check. The profile's own instructions follow it untouched.
      const subscription =
        config.provider === 'anthropic' &&
        anthropicCredential(
          config.credential,
          config.apiKeyEnv,
          providerKey ?? (config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined),
        ) === 'subscription';

      const model = await this.model(config, process.env, outbound.fetch, providerKey);
      const learning =
        (await this.services.sessions.session(profileId, run.sessionId)).channel ===
        LEARNING_SESSION_CHANNEL;
      const gitAccess = run.subagent
        ? await prepareWorkerWorkspace(run)
        : { readOnly: [], writable: [] };
      const tools: ToolSet = {
        ...profileTools(this.services, run, gitAccess),
        ...this.services.media?.tools(run, async (usage) => {
          await account(
            {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              totalTokens: usage.inputTokens + usage.outputTokens,
              inputTokenDetails: { cacheReadTokens: usage.cachedInputTokens },
              outputTokenDetails: {},
            } as LanguageModelUsage,
            usage.inputTokens,
            '',
            0,
          );
        }),
        ...this.services.web?.tools(run),
        ...this.services.stickers?.tools(run),
        compact_context: tool({
          description:
            'Request a context checkpoint before continuing a long task. The gateway summarizes older turns with the configured compaction model after this tool returns, preserving recent work and the latest request. Automatic compaction remains active.',
          inputSchema: z.object({}),
          execute: async () => {
            compactionRequested = true;
            return {
              status: 'requested',
              detail: 'Compaction will be attempted before the next model step.',
            };
          },
        }),
      };
      if (defaults?.image === 'disabled') delete tools.generate_image;
      if (defaults?.speech === 'disabled') {
        delete tools.generate_speech;
        delete tools.list_speech_voices;
      }
      if (learning) {
        for (const name of Object.keys(tools)) if (!LEARNING_TOOLS.has(name)) delete tools[name];
      }
      // Loaded within the run and never across runs: a turn states what it needs. A look back
      // has only a handful, all loaded from the start.
      const loadedTools = new Set<string>(learning ? Object.keys(tools) : []);
      const { gated } = deferTools(tools, loadedTools);
      const { mcpToolNames, selectedMcpTools, unavailable, catalog } = await connectMcpTools(
        learning ? { ...run, profile: { ...run.profile, mcpServers: [] } } : run,
        tools,
        {
          vault: this.options.vault,
          secrets,
          clients,
          fetcher: outbound.fetch,
          signal,
          ...(this.options.mcpOAuth ? { oauth: this.options.mcpOAuth } : {}),
        },
      );

      const mcpNote = [availableNote(catalog), unavailableNote(unavailable)]
        .filter(Boolean)
        .join('\n\n');

      for (const server of unavailable) {
        console.warn(`jian: MCP server ${server.name} is unavailable — ${server.reason}`);
      }

      const context = await this.services.contexts.context(run);
      const cavemanSkill = findSkill(run.profile, 'caveman');
      let currentCavemanMode: CavemanMode = cavemanSkill
        ? await cavemanMode(this.services.store.db, profileId, run.sessionId)
        : 'off';

      // One guard for every tool that acts beyond the conversation, the gateway's own and those
      // of any MCP server alike, applied once the whole set is known.
      const judge = this.services.decisions?.judge;
      const localHolds = new WeakSet<object>();

      if (judge) {
        guardTools(
          tools,
          actionGuard(judge, run, context.messages),
          (name, definition) =>
            mcpToolNames.includes(name) ? mcpActionKind(definition) : ACTION_KINDS[name],
          (result) => localHolds.add(result),
        );
      }

      const guarded: ToolSet = {};
      // Serializing tool execution prevents another effect from starting after one remote outcome is uncertain.
      let toolQueue: Promise<void> = Promise.resolve();

      for (const [name, definition] of Object.entries(tools)) {
        const execute = definition.execute;

        if (!execute) {
          guarded[name] = definition;

          continue;
        }

        guarded[name] = {
          ...definition,
          execute: async (input, options) => {
            const previous = toolQueue;
            let release: () => void = () => {};

            toolQueue = new Promise<void>((resolve) => {
              release = resolve;
            });

            await previous;

            try {
              if (externalUncertain) {
                throw new Error('External tool outcome is uncertain');
              }

              signal.throwIfAborted();
              await this.services.lifecycle.heartbeat(profileId, runId, owner);

              await this.services.lifecycle.checkpoint(profileId, runId, owner, {
                phase: 'tool-started',
                toolName: name,
                toolCallId: options.toolCallId,
                // What it was asked, for the owner's timeline; secrets are masked like results.
                input: redactOutput(input, secrets),
              });

              try {
                const output = await execute(input, options);

                // A server that answers with `isError` is reporting a failure it knows about:
                // the request reached it and it said no. That is a fact the agent can act on,
                // so it goes back as the tool's result. Only a call that never came back
                // leaves an effect nobody can account for, and that is handled below.
                if (
                  mcpToolNames.includes(name) &&
                  output &&
                  typeof output === 'object' &&
                  'isError' in output &&
                  output.isError === true
                ) {
                  await this.services.lifecycle.checkpoint(profileId, runId, owner, {
                    phase: 'tool-refused',
                    toolName: name,
                    toolCallId: options.toolCallId,
                    result: await boundToolResult(output, name, run, secrets, this.options),
                  });
                }

                const result = await boundToolResult(
                  output,
                  name,
                  run,
                  secrets,
                  this.options,
                  currentCavemanMode !== 'off',
                );

                // Read after secrets are masked: the judge sees no more than the agent will.
                return judge &&
                  outsideContent(name, mcpToolNames) &&
                  !(output && typeof output === 'object' && localHolds.has(output))
                  ? await markSteering(judge, result, signal)
                  : result;
              } catch (error) {
                // Only a tool that could change external state has an uncertain outcome when
                // it does not answer. A declared read-only MCP tool may fail without stopping
                // the turn; the agent needs its actual error to choose another way forward.
                if (mcpToolNames.includes(name) && mcpActionKind(definition)) {
                  const failure = reason(error, secrets);
                  await this.services.lifecycle
                    .checkpoint(profileId, runId, owner, {
                      phase: 'tool-uncertain',
                      toolName: name,
                      toolCallId: options.toolCallId,
                      reason: failure,
                    })
                    .catch(() => {});

                  console.error(`jian: run ${runId} tool ${name} did not come back — ${failure}`);
                  externalUncertain = true;
                  externalUncertainDetail = `${name}: ${failure}`;
                  controller.abort();

                  throw new Error('External tool outcome is uncertain');
                }

                // The agent has to be able to say what went wrong: a bare "it failed" leaves it
                // guessing, and the person then has to read the gateway log to learn anything.
                const failure = toolFailure(error, secrets);

                // And the operator sees every failure, not only the ones that end a turn.
                console.error(`jian: run ${runId} tool ${name} failed — ${failure}`);

                await this.services.lifecycle
                  .checkpoint(profileId, runId, owner, {
                    phase: 'tool-failed',
                    toolName: name,
                    toolCallId: options.toolCallId,
                    reason: failure,
                  })
                  .catch(() => {});

                throw new Error(`Tool ${name} failed: ${failure}`);
              }
            } finally {
              release();
            }
          },
        };
      }

      // The effort the owner picked next to the model, in the dialect this provider reads;
      // lowered, never raised, for a turn judged plainly light.
      const reasoning = reasoningProviderOptions(
        context.light ? lightEffort(config) : config,
        policy.outputTokens,
      );
      let preparedInputTokens = 0;
      let preparedPrompt: unknown;
      let lastMessages = context.messages as ModelMessage[];
      let currentStartIndex = context.currentStartIndex;
      const estimate = tokenCounter(config.provider, config.modelId);
      const account = async (
        usage: LanguageModelUsage,
        fallbackInput: number,
        text: string,
        steps: number,
      ) => {
        const reported = usage.inputTokens !== undefined && usage.outputTokens !== undefined;
        const inputTokens = usage.inputTokens ?? fallbackInput;
        const outputTokens = usage.outputTokens ?? Math.max(1, estimate(text));
        const cachedInputTokens = Math.min(
          inputTokens,
          usage.inputTokenDetails?.cacheReadTokens ?? 0,
        );
        await this.services.lifecycle.recordUsage(profileId, runId, owner, {
          inputTokens,
          outputTokens,
          cachedInputTokens,
          estimated: !reported,
          steps,
        });
        return { inputTokens, outputTokens, cachedInputTokens, estimated: !reported };
      };

      // Built once for the turn and held. Rebuilding it every step — the same memories, the
      // same skills, a different list of what the profile happens to be doing — changed the
      // one part of the request the provider caches, so every step paid for the whole prompt
      // again. Anything that has to reach the agent mid-turn arrives as a message instead.
      // Agents answer each other in seconds; a person takes minutes, and the short tier has
      // expired by the time they do.
      const cacheTtl: CacheTtl = run.call ? '5m' : '1h';

      const dress = (system: string) => {
        const noted = mcpNote ? `${system}\n\n${mcpNote}` : system;

        return subscription ? withClaudeCodeIdentity(noted) : noted;
      };

      const instructions = dress(context.system);
      const codingSkill = findSkill(run.profile, 'ponytail');
      const instructionsForMode = (mode: PonytailMode) =>
        !codingSkill
          ? instructions
          : mode === 'off'
            ? `${instructions}\n\nPonytail mode: off. Do not load or apply Ponytail until the owner enables it again in this conversation.`
            : `${instructions}\n\n${codingSkill.instructions}\n\nPonytail mode: ${mode}. Apply this mode only to coding tasks; the owner's explicit requirements and safety boundaries still win.`;
      const instructionsForCaveman = (system: string) =>
        cavemanSkill && currentCavemanMode !== 'off'
          ? `${system}\n\n${cavemanSkill.instructions}\n\nCaveman mode: ${currentCavemanMode}.`
          : system;
      const currentPonytailMode = codingSkill
        ? await ponytailMode(this.services.store.db, profileId, run.sessionId)
        : 'off';
      let codingInstructions = instructionsForCaveman(instructionsForMode(currentPonytailMode));

      const agent = new ToolLoopAgent({
        model,
        instructions: codingInstructions,
        tools: guarded,
        stopWhen: stepCountIs(
          learning ? Math.min(LEARNING_STEPS, policy.maxSteps) : policy.maxSteps,
        ),
        maxRetries: 0,
        maxOutputTokens: policy.outputTokens,
        ...(reasoning ? { providerOptions: reasoning } : {}),
        prepareStep: async ({ messages, stepNumber }) => {
          alive();
          if (externalUncertain) {
            throw new Error('External tool outcome is uncertain');
          }

          signal.throwIfAborted();
          await this.services.lifecycle.heartbeat(profileId, runId, owner);

          // What the person said after this run began. It arrives as their own turn, at the
          // point the loop reached, so the agent answers what they are asking now rather than
          // finishing an errand they have already moved on from.
          const steer = await this.services.lifecycle.steer(runId, owner);

          if (steer) {
            messages.push({ role: 'user', content: steer });
            if (cavemanSkill)
              currentCavemanMode = await cavemanMode(
                this.services.store.db,
                profileId,
                run.sessionId,
              );
            codingInstructions = instructionsForCaveman(
              instructionsForMode(
                codingSkill
                  ? await ponytailMode(this.services.store.db, profileId, run.sessionId)
                  : 'off',
              ),
            );
            progress.redirected();
          }

          await this.services.media?.prepare(messages, run, signal, async (usage) => {
            await account(
              {
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                totalTokens: usage.inputTokens + usage.outputTokens,
                inputTokenDetails: { cacheReadTokens: usage.cachedInputTokens },
                outputTokenDetails: {},
              } as LanguageModelUsage,
              usage.inputTokens,
              '',
              0,
            );
          });

          const activeNames = Object.keys(guarded).filter((name) =>
            mcpToolNames.includes(name)
              ? selectedMcpTools.has(name)
              : !gated.has(name) || loadedTools.has(name),
          );

          const activeTools = Object.fromEntries(
            activeNames.map((name) => [name, guarded[name]]),
          ) as ToolSet;

          const before = promptTokens({
            ...config,
            instructions: codingInstructions,
            messages,
            tools: activeTools,
          });
          // A summary cannot shrink the system instructions or tool definitions.
          if (
            promptTokens({
              ...config,
              instructions: codingInstructions,
              messages: [],
              tools: activeTools,
            }) >
            policy.inputTokens - policy.outputTokens
          ) {
            fitPrompt({
              ...config,
              policy,
              instructions: codingInstructions,
              messages,
              tools: activeTools,
            });
          }
          if (
            compactionRequested ||
            (stepNumber - lastCompactionAttempt >= 4 &&
              needsCompaction(before, policy.inputTokens - policy.outputTokens))
          ) {
            compactionRequested = false;
            lastCompactionAttempt = stepNumber;
            try {
              const session = await this.services.sessions.session(profileId, run.sessionId);
              const selection = (
                await readModelDefaults(this.services.store.db, profileId, run.createdAt)
              ).compaction;
              const chosen =
                selection && this.services.providers
                  ? await this.services.providers.selectedModel(selection, this.services.store.db)
                  : undefined;
              const summaryConfig: ModelConfig = chosen?.config ?? config;
              let summaryKey = providerKey;
              if (chosen) {
                summaryKey =
                  summaryConfig.provider === 'openai-codex' && summaryConfig.providerId
                    ? await this.options.codexLogin?.accessToken(summaryConfig.providerId)
                    : summaryConfig.providerId
                      ? await this.options.gatewayVault?.read(
                          providerSecret(summaryConfig.providerId),
                        )
                      : summaryConfig.apiKeyEnv
                        ? process.env[summaryConfig.apiKeyEnv]
                        : undefined;
                if (summaryKey) secrets.add(summaryKey);
              }
              const summarySubscription =
                summaryConfig.provider === 'anthropic' &&
                anthropicCredential(
                  summaryConfig.credential,
                  summaryConfig.apiKeyEnv,
                  summaryKey,
                ) === 'subscription';
              const compacted = await compactPrompt({
                model: chosen
                  ? await this.model(summaryConfig, process.env, outbound.fetch, summaryKey)
                  : model,
                ...summaryConfig,
                messages,
                currentStartIndex,
                previous: session.summary,
                providerOptions: reasoningProviderOptions(
                  summaryConfig,
                  Math.min(2048, (chosen?.policy ?? policy).outputTokens),
                ),
                policy: chosen?.policy ?? policy,
                signal,
                dress: summarySubscription ? withClaudeCodeIdentity : undefined,
                onUsage: async (usage, tokens, text) => {
                  await account(usage, tokens, text, 0);
                },
              });
              if (compacted) {
                const summary = redactText(compacted.summary, secrets);
                // Save the tool work before replacing the request. A later turn can resume it.
                await this.services.lifecycle.checkpoint(profileId, runId, owner, {
                  phase: 'context-compacted',
                  summary,
                  beforeTokens: before,
                  afterTokens: promptTokens({
                    ...config,
                    instructions: codingInstructions,
                    messages: compacted.messages,
                    tools: activeTools,
                  }),
                });
                await this.services.sessions.summarize(
                  profileId,
                  run.sessionId,
                  summary,
                  context.historyCursor?.createdAt,
                  context.historyCursor?.id,
                );
                messages = compacted.messages.map((message) => ({
                  ...message,
                  content:
                    typeof message.content === 'string'
                      ? redactText(message.content, secrets)
                      : message.content,
                })) as ModelMessage[];
                currentStartIndex = messages.findLastIndex((message) => message.role === 'user');
              }
            } catch (error) {
              signal.throwIfAborted();
              await this.services.lifecycle.checkpoint(profileId, runId, owner, {
                phase: 'compaction-failed',
                reason: reason(error, secrets),
              });
            }
          }

          const fitted = fitPrompt({
            provider: config.provider,
            modelId: config.modelId,
            policy,
            instructions: codingInstructions,
            messages,
            tools: activeTools,
          });

          preparedInputTokens = fitted.tokens;
          preparedPrompt = {
            estimatedTokens: fitted.tokens,
            ...fitted.breakdown,
            activeTools: activeNames,
          };
          lastMessages = fitted.messages;

          // The full prompt includes cached input. Charging its estimate again rejects
          // useful work before the provider has reported what was actually new.
          return {
            instructions:
              config.provider === 'anthropic'
                ? cacheableInstructions(fitted.instructions, cacheTtl)
                : fitted.instructions,
            // Only Anthropic needs telling: OpenAI matches a long prefix on its own.
            messages:
              config.provider === 'anthropic'
                ? cacheable(fitted.messages, cacheTtl, 3)
                : fitted.messages,
            activeTools: activeNames,
            maxOutputTokens: policy.outputTokens,
            providerOptions: withOpenAiPromptCache(
              reasoning,
              profileId,
              config.provider,
              config.modelId,
            ),
          };
        },
        onStepEnd: async ({ text, toolCalls, toolResults, finishReason, usage }) => {
          const measured = await account(
            usage,
            preparedInputTokens,
            JSON.stringify({ text, toolCalls }),
            1,
          );

          await this.services.lifecycle.checkpoint(profileId, runId, owner, {
            phase: 'step-completed',
            finishReason,
            usage: measured,
            prompt: preparedPrompt,
            tools: toolResults.map((result) => ({
              toolName: result.toolName,
              toolCallId: result.toolCallId,
              bytes: Buffer.byteLength(JSON.stringify(result.output) ?? 'null'),
              artifactId: (result.output as { artifactId?: string } | null)?.artifactId,
              result: redactOutput(result.output, secrets),
            })),
          });

          if (externalUncertain) {
            throw new Error('External tool outcome is uncertain');
          }
        },
      });

      // Streamed rather than generated so the run can say what it is doing while it does it.
      // Nothing read here is kept: the answer is `result.text`, written once, below.
      const narrator = new Narrator(async (paragraph) => {
        await this.services.lifecycle.say(profileId, runId, owner, redactText(paragraph, secrets));
      });

      const stream = await agent.stream({ messages: context.messages, abortSignal: signal });
      // A step that throws is reported on the stream, not as a rejection: without this the
      // run would fail with "no output generated" and lose the reason entirely.
      let streamError: unknown;
      // What the turn did, for looking back on it once it is over.
      const work: Array<{ id: string; name: string; error?: string }> = [];

      for await (const part of stream.fullStream) {
        alive();

        switch (part.type) {
          case 'error':
            streamError ??= part.error;
            break;
          case 'text-delta':
            // Released as it is written, not once the run is over.
            await narrator.delta(part.text).catch(() => {});
            progress.draft(narrator.draft);
            break;
          case 'reasoning-start':
            progress.thinking();
            break;
          case 'tool-call':
            progress.usingTool(part.toolName);
            work.push({ id: part.toolCallId, name: part.toolName });
            break;
          case 'tool-error': {
            const failed = work.find((item) => item.id === part.toolCallId);

            if (failed) failed.error = describe(part.error).slice(0, 300);
            break;
          }
          case 'finish-step':
            progress.stepEnded();
            // Here, in the stream's order, and not in onStepEnd: that runs as the model finishes,
            // before this loop has read the step's last words, which then ran into the next
            // step's first ones as one message.
            await narrator.endStep(part.finishReason === 'tool-calls').catch(() => {});
            progress.draft(narrator.draft);
            break;
          default:
            break;
        }
      }

      await progress.flush();

      if (streamError) {
        throw streamError;
      }

      const result = stream;

      if (externalUncertain) {
        throw new Error('External tool outcome is uncertain');
      }

      // Whatever the narrator has not already sent. The paragraphs before it are messages of
      // this conversation already, so repeating them here would show them twice.
      let answer = narrator.rest || (await result.text);
      const finishReason = await result.finishReason;

      // A loop that runs out of steps has done the work and simply never wrote it down.
      // Failing there threw the whole turn away — the person paid for the tools and got a
      // sentence pointing at a log. One more call, with no tools, turns it into an answer.
      const exhausted =
        finishReason === 'tool-calls' || (!answer.trim() && finishReason === 'length');

      // A provider can return stop with reasoning but no text. Recover only the report;
      // replaying the loop could repeat writes that already succeeded.
      if (exhausted || !answer.trim()) {
        answer = await this.closingWords(
          model,
          instructions,
          [...lastMessages, ...((await result.steps).at(-1)?.response.messages ?? [])],
          config,
          account,
          policy,
          signal,
        );
        if (!answer.trim() && exhausted) {
          answer = `Work saved in the checkpoints for run ${runId}. The turn reached its limit before a final report could be written. Resume from the saved results; do not repeat completed actions.`;
        }
      }

      if (!answer.trim()) {
        throw new Error('Agent stopped without a complete final response');
      }

      await this.services.lifecycle.finish(
        profileId,
        runId,
        owner,
        'completed',
        redactText(answer, secrets),
      );

      // Addressed only when the agent that asked gave up waiting; otherwise it already has it.
      await this.services.peers.deliverLate(profileId, runId).catch(() => {});

      if (!learning) {
        await this.services.learning
          ?.consider(run, {
            tools: work.map(({ name, error }) => ({ name, ...(error ? { error } : {}) })),
            answer,
          })
          .catch((error) =>
            console.error(`jian: run ${runId} could not be looked back on — ${describe(error)}`),
          );
      }

      await this.nameConversation(run, secrets);
    } catch (error) {
      // The stored message stays generic because a provider error can echo a key back. The
      // operator still needs the cause, so it goes to the log with the known secrets removed.
      console.error(`jian: run ${runId} failed — ${redactText(describe(error), secrets)}`);

      const current = await this.services.runs.run(profileId, runId);

      if (current.status === 'running' && current.leaseOwner === owner) {
        await this.services.lifecycle
          .finish(
            profileId,
            runId,
            owner,
            externalUncertain || signal.aborted ? 'interrupted' : 'failed',
            stalled.signal.aborted
              ? `Stopped: nothing came back from the model or a tool for ${STALLED_AFTER_MS / 60_000} minutes. Completed steps are saved; inspect them before continuing.`
              : executionFailureMessage(
                  error,
                  externalUncertain,
                  signal.aborted,
                  secrets,
                  externalUncertainDetail,
                ),
          )
          .catch(() => {});

        // A colleague waiting on this one is owed the bad news as much as the good.
        await this.services.peers.deliverLate(profileId, runId).catch(() => {});
      }
    } finally {
      clearInterval(pulse);
      clearInterval(watchdog);
      this.controllers.delete(runId);
      await Promise.allSettled(clients.map((client) => client.close()));

      if (ownsOutbound) {
        await outbound.close();
      }
    }
  }
}

/** What a provider actually answered, for the log. Never stored: a body can echo a key back. */
function describe(error: unknown): string {
  const detail = error as { name?: string; statusCode?: number; responseBody?: unknown };
  const parts = [
    error instanceof Error ? error.message : String(error),
    detail.statusCode ? `HTTP ${detail.statusCode}` : '',
    typeof detail.responseBody === 'string' ? detail.responseBody.slice(0, 500) : '',
  ];

  return parts.filter(Boolean).join(' · ');
}

/** An error and everything it was raised from, deduplicated against a cycle. */
function causes(error: unknown): Error[] {
  const chain: Error[] = [];
  let current = error;

  while (current instanceof Error && !chain.includes(current)) {
    chain.push(current);
    current = current.cause;
  }

  return chain;
}

/** One line, redacted against this run's credentials, short enough for a chat bubble. */
function reason(error: unknown, secrets: Set<string>): string {
  const text = error instanceof Error ? error.message : String(error);

  // Credentials this run did not hold can still appear in an error; their shapes are masked too.
  return redactText(text, secrets)
    .replace(CREDENTIAL_SHAPES, (match, _key, name?: string, joint?: string) =>
      name
        ? `${name}${joint}[REDACTED]`
        : /^bearer/i.test(match)
          ? 'Bearer [REDACTED]'
          : '[REDACTED]',
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function toolFailure(error: unknown, secrets: Set<string>): string {
  const fields = new Set([
    'message',
    'name',
    'error',
    'origin',
    'code',
    'format',
    'path',
    'issues',
    'details',
    'errors',
    'expected',
    'received',
    'minimum',
    'maximum',
    'validation',
  ]);
  const sanitize = (value: unknown, depth = 0): unknown => {
    if (typeof value === 'string') return reason(value, secrets).slice(0, 200);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (depth >= 4) return undefined;
    if (Array.isArray(value)) return value.slice(0, 6).map((item) => sanitize(item, depth + 1));
    if (!value || typeof value !== 'object') return undefined;

    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => fields.has(key))
        .slice(0, 12)
        .map(([key, item]) => [key, sanitize(item, depth + 1)])
        .filter(([, item]) => item !== undefined),
    );
  };
  const source = error instanceof Error ? { ...error, message: error.message } : error;
  const structured = sanitize(source);

  if (structured && typeof structured === 'object' && Object.keys(structured).length) {
    const encoded = JSON.stringify(structured);
    if (encoded.length <= 4_000) return encoded;

    const { message, origin, code, format, path, issues } = structured as Record<string, unknown>;
    const summary = { message, origin, code, format, path };
    const concise = JSON.stringify({
      ...summary,
      issues: Array.isArray(issues) ? issues.slice(0, 1) : undefined,
    });
    return concise.length <= 4_000 ? concise : JSON.stringify(summary);
  }

  return reason(error, secrets) || 'no reason given. Inspect saved steps before retrying.';
}

/**
 * The refusal itself, wherever in the chain it sits: streaming wraps what a step threw, so the
 * top error carries neither. The status says which kind of problem it is; the sentence behind
 * it names the account setting or the field to change, which is the difference between the
 * owner acting and the owner reading logs.
 */
function providerRefusal(error: unknown): { status?: number; said?: string } {
  for (const cause of causes(error)) {
    const carrier = cause as { statusCode?: unknown; data?: { error?: { message?: unknown } } };
    const status = typeof carrier.statusCode === 'number' ? carrier.statusCode : undefined;
    const said =
      typeof carrier.data?.error?.message === 'string' ? carrier.data.error.message : undefined;

    if (status || said) {
      return { status, said };
    }
  }

  return {};
}

function executionFailureMessage(
  error: unknown,
  uncertain: boolean,
  aborted: boolean,
  secrets: Set<string>,
  uncertainDetail?: string,
): string {
  if (uncertain) {
    return `External tool outcome is uncertain${uncertainDetail ? ` (${uncertainDetail})` : ''}. Inspect checkpoints and reconcile effects before continuing.`;
  }

  if (aborted) {
    return 'Execution interrupted. Inspect saved steps before continuing.';
  }

  if (
    causes(error).some(
      (cause) => cause.message === 'Agent stopped without a complete final response',
    )
  ) {
    return 'The provider ended the turn without a final response. Completed actions remain saved; inspect the checkpoints before repeating work.';
  }

  // A budget failure is the gateway's own arithmetic, so its numbers are safe to show and are
  // the only way the owner can tell which limit to raise. Streaming wraps what a step threw,
  // so the chain is walked rather than the top error read.
  const budget = causes(error).find((cause) =>
    /^(Context|Run token) budget exceeded/.test(cause.message),
  );

  if (budget) {
    return budget.message;
  }

  // Redacted, because a refusal can quote back what was sent.
  const { status, said } = providerRefusal(error);

  if (status && said) {
    return `The provider refused with ${status}: ${reason(new Error(said), secrets)}`;
  }

  switch (status) {
    case 401:
    case 403:
      return 'The provider refused the credential. Check the key or token configured for it.';
    case 429:
      return 'The provider refused for rate limiting. A subscription accepts again when its window reopens; a metered key needs quota.';
    case 404:
      return 'The provider does not know this model on this account. Choose another model.';
    case 400:
      return 'The provider refused the request. Check the model, the reasoning effort and the selected tools.';
    default: {
      // The deepest error is the one that says what went wrong; the ones around it only say
      // where. Redacted and cut to a line, it is safe to show and far more useful than a
      // pointer to a log the owner may not be able to read.
      const root = causes(error).at(-1) ?? error;
      const said = reason(root, secrets);

      return said
        ? `The run failed${status ? ` (HTTP ${status})` : ''}: ${said}`
        : 'The run failed. The reason is in the gateway log.';
    }
  }
}
