# Getting started

Everything here assumes a running gateway. See the [README](../README.md) to start one.

## Local development

Node.js 24+ and pnpm 11.9.0, pinned in `packageManager`.

```bash
make install
make setup
make check
```

`make` alone lists every target.

`make setup` creates `.env` with mode `0600`, an admin token, a local database password
and a master encryption key. On an existing setup it only appends a missing keyring. It
never prints a secret.

`compose.dev.yaml` holds PostgreSQL alone, published on `127.0.0.1:5432`; the gateway runs
on the host. `make db-up` starts it and `make db-stop` stops it without deleting the
volume. `make db-reset` throws the data away and starts an empty one.

It is a separate database from the production stack in `compose.yaml`, with its own project
name and its own volume. If you had the development database before this split, its data is
still in the `jian_postgres_data` volume, which now belongs to production; the development
volume is `jian-dev_postgres_data` and starts empty. [Deploying](deploy.md) covers the
production side.

PostgreSQL applies `POSTGRES_PASSWORD` only when it initialises an empty volume. If you
recreate `.env` afterwards, the gateway fails with `28P01`. Sync the two in one line:

```bash
printf "ALTER USER jian WITH PASSWORD '%s';\n" "$POSTGRES_PASSWORD" | docker exec -i jian-dev-postgres-1 psql -U jian -d jian
```

With PostgreSQL already available, set `DATABASE_URL` and run `make dev`; it does not
start a database for you. Lint, typecheck, build and unit tests need no Docker at all.

`JIAN_ROLE=all` runs the API and the worker in one process. `api` and `worker` split them,
and both halves must share the database and the keyring.

Set `JIAN_TIME_ZONE` to an IANA zone such as `America/Sao_Paulo` for the time agents read and
the default zone of new schedules. Restart the gateway after changing it. An explicit
`JIAN_TIME_ZONE` takes precedence over a time zone saved by an older panel; leaving it unset
preserves that saved value, then falls back to the host zone. Existing schedules retain their
own zones.

## The web panel

`pnpm build` compiles the panel with Next.js `output: 'export'` and copies it into
`apps/gateway/dist/ui`; there is no Next.js server in production. `pnpm start` then serves
it at `http://localhost:4310/ui/`. Sign in with the server's `JIAN_API_TOKEN`.

The panel trades that token for a signed cookie, so a reload keeps the session. Provider
keys go to the gateway's encrypted vault, never to browser storage.

While developing the panel, use `http://localhost:3000/ui/`, which reloads on edit and
forwards `/v1` to the gateway. Port 4310 serves the copy from the last `pnpm build`.

## First profile

Every administrative call needs `Authorization: Bearer <JIAN_API_TOKEN>`, including
`GET /openapi.json`. A copy without secrets lives in
[`packages/contracts/openapi.json`](../packages/contracts/openapi.json).

1. Create a profile with `POST /v1/profiles`, passing `name` and `instructions`.
2. Configure `ANTHROPIC_API_KEY` or `ANTHROPIC_API_TOKEN`, `GEMINI_API_TOKEN`, or
   `OPENAI_API_KEY` in the gateway environment, or enter a key on the Providers screen.
   OpenAI also accepts a ChatGPT/Codex login there. No provider registration or model
   allowlist is required.
3. Read what that account can call with
   `GET /v1/profiles/{profileId}/providers/{providerId}/models`, then pick a model per
   role with `PUT /v1/profiles/{profileId}/model-defaults`. `conversation` is what a run
   falls back to; the gateway never picks a model on its own.
4. Create a session and post to
   `POST /v1/profiles/{profileId}/sessions/{sessionId}/messages` with `text` and a
   `requestKey` per message, optionally overriding `model`.

The host token is the only API credential and it opens the whole installation. Keep it on
the host and on devices you trust; there are no scoped client keys.

The Providers screen has fixed Anthropic, Gemini and OpenAI settings. It detects
`ANTHROPIC_API_KEY`, `ANTHROPIC_API_TOKEN`, `GEMINI_API_TOKEN` and `OPENAI_API_KEY`
from the gateway environment without exposing their values. OpenAI also supports
ChatGPT/Codex device-code login. Existing profile records with `model`, `apiKeyEnv` or
`openai-compatible` remain compatible. The context policy still bounds history and memory.

