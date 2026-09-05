#!/usr/bin/env bash
# Container içinde Flutter APK build eder; çıktıları /data/builds/<zaman>/ altına kopyalar ve
# her biri için "APK: <yol> <bayt>" satırı basar (bot bunları Telegram'dan gönderir).
#   build-apk.sh [debug|release|profile] [--all-abi] [--outbox] [--flavor <ad>] [-- <ek flutter argümanları>]
#   --all-abi : split-per-abi yerine tek fat APK (büyük; 50 MB sınırını aşabilir)
#   --outbox  : sonuçları repo/.agent/outbox/ altına da koy (ajan akışı → Telegram)
set -euo pipefail
# shellcheck disable=SC1091
[[ -f "${SDK_HOME:-/data/sdks}/env.sh" ]] && source "${SDK_HOME:-/data/sdks}/env.sh"

REPO="${REPO_DIR:-/data/repo}"
MODE=debug; SPLIT=1; OUTBOX=0; FLAVOR=""; EXTRA=()
while (($#)); do
  case "$1" in
    debug|release|profile) MODE="$1" ;;
    --all-abi) SPLIT=0 ;;
    --outbox) OUTBOX=1 ;;
    --flavor) FLAVOR="$2"; shift ;;
    --) shift; EXTRA=("$@"); break ;;
    *) echo "bilinmeyen argüman: $1" >&2; exit 2 ;;
  esac
  shift
done

log() { printf '[apk] %s\n' "$*"; }
cd "$REPO"
[[ -f pubspec.yaml ]] || { echo "[apk] HATA: $REPO bir Flutter projesi değil (pubspec.yaml yok)"; exit 1; }
command -v flutter >/dev/null || { echo "[apk] HATA: flutter PATH'te değil; /sdk ile bağlı SDK'lara bak, /init ile kur"; exit 1; }
[[ -d android ]] || { echo "[apk] HATA: android/ dizini yok"; exit 1; }

export GRADLE_USER_HOME="${GRADLE_USER_HOME:-${SDK_HOME:-/data/sdks}/gradle}"
export GRADLE_OPTS="${GRADLE_OPTS:--Dorg.gradle.daemon=false -Dorg.gradle.jvmargs=-Xmx3g}"
mkdir -p "$GRADLE_USER_HOME"

APP="$(awk '/^name:/{print $2; exit}' pubspec.yaml | tr -d '"'"'"'"' || echo app)"
SHA="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="/data/builds/$STAMP-$MODE-$SHA"
mkdir -p "$OUT"

log "proje=$APP dal=$BRANCH sha=$SHA mod=$MODE split=$SPLIT"
log "flutter $(flutter --version 2>/dev/null | head -1)"
log "pub get…"
flutter pub get 2>&1 | tail -3

ARGS=(build apk "--$MODE")
(( SPLIT )) && ARGS+=(--split-per-abi)
[[ -n "$FLAVOR" ]] && ARGS+=(--flavor "$FLAVOR")
ARGS+=("${EXTRA[@]}")
log "flutter ${ARGS[*]}  (ilk seferde gradle indirir, 10-20 dk sürebilir)"
if ! flutter "${ARGS[@]}" 2>&1 | grep -vE '^\s*$' | sed -u 's/^/  /'; then
  echo "[apk] HATA: build başarısız (yukarıdaki son satırlara bak)"; exit 1
fi

shopt -s nullglob
APKS=(build/app/outputs/flutter-apk/*.apk build/app/outputs/apk/*/*/*.apk build/app/outputs/apk/*/*.apk)
(( ${#APKS[@]} )) || { echo "[apk] HATA: APK bulunamadı (build/app/outputs)"; exit 1; }

for f in "${APKS[@]}"; do
  base="$(basename "$f" .apk)"                      # app-arm64-v8a-debug
  abi="$(grep -oE 'arm64-v8a|armeabi-v7a|x86_64|x86' <<<"$base" || true)"
  name="${APP}-${MODE}${abi:+-$abi}-${SHA}.apk"
  cp -f "$f" "$OUT/$name"
  size="$(stat -c %s "$OUT/$name")"
  echo "APK: $OUT/$name $size"
  if (( OUTBOX )); then mkdir -p .agent/outbox; cp -f "$OUT/$name" ".agent/outbox/$name"; fi
done
log "çıktılar: $OUT"
