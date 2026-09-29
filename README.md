![Jian — self-hosted agent gateway.](apps/gateway-ui/public/brand/readme-banner.png)

# Jian

Jian is a self-hosted gateway that gives AI agents a persistent identity. A profile keeps
its own instructions, model, memory and tools, and every session and channel that belongs
to it works from that same context — so a conversation started on WhatsApp continues in
the web panel without repeating anything.

It runs on your own server. Provider keys stay in an encrypted vault on your machine, not
in a vendor's account.

Jian takes its name from the one-winged bird. Its new mark makes that wing a single,
forward-moving shape: an agent with its own identity, connected to the person who owns it.

## What it does

- **Profiles as identity.** Versioned role, tone, goals and boundaries, with their own
  model, context budget, skills and MCP servers.
- **Memory that survives the session.** Explicit memories, paginated history search, and
  messages passed between parallel sessions.
- **A context budget you control.** Per-step and per-run limits, relevant memories only,
  tool schemas loaded on demand instead of flooding the prompt.
- **Channels.** WhatsApp, Telegram and an API server, one of each. A stranger's first
  message becomes a contact request the owner approves; each approved conversation gets
  its own session, so no channel inherits the owner's privileges.
- **A vault, not a config file.** Provider, MCP and channel secrets are typed where the
  thing is configured and stored encrypted with AES-256-GCM, never read back.
- **A typed contract.** OpenAPI 3.1 generated from the schemas the server validates
  against, with a TypeScript SDK generated from the same document.
- **A web panel** for profiles, usage, memories, skills, MCP servers and channels.

Isolation is per profile. One installation serves one trusted owner; it is not a
multi-tenant SaaS.

## Clients

The web panel ships inside the gateway and talks to it through the same contract any
other client would use.

## Repository

```text
apps/gateway/       HTTP API, runtime and workers
apps/gateway-ui/    Web panel, exported into the gateway
packages/contracts/ Zod schemas — the source of the HTTP contract
packages/sdk/       Generated TypeScript client
docs/               Architecture, security, channels, panel
```

## Hosting it

Docker, and a clone of this repository. `make up` starts the published gateway image with
its own PostgreSQL, on `127.0.0.1:4310`.

```bash
make setup
make up
```

The same image runs in a plain container against your own PostgreSQL, or in Kubernetes.
[Deploying](docs/deploy.md) has the exact command for each, the environment variables, and
how to move between versions.

## Developing it

Node.js 24+, pnpm 11.9.0 and Docker for the local database. `make` alone lists the targets.

```bash
make install
make setup
make db-up
make dev
```

`make setup` writes a `.env` with local credentials and an encryption key, and never
prints a secret. `make dev` serves the API on `127.0.0.1:4310` and the panel with hot
reload on `http://localhost:3000/ui/`.

[Getting started](docs/getting-started.md) walks through creating the first profile and
sending the first message. See also [architecture](docs/architecture.md),
[deploying](docs/deploy.md), [security](docs/security.md), [channels](docs/channels.md)
and [the web panel](docs/gateway-ui.md).

## Status

Early. The contract, the vault and the runtime are in place; the native client currently
signs in and lists profiles. Interfaces may still change.

Apache 2.0 — see [LICENSE](LICENSE) and [CONTRIBUTING.md](CONTRIBUTING.md).
