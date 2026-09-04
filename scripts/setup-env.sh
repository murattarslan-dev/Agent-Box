#!/usr/bin/env bash
# İnteraktif kurulum sihirbazı: .env dosyasını soru-cevapla oluşturur ve her değeri anında doğrular.
#   ./up.sh            → .env yoksa otomatik çalışır
#   ./up.sh setup      → yeniden çalıştır (mevcut .env yedeklenir)
# Gereksinim: bash, curl. (python3 varsa JSON daha sağlam ayrıştırılır; yoksa grep ile idare eder.)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

c_b=$'\e[1m'; c_dim=$'\e[2m'; c_grn=$'\e[32m'; c_ylw=$'\e[33m'; c_red=$'\e[31m'; c_cyan=$'\e[36m'; c_off=$'\e[0m'
say()  { printf '%s\n' "$*"; }
ok()   { printf '  %s✓%s %s\n' "$c_grn" "$c_off" "$*"; }
warn() { printf '  %s!%s %s\n' "$c_ylw" "$c_off" "$*"; }
bad()  { printf '  %s✗%s %s\n' "$c_red" "$c_off" "$*"; }
step() { printf '\n%s%s%s\n' "$c_b" "$*" "$c_off"; }
hint() { printf '  %s%s%s\n' "$c_dim" "$*" "$c_off"; }

json_get() {  # json_get '<json>' '<python expr on d>' '<grep fallback regex>'
  local json="$1" expr="$2" re="${3:-}"
  if command -v python3 >/dev/null 2>&1; then
    printf '%s' "$json" | python3 -c "import sys,json
try:
  d=json.load(sys.stdin); print($expr)
except Exception: pass" 2>/dev/null || true
  elif [[ -n "$re" ]]; then
    printf '%s' "$json" | grep -oE "$re" | head -1 | sed -E 's/.*[:=] *"?([^",}]*)"?/\1/'
  fi
}

ask() {  # ask VAR "Soru" [varsayılan] [gizli]
  local var="$1" q="$2" def="${3:-}" secret="${4:-}" val
  while true; do
    if [[ -n "$def" ]]; then printf '  %s%s%s [%s]: ' "$c_cyan" "$q" "$c_off" "$def"; else printf '  %s%s%s: ' "$c_cyan" "$q" "$c_off"; fi
    if [[ -n "$secret" ]]; then read -rs val || { echo; bad "Girdi kapandı."; exit 1; }; echo; else read -r val || { echo; bad "Girdi kapandı."; exit 1; }; fi
    val="${val//$'\r'/}"; val="${val#"${val%%[![:space:]]*}"}"; val="${val%"${val##*[![:space:]]}"}"
    [[ -z "$val" && -n "$def" ]] && val="$def"
    [[ -n "$val" ]] && { printf -v "$var" '%s' "$val"; return; }
    bad "Boş bırakılamaz."
  done
}

confirm() {  # confirm "Soru" → 0 evet
  local a; printf '  %s%s%s [E/h]: ' "$c_cyan" "$1" "$c_off"; read -r a; [[ -z "$a" || "$a" =~ ^[EeYy] ]]
}

# ============================================================================
say ""
say "${c_b}╭──────────────────────────────────────────────╮${c_off}"
say "${c_b}│  claude-telegram-agent · kurulum sihirbazı   │${c_off}"
say "${c_b}╰──────────────────────────────────────────────╯${c_off}"
say "  5 değer soracağım; her birini nereden alacağını yanında yazıyorum."
say "  Yapıştırdığın token'lar ekranda görünmez. Çıkmak için Ctrl+C."

if [[ -f .env ]]; then
  cp .env ".env.bak.$(date +%Y%m%d%H%M%S)"; warn "Mevcut .env yedeklendi (.env.bak.*)."
fi
command -v curl >/dev/null || { bad "curl bulunamadı (sudo apt-get install -y curl)"; exit 1; }
# SETUP_SKIP_VERIFY=1: ağ doğrulamalarını atla (çevrimdışı / test)
VERIFY=1; [[ "${SETUP_SKIP_VERIFY:-0}" == 1 ]] && { VERIFY=0; warn "Ağ doğrulamaları atlanıyor (SETUP_SKIP_VERIFY=1)."; }

# ---------- 0) Docker ----------
step "0/5  Docker"
if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  ok "docker çalışıyor ($(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?'))"
else
  warn "docker bulunamadı ya da çalışmıyor. Docker Desktop açık mı? WSL kullanıyorsan:"
  hint "Docker Desktop → Settings → Resources → WSL integration → bu dağıtımı aç → Apply; sonra 'wsl --shutdown'"
  confirm "Yine de .env'i oluşturup devam edeyim mi?" || exit 1
fi

# ---------- 1) Claude token ----------
step "1/5  Claude token  (CLAUDE_CODE_OAUTH_TOKEN)"
hint "Kendi makinende:  npm i -g @anthropic-ai/claude-code && claude setup-token"
hint "Tarayıcıda onayla, tarayıcının verdiği KODU terminale yapıştır; terminalin bastığı"
hint "'sk-ant-oat01-…' ile başlayan uzun satır token'dır (Pro/Max abonelik gerekir)."
while true; do
  ask CLAUDE_CODE_OAUTH_TOKEN "Claude token" "" secret
  if [[ "$CLAUDE_CODE_OAUTH_TOKEN" == sk-ant-oat01-* && ${#CLAUDE_CODE_OAUTH_TOKEN} -gt 40 ]]; then
    (( VERIFY )) || { ok "biçim doğru"; break; }
    code="$(curl -s -m 15 -o /dev/null -w '%{http_code}' 'https://api.anthropic.com/v1/models?limit=1' \
      -H "Authorization: Bearer $CLAUDE_CODE_OAUTH_TOKEN" -H 'anthropic-version: 2023-06-01' -H 'anthropic-beta: oauth-2025-04-20' || echo 000)"
    case "$code" in
      200) ok "token geçerli"; break ;;
      401|403) bad "Anthropic token'ı reddetti ($code). Yeniden 'claude setup-token' ile üret." ;;
      000) warn "Doğrulanamadı (ağ). Biçim doğru, devam ediyorum."; break ;;
      *) warn "Beklenmeyen cevap ($code); biçim doğru, devam ediyorum."; break ;;
    esac
  else
    bad "Token 'sk-ant-oat01-' ile başlamalı. Tarayıcı kodunu değil, terminalin bastığı token'ı yapıştır."
  fi
