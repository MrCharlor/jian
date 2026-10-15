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

/** The tracker's REST API for one workspace, as the agent's key reaches it. */
export type WorkClient = {
  call(method: string, path: string, body?: unknown): Promise<unknown>;
  /**
   * One tool of the tracker's MCP server, for what its REST API refuses an API key (the
   * workspace's people, 15/10/2026). Answers the tool's text read as JSON when it is JSON.
   */
  tool?(name: string, args: Record<string, unknown>): Promise<unknown>;
};

export type WorkClientOpener = (
  profileId: string,
  address: { workspaceId: string; server?: string },
) => Promise<WorkClient>;

/**
 * Opens the tracker with the key the agent already uses on its MCP server: the server's
 * Authorization header, kept in the profile's vault. The REST API lives on the same origin.
 */
export function workClientOpener(
  profiles: Pick<Profiles, 'profile'>,
  vault: SecretReader,
  fetcher: typeof fetch,
  env: NodeJS.ProcessEnv = process.env,
): WorkClientOpener {
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

    const origin = new URL(server.url).origin;
    const base = `${origin}/v1/workspaces/${address.workspaceId}`;

    return {
      async call(method, path, body) {
        // A path of the whole API ("/v1/me") is read from the origin; every other is the workspace's.
        const response = await fetcher(`${path.startsWith('/v1/') ? origin : base}${path}`, {
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
          throw new GatewayError(
            502,
            `The board answered ${response.status}: ${text.slice(0, 300)}`,
          );
        }

        return text ? JSON.parse(text) : undefined;
      },
      async tool(name, args) {
        // The server answers one call with no session opened first.
        const response = await fetcher(server.url as string, {
          method: 'POST',
          headers: {
            Authorization: key.startsWith('Bearer ') ? key : `Bearer ${key}`,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name, arguments: args },
          }),
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
        });
        const text = await response.text();

        if (!response.ok) {
          throw new GatewayError(
            502,
            `The board answered ${response.status}: ${text.slice(0, 300)}`,
          );
        }

        // A streamed answer carries the JSON on its data line.
        const json = text.trimStart().startsWith('{')
          ? text
          : (text
              .split('\n')
              .find((line) => line.startsWith('data:'))
              ?.slice(5) ?? '');
        const reply = JSON.parse(json) as {
          result?: { isError?: boolean; content?: Array<{ type: string; text?: string }> };
          error?: { message?: string };
        };
        const said = reply.result?.content?.find((part) => part.type === 'text')?.text ?? '';

        if (reply.error || reply.result?.isError) {
          throw new GatewayError(502, `The board refused ${name}: ${reply.error?.message ?? said}`);
        }

        try {
          return JSON.parse(said);
        } catch {
          return said;
        }
      },
    };
  };
}

/** A board of the tracker, on top of the workspace client. */
export function workBoardOpener(open: WorkClientOpener): BoardOpener {
  return async (profileId, address) => {
    const client = await open(profileId, address);
    const call = (method: string, path: string, body?: unknown) => client.call(method, path, body);

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
