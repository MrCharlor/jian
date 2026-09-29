import { describe, expect, it } from 'vitest';
import { listCodexModels } from '../src/providers/codex/models.js';

/** A token whose payload carries the account claim the backend addresses the request by. */
function token(account?: string) {
  const payload = Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': account ? { chatgpt_account_id: account } : {},
    }),
  ).toString('base64url');

  return `header.${payload}.signature`;
}

const catalog = {
  models: [
    { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', priority: 1 },
    { slug: 'gpt-6-sol', display_name: 'GPT-6-Sol', priority: 2 },
    { slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', priority: 3 },
    { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', priority: 4 },
    { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6-Terra', priority: 7 },
    { slug: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna', priority: 8 },
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', priority: 12 },
    { slug: 'internal-preview', visibility: 'hidden', priority: 0 },
  ],
};

describe('the models a ChatGPT login may call', () => {
  it('asks the account catalog and keeps what is visible, best first', async () => {
    const asked: Array<{ url: string; headers: Headers }> = [];

    const models = await listCodexModels(token('acct-1'), (async (url, init) => {
      asked.push({ url: String(url), headers: new Headers(init?.headers) });

      return Response.json(catalog);
    }) as typeof globalThis.fetch);

    expect(models).toEqual([
      { id: 'gpt-6-astra', displayName: 'GPT-6-Astra' },
      { id: 'gpt-6-sol', displayName: 'GPT-6-Sol' },
      { id: 'gpt-6-luna', displayName: 'GPT-6-Luna' },
      { id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol' },
      { id: 'gpt-5.6-terra', displayName: 'GPT-5.6-Terra' },
      { id: 'gpt-5.6-luna', displayName: 'GPT-5.6-Luna' },
      { id: 'gpt-5.5', displayName: 'GPT-5.5' },
    ]);

    // Without the version the backend refuses, and without the account it answers empty.
    expect(asked[0]?.url).toContain('client_version=0.155.0');
    expect(asked[0]?.headers.get('chatgpt-account-id')).toBe('acct-1');
    expect(asked[0]?.headers.get('authorization')).toBe(`Bearer ${token('acct-1')}`);
  });

  it('refuses a token with no account instead of reporting an empty catalog', async () => {
    await expect(
      listCodexModels(token(), (async () => Response.json({ models: [] })) as typeof fetch),
    ).rejects.toThrow('does not identify the account');
  });

  it('surfaces the status and never the body, which can echo the token', async () => {
    await expect(
      listCodexModels(token('acct-1'), (async () =>
        Response.json({ error: token('acct-1') }, { status: 403 })) as typeof fetch),
    ).rejects.toThrow('answered 403');
  });
});
