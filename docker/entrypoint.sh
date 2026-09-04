#!/usr/bin/env bash
# Container açılış scripti:
#  1) zorunlu env kontrolü
#  2) ajanın kendine has git kimliği + credential store
#  3) ~/.claude -> /data/claude (oturumlar kalıcı), CLAUDE.md + skills kopyala
#  4) repo clone / fetch
#  5) SDK ortam dosyası (BASH_ENV) hazırla
set -euo pipefail

log() { printf '[entrypoint] %s\n' "$*" >&2; }
die() { log "HATA: $*"; exit 1; }

: "${DATA_DIR:=/data}"
: "${REPO_DIR:=${DATA_DIR}/repo}"
: "${SDK_HOME:=${DATA_DIR}/sdks}"
: "${AGENT_HOME:=${HOME:-/home/agent}}"
: "${AGENT_CONFIG_DIR:=/app/agent-config}"
: "${SCRIPTS_DIR:=/app/scripts}"
CLAUDE_DIR="${DATA_DIR}/claude"

# ---------- 1) Zorunlu env ----------
[[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]] || die "CLAUDE_CODE_OAUTH_TOKEN boş. Kendi makinende 'claude setup-token' çalıştırıp çıktıyı ver."
[[ -n "${TELEGRAM_BOT_TOKEN:-}" ]]     || die "TELEGRAM_BOT_TOKEN boş (@BotFather)."
[[ -n "${REPO_URL:-}" ]]               || die "REPO_URL boş (https://github.com/owner/repo.git)."
[[ -n "${REPO_TOKEN:-}" ]]             || die "REPO_TOKEN boş (GitHub fine-grained PAT veya GitLab project token)."
[[ "${REPO_URL}" == https://* ]]       || die "REPO_URL https:// ile başlamalı (ssh desteklenmiyor; token ile https kullan)."

# URL içinde gömülü kimlik varsa temizle (https://user:pass@host/...)
CLEAN_URL="$(printf '%s' "$REPO_URL" | sed -E 's#^https://[^@/]+@#https://#')"
REPO_HOST="$(printf '%s' "$CLEAN_URL" | sed -E 's#^https://([^/]+)/.*#\1#')"
REPO_PATH="$(printf '%s' "$CLEAN_URL" | sed -E 's#^https://[^/]+/##; s#\.git$##')"

# Sağlayıcı: env ile verilmemişse host'tan tahmin et
if [[ -z "${GIT_PROVIDER:-}" ]]; then
  case "$REPO_HOST" in
    *github*) GIT_PROVIDER=github ;;
    *gitlab*) GIT_PROVIDER=gitlab ;;
    *) die "GIT_PROVIDER tahmin edilemedi (host: $REPO_HOST). GIT_PROVIDER=github|gitlab ver." ;;
  esac
fi
export GIT_PROVIDER REPO_HOST REPO_PATH REPO_URL="$CLEAN_URL"
log "Sağlayıcı: $GIT_PROVIDER  host: $REPO_HOST  repo: $REPO_PATH"

mkdir -p "$DATA_DIR" "$SDK_HOME" "$SDK_HOME/bin" "$CLAUDE_DIR" "$DATA_DIR/agent-notes"

# ---------- 2) Ajanın git kimliği ----------
: "${GIT_USER_NAME:=Claude Agent}"
: "${GIT_USER_EMAIL:=claude-agent@noreply.local}"
export GIT_USER_NAME GIT_USER_EMAIL

git config --global user.name  "$GIT_USER_NAME"
git config --global user.email "$GIT_USER_EMAIL"
git config --global init.defaultBranch main
git config --global pull.rebase false
git config --global push.autoSetupRemote true
git config --global advice.detachedHead false
git config --global --add safe.directory "$REPO_DIR"
git config --global --add safe.directory '*'

# Credential helper: salt-okunur, yalnızca bu host için. Token 0600 dosyada durur,
# remote URL'e gömülmez; geçici bir auth hatası (store helper'ın aksine) token'ı silmez.
case "$GIT_PROVIDER" in
  github) CRED_USER="x-access-token" ;;
  gitlab) CRED_USER="oauth2" ;;
esac
CRED_FILE="$AGENT_HOME/.git-token"
umask 077
printf '%s\n' "$REPO_TOKEN" > "$CRED_FILE"
mkdir -p "$AGENT_HOME/bin"
cat > "$AGENT_HOME/bin/git-credential-agent" <<EOF
#!/usr/bin/env bash
# git credential helper: sadece 'get' cevaplar; store/erase yok sayılır.
[[ "\$1" == get ]] || exit 0
host=""; while IFS= read -r line; do [[ "\$line" == host=* ]] && host="\${line#host=}"; done
[[ "\$host" == "${REPO_HOST}" ]] || exit 0
printf 'username=%s\npassword=%s\n' "${CRED_USER}" "\$(cat "${CRED_FILE}")"
EOF
chmod 0700 "$AGENT_HOME/bin/git-credential-agent"
umask 022
git config --global credential.helper "$AGENT_HOME/bin/git-credential-agent"
git config --global "credential.https://${REPO_HOST}.username" "$CRED_USER"

