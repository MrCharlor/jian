# Deployment

The gateway runs three ways. The first uses a clone of the repository; the other two use the same published image, `ghcr.io/lucasaarch/jian-gateway`, with the database in your hands. Migrations run by themselves when the process starts: there is no separate migration step, and a new version applies what is missing as it comes up.

The image is a multi-architecture index with `linux/amd64` and `linux/arm64`, built on native runners with a provenance attestation attached. To check it before running:

```bash
gh attestation verify oci://ghcr.io/lucasaarch/jian-gateway:latest --repo lucasaarch/jian
```

## Way 1 — clone and Compose

Brings the gateway and PostgreSQL up together. This is the path for a single machine.

```bash
git clone https://github.com/lucasaarch/jian.git && cd jian
make setup
make up
```

`make setup` writes `.env` with mode `0600`, holding the host token, the database password and the encryption keyring; it never prints a secret. `make up` pulls the image, waits for the database to be healthy, and only then starts the gateway. `make logs` follows the log, `make ps` shows the state, and `make down` stops the stack without deleting the volume.

`compose.yaml` publishes the gateway on `127.0.0.1:4310`. To reach it beyond localhost, put an HTTPS proxy in front and change the address with `JIAN_BIND_ADDRESS` and `JIAN_BIND_PORT`. The PostgreSQL port is not published: only the gateway reaches it, over the Compose network.

`JIAN_VERSION` pins the image version; without it, Compose uses `latest`. To run your own build instead of the published image, uncomment the `build:` block in `compose.yaml` and use `docker compose up -d --build`.

`compose.dev.yaml` is a different thing: it brings up PostgreSQL alone, on `127.0.0.1:5432`, so `pnpm dev` can run on the machine. It has its own project name and volume, so the development database and the production one share nothing, even on the same host.

## Way 2 — the image on its own

With a PostgreSQL you already run:

```bash
docker run -d --name jian --restart unless-stopped \
  -p 127.0.0.1:4310:4310 \
  -e DATABASE_URL='postgres://user:password@db.internal:5432/jian' \
  -e JIAN_API_TOKEN="$JIAN_API_TOKEN" \
  -e JIAN_ACTIVE_KEY_ID=v1 \
  -e JIAN_MASTER_KEYS="$JIAN_MASTER_KEYS" \
  -v jian_home:/home/node \
  ghcr.io/lucasaarch/jian-gateway:latest
```

The image carries a health check against `/health`; `docker ps` shows its result. The process runs as the unprivileged `node` user, and the gateway itself writes nothing outside the database.

The image is also a workbench for that agent: Node, Python with `uv`, Go, `git`, `gh`, `ssh`, `curl`, `wget`, the text tools (`sed`, `awk`, `rg`, `jq`) and a C toolchain. The built-in `machine-tools` skill tells the agent what is there and how to add more. It installs per user and never as root — no `sudo`, no `apt` — so it works the same on a host that starts containers with `no-new-privileges`. Each profile works in its own workspace under `/home/node/workspaces`, which holds what it installs, its SSH keys and its Git and `gh` logins, confined by Landlock (see [security](security.md)); mount a volume on `/home/node` to keep them across updates. A system package it needs belongs in the image.

## Way 3 — Kubernetes

The same image, with the secrets in a `Secret` and the service internal to the cluster. Keep `replicas: 1` while a migration is pending: it runs at startup, and simultaneous replicas race for it. Once applied, more replicas are safe.

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: jian
type: Opaque
stringData:
  DATABASE_URL: postgres://jian:senha@postgres:5432/jian
  JIAN_API_TOKEN: troque-por-um-token-aleatorio-de-32-caracteres
  JIAN_ACTIVE_KEY_ID: v1
  JIAN_MASTER_KEYS: '{"v1":"troque-por-32-bytes-aleatorios-em-base64"}'
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: jian
spec:
  replicas: 1
  selector:
    matchLabels: { app: jian }
  template:
    metadata:
      labels: { app: jian }
    spec:
      containers:
        - name: gateway
          image: ghcr.io/lucasaarch/jian-gateway:0.1.0
          envFrom:
            - secretRef: { name: jian }
          env:
            - name: HOST
              value: 0.0.0.0
          ports:
            - containerPort: 4310
          readinessProbe:
            httpGet: { path: /health, port: 4310 }
            periodSeconds: 10
          livenessProbe:
            httpGet: { path: /health, port: 4310 }
            initialDelaySeconds: 30
            periodSeconds: 30
          securityContext:
            runAsNonRoot: true
            allowPrivilegeEscalation: false
            capabilities: { drop: [ALL] }
