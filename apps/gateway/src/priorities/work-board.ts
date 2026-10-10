import { mcpValueSecret, type SecretReader } from '../agent/mcp-connect.js';
import { GatewayError } from '../core/errors.js';
import type { Profiles } from '../profiles/service.js';

export type BoardCard = {
  id: string;
  title: string;
  version: number;
  /** The board the card lives on; another board means it is a mirror here. */
  boardId: string;
};

export type MoveInput = {
  statusId: string;
  /** The card that ends up right above it; none at the top. The board checks both are adjacent. */
  aboveId?: string;
  /** The card that ends up right below it; none at the bottom. */
  belowId?: string;
};

/** One board of the work tracker, read and reordered through its REST API. */
export type WorkBoard = {
  column(statusId: string): Promise<BoardCard[]>;
  move(card: BoardCard, input: MoveInput): Promise<BoardCard>;
};

export type BoardAddress = { workspaceId: string; boardId: string; server?: string };

export type BoardOpener = (profileId: string, address: BoardAddress) => Promise<WorkBoard>;

type ActivityJson = {
  id: string;
  title: string;
  version: number;
  board_id: string;
};

const card = (item: ActivityJson): BoardCard => ({
  id: item.id,
  title: item.title,
  version: item.version,
  boardId: item.board_id,
});

/**
 * Opens a board with the key the agent already uses on the tracker's MCP server: the server's
 * Authorization header, kept in the profile's vault. The REST API lives on the same origin.
 */
export function workBoardOpener(
  profiles: Pick<Profiles, 'profile'>,
  vault: SecretReader,
  fetcher: typeof fetch,
  env: NodeJS.ProcessEnv = process.env,
): BoardOpener {
  return async (profileId, address) => {
    const profile = await profiles.profile(profileId);
    const server = profile.mcpServers.find((item) =>
      address.server
        ? item.name === address.server
        : item.transport === 'http' && item.url?.includes('/v1/mcp'),
    );

    if (!server?.url) {
      throw new GatewayError(409, 'No connected server reaches the board');
    }

    const header = server.headers.find((item) => item.name.toLowerCase() === 'authorization');
    const key = header
      ? header.fromEnv
        ? env[header.fromEnv]?.trim()
        : await vault.read(profileId, mcpValueSecret(server.name, 'header', header.name))
      : undefined;

    if (!key) {
      throw new GatewayError(409, `${server.name} has no Authorization header to reach the board`);
    }

    const base = `${new URL(server.url).origin}/v1/workspaces/${address.workspaceId}`;
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await fetcher(`${base}${path}`, {
        method,
        headers: {
          Authorization: key.startsWith('Bearer ') ? key : `Bearer ${key}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
      const text = await response.text();

      if (!response.ok) {
        throw new GatewayError(502, `The board answered ${response.status}: ${text.slice(0, 300)}`);
      }

      return text ? JSON.parse(text) : undefined;
    };

    return {
      async column(statusId) {
        const cards: BoardCard[] = [];
        let cursor = '';

        do {
          const page = (await call(
            'GET',
            `/boards/${address.boardId}/activities/column?status_id=${statusId}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          )) as { items: ActivityJson[]; next_cursor?: string | null };

          cards.push(...page.items.map(card));
          cursor = page.next_cursor ?? '';
        } while (cursor && cards.length < 500);

        return cards;
      },

      async move(target, input) {
        const mirror = target.boardId !== address.boardId;
        const moved = (await call(
          'POST',
          mirror
            ? `/activities/${target.id}/boards/${address.boardId}/move`
            : `/activities/${target.id}/move`,
          {
            status_id: input.statusId,
            expected_version: target.version,
            before_activity_id: input.aboveId ?? null,
            after_activity_id: input.belowId ?? null,
          },
        )) as ActivityJson;

        return { ...card(moved), boardId: target.boardId };
      },
    };
  };
}