# gh / glab kimliği (env üzerinden; disk'e yazmaz)
if [[ "$GIT_PROVIDER" == github ]]; then
  export GH_TOKEN="$REPO_TOKEN" GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1
  [[ "$REPO_HOST" == "github.com" ]] || export GH_HOST="$REPO_HOST"
  gh auth status >/dev/null 2>&1 && log "gh: kimlik doğrulandı" || log "UYARI: gh auth status başarısız (token kapsamını kontrol et)"
else
  export GITLAB_TOKEN="$REPO_TOKEN" GITLAB_HOST="$REPO_HOST" NO_PROMPT=1 GLAB_CHECK_UPDATE=0
  glab auth status >/dev/null 2>&1 && log "glab: kimlik doğrulandı" || log "UYARI: glab auth status başarısız (token kapsamını kontrol et)"
fi

# ---------- 3) Claude dizini (kalıcı) + ajan konfigürasyonu ----------
if [[ ! -L "$AGENT_HOME/.claude" ]]; then
  rm -rf "$AGENT_HOME/.claude"
  ln -s "$CLAUDE_DIR" "$AGENT_HOME/.claude"
fi
# CLAUDE.md ve skills her açılışta imajdaki sürümle güncellenir (oturumlar korunur)
mkdir -p "$CLAUDE_DIR/skills"
cp -f ${AGENT_CONFIG_DIR}/CLAUDE.md "$CLAUDE_DIR/CLAUDE.md"
rm -rf "$CLAUDE_DIR/skills"/*
cp -r ${AGENT_CONFIG_DIR}/skills/. "$CLAUDE_DIR/skills/"
# İlk açılış onboarding'ini atla
if [[ ! -f "$AGENT_HOME/.claude.json" ]]; then
  printf '{"hasCompletedOnboarding":true,"theme":"dark"}\n' > "$AGENT_HOME/.claude.json"
fi

# ---------- 4) Repo ----------
if [[ -d "$REPO_DIR/.git" ]]; then
  log "Repo mevcut, remote güncelleniyor…"
  git -C "$REPO_DIR" remote set-url origin "$CLEAN_URL"
  git -C "$REPO_DIR" fetch --prune origin || log "UYARI: fetch başarısız (ağ?), mevcut kopya ile devam"
else
  log "Repo klonlanıyor: $CLEAN_URL"
  git clone "$CLEAN_URL" "$REPO_DIR"
fi
DEFAULT_BRANCH="$(git -C "$REPO_DIR" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)"
if [[ -z "$DEFAULT_BRANCH" ]]; then
  git -C "$REPO_DIR" remote set-head origin -a >/dev/null 2>&1 || true
  DEFAULT_BRANCH="$(git -C "$REPO_DIR" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)"
fi
if [[ -z "$DEFAULT_BRANCH" ]]; then
  DEFAULT_BRANCH="$(git -C "$REPO_DIR" symbolic-ref --short HEAD 2>/dev/null || true)"
fi
[[ -n "$DEFAULT_BRANCH" && "$DEFAULT_BRANCH" != HEAD ]] || DEFAULT_BRANCH=main
export DEFAULT_BRANCH
log "Varsayılan dal: $DEFAULT_BRANCH"

# Ajanın not defteri repo içinde ama git dışı: .agent/ (global excludes ile)
mkdir -p "$REPO_DIR/.agent"
EXCLUDE_FILE="$REPO_DIR/.git/info/exclude"
grep -qx '.agent/' "$EXCLUDE_FILE" 2>/dev/null || echo '.agent/' >> "$EXCLUDE_FILE"

# ---------- 5) SDK ortamı ----------
# /sdks/<isim>/<sürüm> (paylaşımlı volume'lar) + $SDK_HOME/<isim>/<sürüm> (container'a özel)
# taranır, tek env.sh üretilir; BASH_ENV ile her bash'te yüklenir.
mkdir -p "$SDK_HOME/pub-cache" "$SDK_HOME/gopath" "$SDK_HOME/npm-global"
SDK_HOME="$SDK_HOME" "$SCRIPTS_DIR/sdk-env.sh" 2>&1 | sed 's/^/[entrypoint] /' >&2 || true
SDK_HOME="$SDK_HOME" "$SCRIPTS_DIR/sdk-env.sh" --list 2>/dev/null | sed 's/^/[entrypoint]   sdk: /' >&2 || true

rm -f "$DATA_DIR/.healthy"
log "Hazır. Bot başlatılıyor…"
exec "$@"
