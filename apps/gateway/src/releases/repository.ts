import type { Repository } from '@jian/contracts';

export const REPOSITORY_URL = 'https://github.com/MrCharlor/jian';

const API_URL = 'https://api.github.com/repos/MrCharlor/jian';

/** GitHub allows sixty unauthenticated reads an hour per address; one an hour is plenty. */
const FRESH_MS = 60 * 60_000;
/** A failed read is asked again sooner, but not on every page load. */
const RETRY_MS = 10 * 60_000;
const TIMEOUT_MS = 5_000;

/**
 * Where Jian lives and how many stars it has. Read by the gateway rather than the browser,
 * because the panel may only reach its own origin. An installation that cannot reach GitHub
 * still gets the link, without a count.
 */
export class RepositoryStars {
  private cached?: { value: Repository; until: number };

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly clock: () => number = Date.now,
  ) {}

  async read(): Promise<Repository> {
    const now = this.clock();

    if (this.cached && this.cached.until > now) return this.cached.value;

    const stars = await this.fetcher(API_URL, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'jian-gateway' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
      .then(async (response) =>
        response.ok ? ((await response.json()) as { stargazers_count?: unknown }) : undefined,
      )
      .then((body) =>
        typeof body?.stargazers_count === 'number' ? body.stargazers_count : undefined,
      )
      .catch(() => undefined);

    // A count read before stays shown through a failed refresh rather than disappearing.
    const known = stars ?? this.cached?.value.stars;
    const value = { url: REPOSITORY_URL, ...(known === undefined ? {} : { stars: known }) };

    this.cached = { value, until: now + (stars === undefined ? RETRY_MS : FRESH_MS) };

    return value;
  }
}
