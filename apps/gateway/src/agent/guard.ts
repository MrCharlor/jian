import type { ActionPolicy, Run } from '@jian/contracts';
import type { ToolSet } from 'ai';
import { type Approvals, levelOf, proposeOnly } from '../approvals/service.js';
import { type Judge, noul, type Question } from '../decisions/service.js';

/** Returns why an action is held back, or nothing when it may run. */
export type Guard = (tool: string, input: unknown, kind: ActionKind) => Promise<string | undefined>;

/**
 * Where an action lands, which decides what can go wrong with it: a change on the machine, a
 * change in an outside service the owner connected, or words and files reaching someone else.
 */
export type ActionKind = 'machine' | 'service' | 'message';

/**
 * Above this probability a risk counts. Set low on purpose: a held action costs the owner one
 * sentence asking for it explicitly, a wrong one can cost data nobody can bring back.
 */
const RISK_THRESHOLD = 0.7;
/** Below this probability the request is not taken as having asked for the action itself. */
const ASKED_THRESHOLD = 0.5;
const MAX_REQUEST_CHARS = 4000;
const MAX_FIELD_CHARS = 2000;

const WHERE: Record<ActionKind, string> = {
  machine: 'a command or file change on the machine the agent runs on',
  service: 'a call to an outside service the owner connected to the agent',
  message: 'a message, file or question sent to another person, conversation or agent',
};

/** Long contents are judged by their start: the target already says most of the risk. */
function bounded(input: unknown): unknown {
  if (typeof input === 'string') {
    return input.length > MAX_FIELD_CHARS ? `${input.slice(0, MAX_FIELD_CHARS)}…` : input;
  }

  if (Array.isArray(input)) {
    return input.map(bounded);
  }

  if (input && typeof input === 'object') {
    return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, bounded(value)]));
  }

  return input;
}

type Risk = { kinds: ActionKind[]; reason: string; question: Question };

/**
 * One risk per question, so each is judged on its own and the reason can say which one fired.
 * A message is irreversible by nature and destroys nothing, so only exposure is asked of it.
 */
const RISKS: Record<string, Risk> = {
  destroys: {
    kinds: ['machine', 'service'],
    reason: 'deletes or overwrites existing data',
    question: {
      type: 'noul',
      instructions:
        'Does `action` delete, overwrite, empty or discard data, records or content that already exist?',
      criteria: {
        true: 'Something that exists now would be gone or replaced after the action.',
        false: 'The action only reads, or adds something new without replacing anything.',
      },
    },
  },
  irreversible: {
    kinds: ['machine', 'service'],
    reason: 'would be hard to undo',
    question: {
      type: 'noul',
      instructions:
        'Once `action` is carried out, would it be hard or impossible to undo — such as a deletion, a payment, a publication, a change of permissions or settings, or something sent to other people?',
      criteria: {
        true: 'Undoing it would need a backup, another party, or would not be possible at all.',
        false: 'It only reads, or can be reverted simply by running the opposite action.',
      },
    },
  },
  exposes: {
    kinds: ['machine', 'service', 'message'],
    reason: 'sends secrets or private information to someone who has no need for it',
    question: {
      type: 'noul',
      instructions:
        'Does `action` send passwords, keys, tokens or private information about the owner or other people to a person, service or place that has no need for it?',
      criteria: {
        true: 'Credentials or private details leave for a recipient that should not have them.',
        false: 'Nothing secret or private goes out, or it goes only where it plainly belongs.',
      },
    },
  },
};

const ASKED: Question = {
  type: 'noul',
  instructions:
    'Does the latest `request`, read with the recent `conversation`, authorize exactly this action — this operation, on these targets, to these recipients? A short confirmation may approve an explicit proposal immediately before it; an older request alone does not authorize a new action.',
  criteria: {
    true: 'The latest request asks for this very action, either directly or by confirming the specific preceding proposal.',
    false:
      'Only an older message asks for it, or the latest request leaves this action to the agent’s choice.',
  },
};

/**
 * A second opinion before the agent changes the machine, changes something in a service it is
 * connected to, or sends something to someone: does the action destroy, resist undoing or
 * expose, and did the request ask for exactly that? It is a check, not containment — the judge
 * reads the same request an attacker could have written, and an outage lets the action
 * through, the way it ran before the judge existed.
 *
 * Two steps, for cost: the risks are judged on the action alone, which is short and repeats,
 * so a repeat is answered from the cache. Most actions carry no risk, and only when one does
 * is the request — the long part — sent to ask whether it asked for exactly that. The decision
 * is the same as asking everything at once: the risk questions never read the request.
 */
