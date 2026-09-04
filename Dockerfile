# syntax=docker/dockerfile:1.7
#
# claude-telegram-agent
# ---------------------
# Telegram <-> Claude Code (Agent SDK) köprüsü. Repo, SDK'lar ve Claude oturumları
# /data volume'unda tutulur; imaj dil SDK'sı içermez (bootstrap-env skill'i kurar).
#
# Build:  docker build -t claude-telegram-agent .
# Run  :  ./up.sh   (bkz. README)

############################
# 1) Bot'u derle
############################
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

############################
# 2) Runtime
############################
FROM node:22-bookworm

ARG GH_VERSION=latest
ARG GLAB_VERSION=latest
ARG AGENT_UID=1000

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    NODE_ENV=production \
    DATA_DIR=/data \
    REPO_DIR=/data/repo \
    SDK_HOME=/data/sdks \
    AGENT_HOME=/home/agent \
    HOME=/home/agent

# Temel araçlar: git, curl, jq, sudo, build-essential (native modüller / SDK kurulumları için),
# python3 (pek çok SDK scripti ister), ripgrep (Claude Code Grep aracı), unzip/xz (SDK tarball'ları).
# SDK'ların kendisi imajda YOK: /sdks/<isim>/<sürüm> altına volume olarak bağlanır (scripts/sdk-*.sh).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git git-lfs jq sudo openssh-client gnupg \
      build-essential pkg-config python3 python3-pip python3-venv \
      ripgrep fd-find unzip zip xz-utils tar bzip2 file less procps \
      libglu1-mesa libgtk-3-0 clang cmake ninja-build \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI (gh) — resmi apt deposu (amd64 + arm64)
RUN mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && if [ "$GH_VERSION" = "latest" ]; then apt-get install -y --no-install-recommends gh; else apt-get install -y --no-install-recommends "gh=${GH_VERSION}"; fi \
    && rm -rf /var/lib/apt/lists/*

# GitLab CLI (glab) — release tarball (amd64 + arm64)
RUN set -eux; \
    ARCH="$(dpkg --print-architecture)"; \
    if [ "$GLAB_VERSION" = "latest" ]; then \
      GLAB_TAG="$(curl -fsSL 'https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/releases/permalink/latest' | jq -r .tag_name)"; \
    else \
      GLAB_TAG="v${GLAB_VERSION#v}"; \
    fi; \
    GLAB_VER="${GLAB_TAG#v}"; \
    curl -fsSL "https://gitlab.com/gitlab-org/cli/-/releases/${GLAB_TAG}/downloads/glab_${GLAB_VER}_linux_${ARCH}.tar.gz" -o /tmp/glab.tgz; \
    tar -xzf /tmp/glab.tgz -C /tmp; \
    install -m 0755 /tmp/bin/glab /usr/local/bin/glab; \
    rm -rf /tmp/glab.tgz /tmp/bin; \
    glab --version

# Ajan kullanıcısı: root DEĞİL (Claude Code root'ta bypassPermissions'ı reddeder).
# SDK kurulumları için sudo NOPASSWD verilir (izole container varsayımı).
RUN set -eux; \
    if id -u node >/dev/null 2>&1; then userdel -r node || true; fi; \
    groupadd -g "${AGENT_UID}" agent; \
    useradd -m -u "${AGENT_UID}" -g agent -s /bin/bash agent; \
    echo "agent ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/agent; \
    chmod 0440 /etc/sudoers.d/agent; \
    mkdir -p /data /app /sdks; \
    chown -R agent:agent /data /app /sdks /home/agent

WORKDIR /app
COPY --from=build --chown=agent:agent /app/node_modules ./node_modules
COPY --from=build --chown=agent:agent /app/dist ./dist
COPY --chown=agent:agent package.json ./
COPY --chown=agent:agent agent-config ./agent-config
COPY --chown=agent:agent scripts ./scripts
COPY --chown=agent:agent docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh ./scripts/*.sh && ln -s /app/scripts/sdk-install.sh /usr/local/bin/sdk-install && ln -s /app/scripts/sdk-env.sh /usr/local/bin/sdk-env && ln -s /app/scripts/sdk-detect.sh /usr/local/bin/sdk-detect

USER agent
VOLUME ["/data"]

# Bash araçları (Claude'un Bash tool'u dahil) her açılışta SDK ortamını yükler.
ENV BASH_ENV=/data/sdks/env.sh \
    PATH=/data/sdks/bin:/home/agent/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

HEALTHCHECK --interval=60s --timeout=10s --start-period=120s --retries=3 \
  CMD test -f /data/.healthy || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "/app/dist/index.js"]