---
apiVersion: v1
kind: Service
metadata:
  name: jian
spec:
  selector: { app: jian }
  ports:
    - port: 80
      targetPort: 4310
```

Pin an exact version on the image; with `latest`, any restart changes the code without warning. Expose it through an Ingress with TLS, never the `Service` directly.

An agent with the shell switch on works in its workspace under `/home/node/workspaces`. Mount a `PersistentVolumeClaim` on `/home/node` to keep what it installs across restarts.

`JIAN_ROLE=all` runs the API and the worker in one process. To split them, use two Deployments, `api` and `worker`, sharing the same database and the same keyring; only `api` gets the `Service`.

## Environment variables

| Variable | Required | Default | What it does |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | — | The PostgreSQL connection. The process migrates the schema at startup. |
| `JIAN_API_TOKEN` | yes | — | The host token, at least 32 characters. It also signs the panel cookies. |
| `JIAN_ACTIVE_KEY_ID` | yes | — | The id of the keyring key used for new writes. |
| `JIAN_MASTER_KEYS` | yes | — | JSON mapping an id to a 32-byte key in Base64. Keep it out of the database backup. |
| `HOST` | no | `0.0.0.0` in the image | The listening address inside the container. |
| `PORT` | no | `4310` | The listening port; the health check follows it. |
| `JIAN_ROLE` | no | `all` | `all`, `api` or `worker`. |
| `JIAN_TIME_ZONE` | no | saved legacy value, then host zone | IANA zone for the agent's current time and new schedules, for example `America/Sao_Paulo`. Set the same value on API and worker replicas; it overrides but does not delete an older saved value. |
| `JIAN_ALLOW_PRIVATE_ORIGINS` | no | empty | Exact private origins allowed for outbound calls, for example `http://127.0.0.1:11434`. |
| `JIAN_CAVEMAN_ENABLED` | no | `false` | Set to `true` to route native OpenAI and Anthropic API-key model requests through Caveman. Otherwise provider calls remain direct. |
| `JIAN_CAVEMAN_PROXY_URL` | no | `http://127.0.0.1:8788` | Exact proxy origin. The default starts the bundled listener when Caveman is enabled in the image; override it for a separately managed proxy. |
| `JIAN_PUBLIC_URL` | no | — | Where the outside world reaches this gateway, over HTTPS. Telegram's webhook is registered there, rather than at whatever address the panel was opened on, and an MCP server that signs in with OAuth redirects the owner back to it; without it, that sign-in is unavailable. |
| `JIAN_WORKSPACES` | no | `$HOME/workspaces` | Where each profile's workspace is created, one directory per profile. |
| `POSTGRES_PASSWORD` | Compose only | — | The PostgreSQL password in `compose.yaml`; it also builds the service's `DATABASE_URL`. |
| `JIAN_VERSION` | Compose only | `latest` | The image tag `compose.yaml` uses. |
| `JIAN_BIND_ADDRESS` | Compose only | `127.0.0.1` | The host address the gateway port is published on. |
| `JIAN_BIND_PORT` | Compose only | `4310` | The host port the gateway is published on. |

The published image includes Caveman's local proxy but leaves it stopped by default. To start
its private, record-only listener alongside Jian, set this variable in Compose or the container:

```bash
JIAN_CAVEMAN_ENABLED=true make up
```

For source development without the image, start a separate listener instead:

```bash
CAVEMAN_MODE=record caveman start --port 8788
JIAN_CAVEMAN_ENABLED=true make dev
```

