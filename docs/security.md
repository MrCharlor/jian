# Security and operation

## Trust boundary

An installation belongs to one trusted owner. `JIAN_API_TOKEN` is the only API credential and it opens the whole installation: keep it on the host and hand it only to devices you trust. There are no reduced-permission client keys — whoever holds the token can do everything. Every session of a profile shares the same access to that profile's data and tools. Do not connect audiences with different permissions to the same profile.

Each operation in the contract is `admin`, `public` or `webhook`. Only `/health` and the exchange of the token for a panel cookie answer without authentication; a webhook authenticates the token of its own channel binding, which is random, carries 256 bits of entropy and is stored as a SHA-256 hash. Everything else needs the host token, or the panel cookie signed with it.

Provider keys, MCP tokens and channel tokens are typed where the thing itself is configured, encrypted, and never returned by any read.

Profiles speak to each other by exchanging text, and only text: discovery shows a name and the summary the owner wrote, the answer is the output of the callee's run, and no tool reads another profile's memory, credential, session or history. Text arriving from another agent is untrusted data like any other input — the caller's name is addressing, not authority. A chain of calls is bounded by a depth budget that travels with it and by never calling the same profile twice in one conversation; without that, agents answer each other in a loop and every round spends a provider key.

Vendor credentials belong to the installation rather than to a profile, and live in a vault of their own. Deleting a profile takes its own secrets with it and leaves the shared credentials alone.

A profile with the shell switch on works in a workspace of its own, `/home/node/workspaces/<profile id>` in the image (`JIAN_WORKSPACES` moves the parent). It is the profile's `HOME` and `TMPDIR`, so its repositories, SSH keys and Git and `gh` logins are its own.

