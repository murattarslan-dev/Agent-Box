#!/usr/bin/env bash
# Container içinde Flutter APK build eder; hedef: Telegram'dan gönderilebilecek (≤ 50 MB) EN KÜÇÜK paket.
#   build-apk.sh [small|release|profile|debug] [--all-abi] [--outbox] [--flavor <ad>] [--limit <MB>] [-- <ek flutter argümanları>]
#
#   small (varsayılan): sırayla release → profile → debug dener; hepsinde yalnızca arm64-v8a,
#                       release/profile'da --obfuscate --split-debug-info, tree-shake-icons; limitin altına
#                       inen ilk çıktıda durur. Hiçbiri sığmazsa en küçüğünü verir ve boyut analizini basar.
#   release|profile|debug: yalnızca o modu build eder (yine arm64-only, küçültme açık).
#   --all-abi  : tek "fat" APK (tüm ABI'ler; büyük)          --limit : hedef MB (varsayılan 50)
#   --outbox   : sonuçları repo/.agent/outbox/ altına da koy (ajan akışı → Telegram)
#
# Çıktı satırları (bot ayrıştırır):  APK: <yol> <bayt>     SIZE: <yol> <MB> <mod> <sığdı|büyük>
#                                    ANALYZE: <satır>       (limit aşıldıysa en büyük bileşenler)
set -euo pipefail
# APK_BUILDER=actions: build GitHub Actions'ta yapılır (container'da JDK/Android gerekmez) — aynı argümanlar, aynı çıktı satırları.
if [[ "${APK_BUILDER:-local}" == actions ]]; then exec "$(dirname "${BASH_SOURCE[0]}")/apk-remote.sh" "$@"; fi
# shellcheck disable=SC1091
[[ -f "${SDK_HOME:-/data/sdks}/env.sh" ]] && source "${SDK_HOME:-/data/sdks}/env.sh"

REPO="${REPO_DIR:-/data/repo}"
MODE=small; SPLIT=1; OUTBOX=0; FLAVOR=""; LIMIT_MB="${APK_LIMIT_MB:-50}"; EXTRA=()
while (($#)); do
  case "$1" in
    small|release|profile|debug) MODE="$1" ;;
    --all-abi) SPLIT=0 ;;
    --outbox) OUTBOX=1 ;;
    --flavor) FLAVOR="$2"; shift ;;
    --limit) LIMIT_MB="$2"; shift ;;
    --) shift; EXTRA=("$@"); break ;;
    *) echo "bilinmeyen argüman: $1" >&2; exit 2 ;;
  esac
  shift
done
LIMIT=$(( LIMIT_MB * 1024 * 1024 ))

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
OUT="/data/builds/$STAMP-$SHA"
mkdir -p "$OUT/symbols"

log "proje=$APP dal=$BRANCH sha=$SHA mod=$MODE hedef≤${LIMIT_MB}MB abi=$([[ $SPLIT == 1 ]] && echo arm64-v8a || echo fat)"
log "flutter $(flutter --version 2>/dev/null | head -1)"
log "pub get…"
flutter pub get 2>&1 | tail -3

