import type { PrototypePrintsStatus } from '@jian/contracts';
import { prototypePrintsInputSchema } from '@jian/contracts';
import { eq } from 'drizzle-orm';
import type { GatewayVault } from '../security/gateway-vault.js';
import type { Store } from '../storage/database.js';
import { gatewaySecrets } from '../storage/schema.js';

/** Where the repository token lives in the gateway vault. */
const SECRET = 'github:prototype-prints';
const API = 'https://api.github.com';
const TIMEOUT_MS = 30_000;

export type PrintFile = { name: string; content: string };

/** A file name GitHub and a shell both take as is; the extension is kept. */
export function printFileName(name: string) {
  return name.replace(/[^\w.-]+/g, '-').replace(/^[-.]+/, '') || 'print';
}

/**
 * The private GitHub repository the prints of a cloud drawing travel through. The cloud session
 * cannot reach this gateway (its egress and its safety filter both refuse), but it opens a
 * repository as its source, so the prints are already files on its disk when it starts.
 */
export class PrintsRepository {
  private repository: string | undefined;

  constructor(
    private readonly store: Store,
    private readonly vault: GatewayVault,
    private readonly fetcher: typeof fetch,
  ) {}

  /** `owner/name`, from configuration: which repository is not typed in the panel. */
  useRepository(repository: string | undefined) {
    this.repository = repository;
  }

  /** The address the cloud routine clones, or nothing when prints cannot travel. */
  async source(): Promise<string | undefined> {
    if (!this.repository || !(await this.vault.read(SECRET))) return undefined;

    return `https://github.com/${this.repository}`;
  }

  async status(): Promise<PrototypePrintsStatus> {
    const [row] = await this.store.db
      .select({ updatedAt: gatewaySecrets.updatedAt })
      .from(gatewaySecrets)
      .where(eq(gatewaySecrets.name, SECRET))
      .limit(1);

    return {
      ...(this.repository ? { repository: this.repository } : {}),
      configured: this.repository !== undefined && row !== undefined,
      ...(row ? { updatedAt: row.updatedAt.toISOString() } : {}),
    };
  }

  async configure(input: unknown): Promise<PrototypePrintsStatus> {
    const { token } = prototypePrintsInputSchema.parse(input);

    await this.vault.put(SECRET, token.trim());

    return this.status();
  }

  async remove(): Promise<PrototypePrintsStatus> {
    await this.vault.discard(SECRET);

    return this.status();
  }

  /**
   * Writes the prints under `folder/` and answers their paths in the repository, or nothing when
   * there is no repository or token. A file already there (a retried version) is replaced.
   */
  async push(folder: string, prints: PrintFile[], signal?: AbortSignal) {
    const token = this.repository ? await this.vault.read(SECRET) : undefined;

    if (!this.repository || !token || prints.length === 0) return undefined;

    const paths: string[] = [];

    for (const print of prints) {
      const path = `${folder}/${printFileName(print.name)}`;
      const url = `${API}/repos/${this.repository}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
      const headers = {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      };
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const existing = await this.fetcher(url, { headers, signal: abort });
      const sha = existing.ok ? ((await existing.json()) as { sha?: string }).sha : undefined;
      const response = await this.fetcher(url, {
        method: 'PUT',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: `prints: ${path}`,
          content: print.content,
          ...(sha ? { sha } : {}),
        }),
        signal: abort,
      });

      if (!response.ok) {
        throw new Error(`GitHub answered ${response.status} writing ${path}`);
      }

      paths.push(path);
    }

    return paths;
  }
}