Which models a connection offers comes from the provider: the gateway calls
`/v1/models` (OpenAI), `/v1/models` (Anthropic) and `/v1beta/models` (Gemini) with the
stored key, through the same guarded outbound client as every other provider call,
and caches each answer for a minute. A provider that does not answer is reported with
`stale: true` alongside the last list it did return — the saved providers and model
defaults are never touched, and no list is ever substituted from this repository.

What each model can do is not in those answers. Context window, output ceiling, accepted
reasoning efforts and input modalities come from the versioned table in
`apps/gateway/src/providers/capabilities.ts`, matched by model family prefix. A model the
table does not know stays selectable with `known: false` and conservative limits (8192
input, 4096 output, text only, no reasoning effort), and the panel labels it.
ChatGPT/Codex publishes no model index, so its model id is typed by hand.

Repeating a `requestKey` with the same text returns the existing run; different content
returns `409`. A profile allows up to 32 active or queued runs, one per session, and each
worker process executes four at a time.

A secret is typed where the thing that uses it is configured: the provider key on the
Providers screen, the MCP token with its server, the bot token with its channel. The
gateway encrypts it per profile and never returns it; replacing it means sending another,
and removing it means removing the thing that owns it.

## Using the SDK

```bash
pnpm contracts:generate   # after changing packages/contracts
pnpm contracts:check      # fails when a generated file is stale
```

```typescript
import { createJianClient } from '@jian/sdk';

const client = createJianClient({ baseUrl, token });
const { data, error } = await client.GET('/v1/profiles/{profileId}', {
  params: { path: { profileId } },
});
```

The generator package pins TypeScript 5.9, because the compiler API `openapi-typescript`
needs does not exist in the native TypeScript 7 compiler the gateway uses.

`/v1/profiles/{profileId}/events/stream` streams run events, not individual tokens.
Reconnect with `Last-Event-ID`. Slow clients are throttled and disconnected.

## Memory, tools and identity

`identity` separates role, tone, goals and boundaries from the general instructions.
Changes carry an `expectedVersion`, and each run pins one version. `allowSelfManagement`
lets an agent edit its name, instructions and skills and derive new profiles **without
inherited provider access**; it can never grant itself new permissions.

Memories carry a key, content, origin and version, and only the agent writes them: the
API lists them and removes one, it does not create or edit. Context retrieval picks
candidates from a text index and injects only relevant matches within the budget, while
the full history stays in the database and is read page by page. This is lexical search:
embeddings are not implemented. Conversation summaries use the selected compaction model automatically or when the agent calls `compact_context`.

For new provider connections, the selected model determines the per-call context window,
output reservation, memory and tool-result limits. Conversation history continues through
session checkpoints rather than a fixed message count. Legacy profiles retain `contextPolicy` until
they use a registered model. Recognised OpenAI models use a local tokenizer; everything else falls back
to a conservative one token per UTF-8 byte, and the provider's own reported usage is
recorded separately. Jian does not impose a cumulative token cap per run; use provider
spending caps for cost control.

Skills advertise short descriptions and load their instructions through `load_skill`. MCP
runs over HTTP with an explicit allowlist of tools. A remote catalogue is discovered on
connection and searched with `search_mcp_tools`; schemas reach the prompt only after
`load_mcp_tools`. Large results become paginated artifacts, capped at 1 MB per result.
MCP over stdio, MCP OAuth and arbitrary code execution are out of scope for now.

## Verification

`pnpm check` runs Biome, typecheck, unit tests, build and the contract drift check. Husky
and lint-staged guard staged files before every commit. CI additionally provisions a
disposable PostgreSQL 17, runs the persistence tests and builds the Docker image.

```bash
TEST_DATABASE_URL='postgres://jian:password@localhost:5432/jian_test' pnpm test:integration
```

The unit suite uses in-memory storage, synthetic models and a local HTTP MCP. Validation
against a real database, Docker or a real provider depends on your environment.