done

# ---------- 2) Telegram bot ----------
step "2/5  Telegram bot token  (TELEGRAM_BOT_TOKEN)"
hint "Telegram'da @BotFather → /newbot → isim → '…_bot' ile biten kullanıcı adı → verdiği token."
BOT_USERNAME=""
while true; do
  ask TELEGRAM_BOT_TOKEN "Bot token" "" secret
  if [[ "$TELEGRAM_BOT_TOKEN" =~ ^[0-9]{6,}:[A-Za-z0-9_-]{30,}$ ]]; then
    (( VERIFY )) || { ok "biçim doğru"; break; }
    me="$(curl -s -m 15 "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe" || true)"
    BOT_USERNAME="$(json_get "$me" "d['result']['username']" '"username":"[^"]+"')"
    if [[ -n "$BOT_USERNAME" ]]; then ok "bot: @$BOT_USERNAME"; break
    elif [[ -z "$me" ]]; then warn "Telegram'a ulaşılamadı (ağ). Biçim doğru, devam."; break
    else bad "Telegram token'ı tanımadı. BotFather'daki token'ı tam kopyala."; fi
  else
    bad "Biçim '123456789:AAF…' şeklinde olmalı."
  fi
done

# ---------- 3) Telegram kullanıcı id ----------
step "3/5  Senin Telegram id'n  (TELEGRAM_ALLOWED_USER_IDS)"
TELEGRAM_ALLOWED_USER_IDS=""
if (( VERIFY )) && [[ -n "$BOT_USERNAME" ]]; then
  say "  Telegram'da ${c_b}@$BOT_USERNAME${c_off} sohbetini aç, ${c_b}Başlat${c_off}'a bas ya da herhangi bir şey yaz, sonra buraya dön."
  for attempt in 1 2 3; do
    printf '  %sMesajı attıysan Enter%s ' "$c_cyan" "$c_off"; read -r _
    upd="$(curl -s -m 15 "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?limit=20" || true)"
    uid="$(json_get "$upd" "[m for m in (u.get('message') or u.get('my_chat_member') or {} for u in d['result'])][-1]['from']['id']" '"from":\{"id":[0-9]+')"
    uname="$(json_get "$upd" "[m for m in (u.get('message') or u.get('my_chat_member') or {} for u in d['result'])][-1]['from'].get('first_name','')" '')"
    uid="${uid//[^0-9]/}"
    if [[ -n "$uid" ]]; then
      ok "bulundu: $uid${uname:+ ($uname)}"
      if confirm "Bu sen misin?"; then TELEGRAM_ALLOWED_USER_IDS="$uid"; break; fi
    else
      warn "Henüz mesaj görünmüyor (deneme $attempt/3). Bota yazdığından emin ol; 1-2 sn bekleyip tekrar Enter."
    fi
  done
fi
if [[ -z "$TELEGRAM_ALLOWED_USER_IDS" ]]; then
  hint "Elle: Telegram'da @userinfobot'a yaz, 'Id: 123456789' verir. Birden fazla kişi: virgülle ayır."
  while true; do
    ask TELEGRAM_ALLOWED_USER_IDS "Telegram kullanıcı id"
    [[ "$TELEGRAM_ALLOWED_USER_IDS" =~ ^[0-9]+(,[0-9]+)*$ ]] && break
    bad "Sadece rakam (ve virgül) olmalı."
  done
fi

# ---------- 4) Repo ----------
step "4/5  Repo adresi  (REPO_URL)"
hint "GitHub: repo sayfası → Code → HTTPS.  Örn: https://github.com/kullanici/repo.git  (ssh adresi olmaz)"
while true; do
  ask REPO_URL "Repo URL"
  REPO_URL="${REPO_URL%/}"; [[ "$REPO_URL" == *.git ]] || REPO_URL="$REPO_URL.git"
  [[ "$REPO_URL" =~ ^https://[^/]+/[^/]+/[^/]+\.git$ ]] && break
  bad "https://host/sahip/repo.git biçiminde olmalı."
done
REPO_HOST="$(sed -E 's#^https://([^/]+)/.*#\1#' <<<"$REPO_URL")"
REPO_PATH="$(sed -E 's#^https://[^/]+/##; s#\.git$##' <<<"$REPO_URL")"
GIT_PROVIDER=""
case "$REPO_HOST" in *github*) GIT_PROVIDER=github ;; *gitlab*) GIT_PROVIDER=gitlab ;; esac
if [[ -z "$GIT_PROVIDER" ]]; then
  ask GIT_PROVIDER "Bu host GitHub mu GitLab mı? (github/gitlab)" "github"
fi
ok "$GIT_PROVIDER · $REPO_HOST · $REPO_PATH"

# ---------- 5) Repo token ----------
step "5/5  Repo token  (REPO_TOKEN)"
if [[ "$GIT_PROVIDER" == github ]]; then
  hint "Tarayıcıda (uygulamada değil):  https://github.com/settings/personal-access-tokens/new"
  hint "Only select repositories → bu repo · Permissions: Contents = Read and write, Pull requests = Read and write"
else
  hint "GitLab: proje → Settings → Access Tokens → role Developer, scopes: api, read_repository, write_repository"
fi
while true; do
  ask REPO_TOKEN "Repo token" "" secret
  (( VERIFY )) || { ok "alındı"; break; }
  if [[ "$GIT_PROVIDER" == github ]]; then
    api="https://api.github.com"; [[ "$REPO_HOST" == github.com ]] || api="https://$REPO_HOST/api/v3"
    resp="$(curl -s -m 15 -H "Authorization: Bearer $REPO_TOKEN" -H 'Accept: application/vnd.github+json' "$api/repos/$REPO_PATH" || true)"
    push="$(json_get "$resp" "d['permissions']['push']" '"push": *(true|false)')"
    if [[ "$push" == True || "$push" == true ]]; then ok "repo erişimi + push yetkisi doğrulandı"; break
    elif [[ -z "$resp" ]]; then warn "GitHub'a ulaşılamadı (ağ). Devam."; break
    elif grep -q '"permissions"' <<<"$resp"; then bad "Token repoyu görüyor ama push yetkisi yok: Contents = Read and write olmalı."
    else bad "Token bu repoya erişemiyor: 'Only select repositories' listesinde repo seçili mi? Token doğru mu?"; fi
  else
    enc="${REPO_PATH//\//%2F}"
    resp="$(curl -s -m 15 -H "PRIVATE-TOKEN: $REPO_TOKEN" "https://$REPO_HOST/api/v4/projects/$enc" || true)"
    if grep -q '"path_with_namespace"' <<<"$resp"; then ok "GitLab projesine erişim doğrulandı"; break
    elif [[ -z "$resp" ]]; then warn "GitLab'a ulaşılamadı (ağ). Devam."; break
    else bad "Token projeye erişemiyor."; fi
  fi
done

# ---------- yaz ----------
step "Yazılıyor: .env"
set_kv() {  # dosyada KEY= satırını değiştir ya da ekle
  local key="$1" val="$2"
  if grep -qE "^${key}=" .env; then
    awk -v k="$key" -v v="$val" 'BEGIN{FS=OFS="="} $1==k{ $0=k"="v } {print}' .env > .env.tmp && mv .env.tmp .env
  else
    printf '%s=%s\n' "$key" "$val" >> .env
  fi
}
cp .env.example .env
set_kv CLAUDE_CODE_OAUTH_TOKEN "$CLAUDE_CODE_OAUTH_TOKEN"
set_kv TELEGRAM_BOT_TOKEN "$TELEGRAM_BOT_TOKEN"
set_kv TELEGRAM_ALLOWED_USER_IDS "$TELEGRAM_ALLOWED_USER_IDS"
set_kv REPO_URL "$REPO_URL"
set_kv REPO_TOKEN "$REPO_TOKEN"
set_kv GIT_PROVIDER "$GIT_PROVIDER"
chmod 600 .env
ok ".env hazır (600). Diğer ayarlar (model, AUTO_PR, SDKS…) için: nano .env"
say ""