The image starts and supervises the bundled listener only when enabled with that exact loopback
URL. For any other configured origin, provide a separately managed proxy reachable from the gateway
container. Jian does not retry a failed model request directly, because a retry could duplicate
work. Keep external listeners private; `127.0.0.1` inside a container is not the host.
Only native OpenAI and Anthropic API-key requests use this route. Codex/Claude subscriptions,
custom endpoints, OpenRouter and Google continue directly. Set `JIAN_CAVEMAN_ENABLED=false` to
turn routing off. The bundled listener is forced to `record`, which preserves request bytes; Jian cannot
change the mode of a separately managed listener.

Provider, MCP and channel keys do not live in the environment: they are typed in the panel and stored encrypted with the keyring. See [security](security.md).

## Published tags

| Tag | When it is written |
| --- | --- |
| `1.2.3` | The tag `v1.2.3`. The only immutable one. |
| `1.2` | The tag `v1.2.3`; moves to the latest fix in that series. |
| `latest` | The tag `v1.2.3`; moves to the most recent published version. |

## Updating and rolling back

Updating means changing the tag and starting again. The migration runs at startup.

```bash
# Compose: pin the version in .env and recreate the container
echo 'JIAN_VERSION=1.3.0' >> .env && make up

# Standalone container
docker pull ghcr.io/lucasaarch/jian-gateway:1.3.0
docker rm -f jian && docker run -d --name jian ... ghcr.io/lucasaarch/jian-gateway:1.3.0

# Kubernetes
kubectl set image deployment/jian gateway=ghcr.io/lucasaarch/jian-gateway:1.3.0
```

Take a dump before updating: a migration changes the schema and does not undo itself.

```bash
docker compose exec postgres pg_dump -U jian -Fc jian > jian-$(date +%F).dump
```

Rolling back means pointing at the previous version — `make up` with another `JIAN_VERSION`, or `kubectl rollout undo deployment/jian`. That reverts the code, **not** the schema: a migration already applied stays in the database. If the older version refuses the newer schema, restore the dump:

```bash
docker compose exec -T postgres pg_restore -U jian -d jian --clean --if-exists < jian-2026-09-22.dump
```

Published migrations are immutable; a fix arrives as the next version, never as a change to the previous one.

## Where the data lives

Everything the gateway keeps is in PostgreSQL: profiles, sessions, history, memories, runs, the pg-boss queue and the credential vault. The one exception is each agent's workspace under `/home/node/workspaces` — the tools it installed, SSH keys, Git and `gh` logins — which Compose keeps in the named volume `jian_gateway_home`. Recreating the container loses nothing.

Under Compose the database lives in the named volume `jian_postgres_data`; the development one lives in `jian-dev_postgres_data`. `make down` keeps the volume, `docker compose down -v` deletes it. `make db-reset` deletes the development one on purpose.

The `JIAN_MASTER_KEYS` keyring lives outside the database, in `.env` or in a secret manager. Without it a database backup is useless: the vault will not open. Keep it apart, and keep the older entries until every secret has been re-entered under the new key.

## Publishing

The `Image` workflow builds on two native runners, `ubuntu-24.04` and `ubuntu-24.04-arm`, each pushing by digest, and a final job joins them into a multi-architecture index. Nothing is emulated. It runs on a `v*.*.*` tag and nowhere else.

A release is a note and a tag, both by hand:

1. Write `docs/releases/1.2.3.md`: a front matter with `date: YYYY-MM-DD`, an optional `summary:`, and the note. It becomes the GitHub release and the dialog the panel opens once after the update. The version is chosen by whoever writes the note, not computed from commits.
2. Commit the note and push `main`, then run `make release VERSION=1.2.3`. The version lives only in the tag; `package.json` stays `0.1.0`.
3. The tag runs the `Image` workflow: it checks the note, builds both architectures, and publishes the GitHub release with the note.

`make release` refuses a version with no note, a working tree with changes, a `main` that is not on `origin`, and a tag that already exists; a published version is never moved. A candidate such as `1.2.3-rc.1` publishes its own image tag and a pre-release, and leaves `latest` alone.

The notes are copied into the image, and the image carries its version in `JIAN_VERSION`. After an update the panel shows the notes of every version newer than the one the owner last read, once; closing the dialog records the version in the database, so another browser does not show it again. A first visit shows only the running release. A build with no version, such as `make dev`, announces nothing.
