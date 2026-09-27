import type { ModelConfig, ReasoningEffort } from '@jian/contracts';
import type { JSONValue } from 'ai';

/**
 * How much of the run's output allowance each effort level may spend on thinking. Anthropic
 * and Gemini take a token budget rather than a word, and that budget is drawn from the same
 * output ceiling as the answer: a fixed number would either starve the reply or exceed
 * `max_tokens` and be rejected by the provider.
 */
const share: Record<Exclude<ReasoningEffort, 'none'>, number> = {
  minimal: 0.15,
  low: 0.3,
  medium: 0.5,
  high: 0.8,
};

/** Anthropic rejects a thinking budget below 1024, and it must stay under `max_tokens`. */
const minimumBudget = 1024;

function budget(effort: ReasoningEffort, maxOutputTokens: number): number | null {
  if (effort === 'none') return 0;

  const ceiling = maxOutputTokens - 256;

  if (ceiling < minimumBudget) return null;

  return Math.min(ceiling, Math.max(minimumBudget, Math.floor(maxOutputTokens * share[effort])));
}

/**
 * From Claude 4.6 the model decides how long to think and a request carrying a token budget is
 * refused outright. The version is read from the id because no listing reports it: a one or
 * two digit part after the major is the minor, and a longer one is a release date.
 */
export function takesAdaptiveThinking(modelId: string): boolean {
  const match = /claude-(?:opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(modelId);

  if (!match) {
    return false;
  }

  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);

  return major > 4 || (major === 4 && minor >= 6);
}

/**
 * The effort for a turn judged light: `low` in place of anything above it, never higher than
 * the owner's pick and never switched off — a model the owner set to think still thinks, and
 * `low` is a level every provider that offers `medium` or `high` also offers.
 */
export function lightEffort(config: ModelConfig): ModelConfig {
  return config.reasoningEffort === 'medium' || config.reasoningEffort === 'high'
    ? { ...config, reasoningEffort: 'low' }
    : config;
}

/**
 * Translates the stored effort into each provider's own dialect. Returns undefined when there
 * is nothing to say, so a model without reasoning is called exactly as before.
 */
export function reasoningProviderOptions(
  config: ModelConfig,
  maxOutputTokens: number,
): Record<string, Record<string, JSONValue>> | undefined {
  const effort = config.reasoningEffort;

  if (!effort) return undefined;

  switch (config.provider) {
    case 'openai':
    case 'openai-codex':
      return { openai: { reasoningEffort: effort } };
    case 'anthropic': {
      if (takesAdaptiveThinking(config.modelId)) {
        // The level no longer sets a depth on these models; only whether to think at all.
        return {
          anthropic: { thinking: effort === 'none' ? { type: 'disabled' } : { type: 'adaptive' } },
        };
      }

      const tokens = budget(effort, maxOutputTokens);

      if (tokens === null) return undefined;

      return {
        anthropic: {
          thinking: tokens === 0 ? { type: 'disabled' } : { type: 'enabled', budgetTokens: tokens },
        },
      };
    }
    case 'google': {
      const tokens = budget(effort, maxOutputTokens);

      if (tokens === null) return undefined;

      return { google: { thinkingConfig: { thinkingBudget: tokens, includeThoughts: false } } };
    }
    default:
      // A compatible endpoint is whatever the owner pointed it at; guessing its dialect would
      // turn a supported model into a rejected request.
      return undefined;
  }
}
