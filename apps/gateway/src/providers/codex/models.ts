import { z } from 'zod';
import { accountHeaders } from './model.js';

/**
 * The account's own catalog, which is the only place a ChatGPT login learns what it may call.
 *
 * `client_version` is read as a Codex CLI version and decides what the backend will show: it
 * hides anything whose minimum version is newer, and the request is refused outright without
 * it. Keep this at a Codex version known to list the current account models; 0.0.0 omits newer
 * models even when the same account sees them in the Codex CLI.
 */
const CATALOG = 'https://chatgpt.com/backend-api/codex/models?client_version=0.156.0';
const effort = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

const catalog = z.object({
  models: z
    .array(
      z.looseObject({
        slug: z.string().min(1),
        display_name: z.string().optional().catch(undefined),
        visibility: z.string().optional().catch(undefined),
        priority: z.number().optional().catch(undefined),
        supported_reasoning_levels: z
          .array(z.looseObject({ effort: z.string() }))
          .optional()
          .catch(undefined),
      }),
    )
    .optional(),
});

export type CodexModel = {
  id: string;
  displayName?: string;
  reasoningEfforts?: Array<z.infer<typeof effort>>;
};

export async function listCodexModels(
  accessToken: string,
  fetcher: typeof globalThis.fetch,
): Promise<CodexModel[]> {
  const headers = accountHeaders(accessToken);

  // Without the account header the backend answers 200 with an empty catalog, which would read
  // as "this account has no models" instead of as a request that was never properly addressed.
  if (!headers['ChatGPT-Account-ID']) {
    throw new Error('The ChatGPT token does not identify the account; sign in again.');
  }

  const response = await fetcher(CATALOG, {
    headers: { accept: 'application/json', authorization: `Bearer ${accessToken}`, ...headers },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    // The body can echo the token back; only the status is safe to surface.
    throw new Error(`ChatGPT answered ${response.status} when listing models.`);
  }

  const parsed = catalog.parse(await response.json());

  return (parsed.models ?? [])
    .filter((model) => !['hide', 'hidden'].includes(model.visibility ?? ''))
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || a.slug.localeCompare(b.slug))
    .map((model) => ({
      id: model.slug,
      ...(model.display_name ? { displayName: model.display_name } : {}),
      ...(model.supported_reasoning_levels
        ? {
            reasoningEfforts: model.supported_reasoning_levels.flatMap((level) => {
              const parsed = effort.safeParse(level.effort);
              return parsed.success ? [parsed.data] : [];
            }),
          }
        : {}),
    }))
    .slice(0, 200);
}
