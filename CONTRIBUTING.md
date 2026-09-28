# Contributing to Jian

Thank you for contributing to Jian. Please keep changes focused, evidence-based, and consistent with the architecture and security model.

## Prerequisites

- Node.js 24 or newer.
- pnpm 11.9.0, as pinned by the repository.
- Docker for the local PostgreSQL database and integration checks.

Install dependencies with:

```bash
make install
```

For a local environment, run `make setup`, then `make db-up` and `make dev`. The setup command writes local credentials without printing secrets.

## Where code goes

- Products live in `apps`; shared libraries live in `packages`.
- HTTP contracts live in `packages/contracts`. Change the Zod schemas, then run `pnpm contracts:generate`.
- Generated files have their own drift check. Never edit generated files by hand.
- Published migrations are immutable. A later change gets a new migration.

## Style and language

English is used in source documentation, user-facing text, examples, fixtures, and pull requests. Biome enforces two spaces, single quotes, semicolons, and 100 columns. Husky and lint-staged check staged files before each commit.

Prefer descriptive names, one responsibility per function, and named functions over deeply nested expressions. Comments should explain decisions, guarantees, units, trust boundaries, or traps; they should not narrate obvious operations.

Use synthetic credentials in tests and examples. Never commit secrets, tokens, private data, or production configuration.

## Tests and checks

Cover behavior that matters: authorization, isolation, persistence, concurrency, delivery, and failures with external effects. Do not write tests that mirror implementation details, count internal calls, inflate coverage, or check formatting alone.

Before opening a pull request, run the checks relevant to your change. For a complete local check, run:

```bash
pnpm check
```

Unit tests need neither Docker nor a provider. Persistence tests need a disposable PostgreSQL database and `TEST_DATABASE_URL`.

If a check cannot be run locally, state that clearly in the pull request and explain why.

## Pull requests

1. Create a focused branch from `main`.
2. Explain the problem, the resulting behavior, and the validation performed.
3. Include tests and documentation when the behavior requires them.
4. Review the complete diff for unrelated files, generated artifacts, and sensitive data.
5. Keep commits descriptive and limited to the change.

Maintainers may request changes, additional evidence, or a narrower scope before merging. Do not open a public issue for a suspected security vulnerability; follow [SECURITY.md](SECURITY.md) instead.

## Questions and support

Use GitHub Discussions for questions and general support. Use the issue templates for reproducible bugs and feature proposals. For conduct concerns, follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