# ---- tek bir modu build et; başarılıysa en büyük APK yolunu $BUILT'e yaz, döner 0
BUILT=""
build_mode() {
  local mode="$1"
  local args=(build apk "--$mode")
  if (( SPLIT )); then args+=(--split-per-abi --target-platform android-arm64); fi
  if [[ "$mode" != debug ]]; then
    args+=(--obfuscate "--split-debug-info=$OUT/symbols/$mode" --tree-shake-icons)
  fi
  [[ -n "$FLAVOR" ]] && args+=(--flavor "$FLAVOR")
  args+=("${EXTRA[@]}")
  log "→ flutter ${args[*]}"
  rm -rf build/app/outputs/flutter-apk build/app/outputs/apk 2>/dev/null || true
  if ! flutter "${args[@]}" 2>&1 | grep -vE '^\s*$' | sed -u 's/^/  /'; then
    log "✗ $mode build başarısız"
    return 1
  fi
  shopt -s nullglob
  local apks=(build/app/outputs/flutter-apk/*.apk build/app/outputs/apk/*/*/*.apk build/app/outputs/apk/*/*.apk)
  shopt -u nullglob
  (( ${#apks[@]} )) || { log "✗ $mode: APK bulunamadı"; return 1; }
  # split'te arm64 dosyası, değilse ilk
  BUILT=""
  for f in "${apks[@]}"; do [[ "$f" == *arm64* ]] && BUILT="$f"; done
  [[ -n "$BUILT" ]] || BUILT="${apks[0]}"
  return 0
}

# ---- APK içeriğinde en büyükler (limit aşılınca teşhis için)
analyze() {
  local apk="$1"
  command -v unzip >/dev/null || return 0
  echo "ANALYZE: --- $(basename "$apk") içerik dağılımı (sıkıştırılmamış) ---"
  unzip -l "$apk" 2>/dev/null | awk 'NR>3 && $4!="" && $1 ~ /^[0-9]+$/ { split($4,p,"/"); k=p[1]; if (p[2]!="" && (k=="lib"||k=="assets")) k=k"/"p[2]; s[k]+=$1 } END { for (k in s) printf "%d %s\n", s[k], k }' \
    | sort -rn | head -8 | awk '{printf "ANALYZE: %6.1f MB  %s\n", $1/1048576, $2}'
  echo "ANALYZE: --- en büyük 8 dosya ---"
  unzip -l "$apk" 2>/dev/null | awk 'NR>3 && $1 ~ /^[0-9]+$/ {print $1, $4}' | sort -rn | head -8 | awk '{printf "ANALYZE: %6.1f MB  %s\n", $1/1048576, $2}'
}

# ---- deneme sırası
if [[ "$MODE" == small ]]; then ORDER=(release profile debug); else ORDER=("$MODE"); fi

BEST=""; BEST_SIZE=0; BEST_MODE=""
for m in "${ORDER[@]}"; do
  if build_mode "$m"; then
    size="$(stat -c %s "$BUILT")"
    base="$(basename "$BUILT" .apk)"
    abi="$(grep -oE 'arm64-v8a|armeabi-v7a|x86_64|x86' <<<"$base" || true)"
    name="${APP}-${m}${abi:+-$abi}-${SHA}.apk"
    cp -f "$BUILT" "$OUT/$name"
    mb="$(awk -v s="$size" 'BEGIN{printf "%.1f", s/1048576}')"
    if (( size <= LIMIT )); then
      echo "SIZE: $OUT/$name $mb $m sığdı"
      log "✓ $m: ${mb} MB ≤ ${LIMIT_MB} MB"
      BEST="$OUT/$name"; BEST_SIZE="$size"; BEST_MODE="$m"
      break
    else
      echo "SIZE: $OUT/$name $mb $m büyük"
      log "! $m: ${mb} MB > ${LIMIT_MB} MB"
      if [[ -z "$BEST" || $size -lt $BEST_SIZE ]]; then BEST="$OUT/$name"; BEST_SIZE="$size"; BEST_MODE="$m"; fi
      [[ "$MODE" == small ]] && log "sıradaki mod deneniyor…"
    fi
  fi
done

[[ -n "$BEST" ]] || { echo "[apk] HATA: hiçbir mod build edilemedi (yukarıdaki son satırlara bak)"; exit 1; }

if (( BEST_SIZE > LIMIT )); then
  log "hiçbir mod ${LIMIT_MB} MB altına inmedi; en küçüğü: $BEST_MODE ($(awk -v s="$BEST_SIZE" 'BEGIN{printf "%.1f", s/1048576}') MB). İçerik analizi:"
  analyze "$BEST"
fi

echo "APK: $BEST $BEST_SIZE"
if (( OUTBOX )); then mkdir -p .agent/outbox; cp -f "$BEST" ".agent/outbox/$(basename "$BEST")"; fi
# obfuscate sembolleri: crash log'larını çözmek için saklanır (build dizininde)
log "çıktılar: $OUT  (semboller: $OUT/symbols)"
