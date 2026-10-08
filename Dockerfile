FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
# Git's default SSH and agent-supplied GIT_SSH_COMMAND both resolve this wrapper through PATH.
COPY apps/gateway/ssh.sh /usr/local/bin/ssh
RUN chmod 755 /usr/local/bin/ssh
# The Git hooks are not installed in an image, and pnpm must not prune devDependencies
# before the build runs.
ENV HUSKY=0 CI=true
# Manifests and the lockfile come first so the dependency layer is reused on every commit
# that only changes source.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY .husky/install.mjs .husky/install.mjs
COPY apps/gateway/package.json apps/gateway/package.json
COPY apps/gateway-ui/package.json apps/gateway-ui/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/sdk/package.json packages/sdk/package.json
RUN pnpm install --frozen-lockfile
COPY apps/gateway apps/gateway
COPY apps/gateway-ui apps/gateway-ui
COPY packages packages
# The release notes ride in the build, so the panel can say what changed in this version.
COPY docs/releases docs/releases
# `deploy` writes a self-contained tree: the gateway's compiled output, the panel exported
# into it, and production dependencies with the workspace links resolved to real files.
RUN pnpm build && pnpm --filter @jian/gateway --prod deploy --legacy /runtime

FROM node:24-bookworm-slim
# The workbench an agent with the shell switch on reaches for: version control, the network,
# text, builds and the common runtimes. ffmpeg is the gateway's own, for converting speech.
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ffmpeg ca-certificates gnupg \
      git openssh-client curl wget rsync \
      chromium \
      jq ripgrep fd-find gawk sed grep diffutils patch file tree less nano vim-tiny \
      zip unzip xz-utils bzip2 zstd \
      procps psmisc lsof iproute2 iputils-ping dnsutils netcat-openbsd \
      build-essential pkg-config \
      python3 python3-pip python3-venv python3-dev \
      sqlite3 postgresql-client \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && install -d -m 0755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*
# Go from its own tarball, checked against the digest go.dev publishes for each architecture.
ARG GO_VERSION=1.27.1
ARG TARGETARCH
RUN case "${TARGETARCH}" in \
      amd64) sum=63d339f0da5ab53635a56f2490a7984dfe12dfcff22ad749f63edaf590168445 ;; \
      arm64) sum=3450b45a3f9ee8568792736a5c5e70a1f2e9b36c35a8f74958c03e51d7d92bec ;; \
      *) echo "No Go digest for ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${TARGETARCH}.tar.gz" -o /tmp/go.tgz \
 && echo "${sum}  /tmp/go.tgz" | sha256sum -c - \
 && tar -C /usr/local -xzf /tmp/go.tgz && rm /tmp/go.tgz
# Only the local proxy enters the image. Pin each release asset by its published SHA-256;
# a replaced asset fails the build rather than changing the gateway's provider path.
RUN case "${TARGETARCH}" in \
      amd64) sum=3b67a9e2d77e1aaa3f655e66ef0133d7c29aea13aebac878267d2d810044e1ce ;; \
      arm64) sum=447c05b8a45d9623ae645e33083fd342278eb5a2b6d197931c76666c5f85bcb7 ;; \
      *) echo "No Caveman proxy digest for ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && curl -fsSL "https://github.com/JuliusBrussee/caveman/releases/download/bin-v1.1.7/caveman-proxy_linux_${TARGETARCH}" \
      -o /usr/local/bin/caveman-proxy \
 && echo "${sum}  /usr/local/bin/caveman-proxy" | sha256sum -c - \
 && chmod 755 /usr/local/bin/caveman-proxy
COPY --from=ghcr.io/astral-sh/uv:0.12.18 /uv /uvx /usr/local/bin/
RUN corepack enable
# The helper that confines each agent command to its profile's workspace with Landlock. It is
# built here, where the C toolchain already is, so it matches this image's libc and architecture.
COPY apps/gateway/native/jian-sandbox.c /tmp/jian-sandbox.c
RUN gcc -O2 -Wall -Wextra -Werror -o /usr/local/bin/jian-sandbox /tmp/jian-sandbox.c \
 && rm /tmp/jian-sandbox.c
# The agent installs as the `node` user and never as root: hosts such as Cubeship start the
# container with no-new-privileges, so a sudo that works here would fail there. Everything it
# installs lands under /home/node, which compose keeps on a volume, so it survives a new image.
# JIAN_TOOLBOX tells the agent's skill which machine it is on.
ENV GOPATH=/home/node/go \
    NPM_CONFIG_PREFIX=/home/node/.local \
    PATH=/home/node/.local/bin:/home/node/go/bin:/usr/local/go/bin:$PATH \
    PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/chromium \
    JIAN_TOOLBOX=1
ARG JIAN_VERSION=0.0.0-dev
ARG JIAN_REVISION=unknown
# Standard annotations: GHCR links the package to the repository through `source`, and the
# other two say which commit produced the bits. CI overrides them with the same values.
LABEL org.opencontainers.image.title="Jian Gateway" \
      org.opencontainers.image.description="Self-hosted agent gateway" \
      org.opencontainers.image.source="https://github.com/MrCharlor/jian" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${JIAN_VERSION}" \
      org.opencontainers.image.revision="${JIAN_REVISION}"
# The version the panel announces the notes of; CI stamps it from the tag.
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4310 JIAN_VERSION=${JIAN_VERSION}
WORKDIR /app
# Only the deployed tree crosses over: no sources, no toolchain, no pnpm store.
COPY --from=build --chown=node:node /runtime ./
COPY THIRD_PARTY_NOTICES.md /usr/share/doc/jian/THIRD_PARTY_NOTICES.md
COPY --chown=node:node apps/gateway/entrypoint.sh /app/entrypoint.sh
USER node
EXPOSE 4310
# Node ships fetch, so the check installs nothing. It honours PORT because the container
# may be started on another one.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4310)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["bash", "/app/entrypoint.sh"]