Each command runs under `jian-sandbox`, a small helper built into the image that confines it with [Landlock](https://docs.kernel.org/userspace-api/landlock.html) before it starts: it may write only in its workspace, read only its workspace and the system's directories (`/usr`, `/etc`, `/opt`, `/proc`, `/sys` and the libraries), and nothing else — not another profile's workspace, not the gateway's files. Landlock also refuses it the private files of any process outside the sandbox, so `/proc/<gateway>/environ` stays closed, and on Linux 6.12 and later it cannot signal those processes or reach their abstract Unix sockets. Landlock needs no privilege, no capability and no user namespace, so it works in a container with `no-new-privileges` and the runtime's default seccomp profile, on Kubernetes and on a PaaS. It is the kernel's restriction: the command and everything it starts inherit it and cannot lift it.

The file tools, `send_file` and `save_attachment` run inside the gateway, so the same line is checked there: the path with its links resolved, and for a file actually opened, the path of the open descriptor.

A command does not inherit the gateway's environment either: it starts with `PATH`, the locale and its workspace paths, never `DATABASE_URL`, `JIAN_MASTER_KEYS`, `JIAN_API_TOKEN` or a provider key. That keeps a project's tests and scripts from reaching the gateway's database by accident, and keeps the secrets out even where Landlock is missing.

What this does not cover: the network is not restricted, so a command reaches any address the container reaches (the database without its password, for one). On a kernel without Landlock (before 5.13, or with it left out of the LSM list) commands run unconfined, and the gateway logs a warning at the first one; each profile still has its own directory and the file tools still enforce it. Give the shell only to profiles whose every sender you trust.

## Encryption and rotation

`JIAN_MASTER_KEYS` is a JSON object mapping identifiers to 32-byte keys in Base64. `JIAN_ACTIVE_KEY_ID` chooses the key used for new writes. Setup creates a keyring in `.env` with mode `0600`; when hosting, inject it through a secret manager. Do not put that keyring in the database, in Git, or in the same backup as the database.

AES-256-GCM uses a random nonce per write. The associated data binds each ciphertext to its owner — `provider:<id>`, `mcp:<name>`, `channel:<id>` — so an envelope moved between records or between profiles fails to decrypt. That protects against a leak of the database alone; a compromised worker process can also reach the keys in memory.

To rotate:

1. Generate another random 32-byte key and add it to the keyring under a new id.
2. Distribute the whole keyring to every API and worker, then change the active id.
3. Re-enter each secret on the screen that configures it: a provider encrypts the new key under the active id, and the same holds for an MCP server token or a channel token.
4. Only then remove the old key from the keyring. Older backups still depend on it.

Re-entering a key in the vault does not change the key at the provider. To change the external key, type the new one on the Providers screen: the gateway revokes the previous provider and discards its secret. Queued runs carry the older configuration; cancel them if the change is urgent.

The host token lives in the environment, apart from the database. Change it on the host and restart the API and the workers; changing it also invalidates the panel session cookies, which are signed with it. Never send secrets in URL parameters; use HTTPS and keep client tokens in the operating system's own vault.

## Network and limits

A Claude subscription credential is accepted only from a caller Anthropic recognises, and the recognition covers more than the credential: the client name and version, the `x-app` header, the first system block, and the names of the tools offered. A tool named `mcp_<something>` reads as a third-party app and the whole request is refused with 400, so MCP tools are exposed as `mcp__<something>`.

Providers and MCP servers share the same outbound transport. It requires public HTTPS, validates and pins DNS resolution at connect time, and blocks redirects, embedded credentials and private destinations. `JIAN_ALLOW_PRIVATE_ORIGINS` allows exact origins for internal services the owner runs, for example `http://127.0.0.1:11434`. Metadata and link-local addresses stay forbidden.

The API caps a body at 256 KiB, rate limits by connecting address and bounds streams. It does not trust `X-Forwarded-For` on its own; behind a proxy every client may share one limit. Configure further limits at the proxy to match the deployment. Separate instances keep their own HTTP counters; run limits and resource leases live in the database.

Unknown inputs are refused by the admin contracts. Logs carry no bodies, no authentication headers and no provider exceptions. Memories, messages and artifacts are user data and stay as text in the database: encrypting credentials is not encrypting the conversations. Restrict access to the database and to its backups.

Skills and tool results are untrusted instructions and data. Choosing which MCP tools an agent may load reduces capability; it does not remove prompt injection. Give a profile only the tools it can really exercise, and use external credentials with the least privilege that works.

A profile can also be given the machine: reading files, writing files and running commands, with the privileges of whoever started the gateway. There is no sandbox around it, it is off by default, and it reaches as far as an approved contact on a chat channel can ask the agent to go. Turn it on only for a profile whose channels you control. In the published image that is the unprivileged `node` user, with no `sudo`; what bounds it is the container, which mounts no Docker socket and no host path. Mounting either hands the agent the host.

A profile can be allowed to search the web. Searches go to the installation's Tavily key, set once under **Providers** and stored in the gateway vault like any other credential; reading a page goes through the same outbound guard as every other call, one redirect at a time, so a public page cannot send the gateway to an address inside its network. Off by default. Everything a search or a page returns was written by strangers and can try to steer the agent: it arrives as data, and a profile that can also run commands should be the one whose output you watch.

## Failures and outside effects

An expired lease interrupts a run; it does not restart tools on its own. Continuing needs explicit reconciliation, creates another run and preserves the earlier checkpoints. It does not offer exactly-once execution of outside effects.

Resource leases coordinate sessions of the same profile and hand out an increasing fence number. An external resource is protected from a stale holder only if it validates that number too; a lease does not intercept every MCP call on its own.

A remote call that never came back leaves an effect nobody can account for: the run stops, no further tool starts, and the owner reconciles before continuing. A server that answers and reports a failure is a different thing — it says what happened, so the agent is told and carries on.

A delivery with no confirmation is recorded as `unknown` and is never resent on its own. An abandoned send is marked uncertain after ten minutes. Check the destination before resending by hand. Cancelling a run does not undo what already happened.

## Reporting a vulnerability

Do not publish credentials, or proofs carrying private data, in an issue. Before making the project public, set up a private contact channel and the repository's private reporting feature. Use synthetic data in a reproduction.

## WhatsApp devices

Pairing by QR grants access to the account. Connecting, reading the state and reading the QR all need the host token; the QR is encrypted in the database, expires, and is served with `Cache-Control: no-store`. Session backups are encrypted and isolated per profile and channel. A callback from an older generation or ownership cannot rewrite credentials after a disconnect or a revocation.

The session in the clear exists only in the worker's memory; nothing is written to disk. The worker opens a WebSocket straight to WhatsApp: apply your outbound controls to it as well. The integration is not an official Meta API.