export function actionGuard(
  judge: Judge,
  run: Pick<Run, 'input'>,
  conversation: ReadonlyArray<{ role: string; content: string }> = [],
): Guard {
  return async (tool, input, kind) => {
    const risks = Object.entries(RISKS).filter(([, risk]) => risk.kinds.includes(kind));
    const action = { where: WHERE[kind], tool, input: bounded(input) };
    const judged = await judge(
      { action },
      Object.fromEntries(risks.map(([id, risk]) => [id, risk.question])),
      { use: 'actions', timeoutMs: 5000 },
    );

    if (!judged) {
      return undefined;
    }

    const fired = risks
      .filter(([id]) => (noul(judged[id]) ?? 0) >= RISK_THRESHOLD)
      .map(([, risk]) => risk.reason);

    if (fired.length === 0) {
      return undefined;
    }

    const answers = await judge(
      {
        request: run.input.slice(-MAX_REQUEST_CHARS),
        action,
        // A short confirmation only makes sense beside the exchange it confirms. Never pass
        // tool results or another session's messages as authority.
        conversation: conversation
          .filter((message) => message.role === 'user' || message.role === 'assistant')
          .slice(-6)
          .map((message) => ({
            role: message.role,
            content: message.content.slice(-MAX_FIELD_CHARS),
          })),
      },
      { asked: ASKED },
      { use: 'actions', timeoutMs: 5000 },
    );

    // Unreachable now, the service decides nothing, as when the first step fails.
    if (!answers) {
      return undefined;
    }

    // Without an answer on the request, a risk alone holds: the cheap mistake is asking.
    const asked = noul(answers.asked) ?? 0;

    return asked < ASKED_THRESHOLD
      ? `Held back: this action ${fired.join(', and ')}, and the request did not ask for exactly that. Tell whoever asked what it would do, and run it only after the owner asks for exactly that in this conversation.`
      : undefined;
  };
}

/**
 * The owner's own answer on how far the agent goes: it is asked before any judge. Level 3 lets
 * the call through to the judge; level 1 holds it with no request, the owner acts instead;
 * level 2 records a request, or spends the approval the owner already gave for this very call.
 *
 * `actionOf` names the call the way the owner configured it — the tool's own name, or
 * `server.tool` for a connected server — so the level survives the hashed name the model sees.
 */
export function policyGuard(
  policy: ActionPolicy,
  approvals: Pick<Approvals, 'gate'>,
  run: Pick<Run, 'id' | 'profileId' | 'sessionId'>,
  actionOf: (tool: string) => string,
  onRequest?: (number: number) => void,
): Guard {
  return async (tool, input, kind) => {
    const action = actionOf(tool);
    const level = levelOf(policy, action, kind);

    if (level === 3) return undefined;
    if (level === 1) return proposeOnly(action);

    const summary = `${action} ${JSON.stringify(bounded(input))}`;
    const gate = await approvals.gate(run, { tool, action, input, summary });

    if (gate.proceed) return undefined;

    onRequest?.(gate.approval.number);

    return gate.held;
  };
}

/** The first guard that holds decides; the next is asked only when the one before let it pass. */
export function composeGuards(...guards: Array<Guard | undefined>): Guard {
  return async (tool, input, kind) => {
    for (const guard of guards) {
      const held = await guard?.(tool, input, kind);

      if (held) return held;
    }

    return undefined;
  };
}

/**
 * Puts the guard in front of the tools it classifies. A tool with no kind runs untouched; a
 * held one returns `{ held }` as its result, so the agent reads why and nothing ran.
 */
export function guardTools(
  tools: ToolSet,
  guard: Guard,
  kindOf: (name: string, tool: ToolSet[string]) => ActionKind | undefined,
  onHeld?: (result: object) => void,
): void {
  for (const [name, original] of Object.entries(tools)) {
    const kind = kindOf(name, original);
    const execute = original.execute;

    if (!kind || !execute) {
      continue;
    }

    tools[name] = {
      ...original,
      execute: async (input, options) => {
        const held = await guard(name, input, kind);

        if (held) {
          const result = { held };
          onHeld?.(result);
          return result;
        }

        return execute(input, options);
      },
    };
  }
}

/** The gateway's own tools that act outside the conversation, by where they land. */
export const ACTION_KINDS: Partial<Record<string, ActionKind>> = {
  run_command: 'machine',
  write_file: 'machine',
  edit_file: 'machine',
  send_file: 'message',
  send_session_message: 'message',
  message_contact: 'message',
  ask_agent: 'message',
};

/**
 * An MCP tool acts on a service the owner connected, whatever that service is. One that its
 * server declares read-only is not judged: it changes nothing, and asking would slow every
 * lookup. The declaration is the server's word, and the server is one the owner chose.
 */
export function mcpActionKind(tool: unknown): ActionKind | undefined {
  const annotations = (tool as { metadata?: { annotations?: { readOnlyHint?: unknown } } })
    ?.metadata?.annotations;

  return annotations?.readOnlyHint === true ? undefined : 'service';
}
