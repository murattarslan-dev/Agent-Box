#!/usr/bin/env bash
# Flutter web build'i (repo/build/web), /app/ altında sunulacak şekilde (--base-href /app/).
#   web-build.sh [--force|--skip]      → değişiklik yoksa build atlanır; --force zorlar, --skip hiç build etmez
# Build komutu: CLAUDE.md ```screenshot bloğundaki "build:" satırı, yoksa "flutter build web --release".
# Çıktı: son satır "WEB: <dizin> <built|cached>"; hata durumunda çıkış 1 ve logun son satırları.
# Hem /preview (telefondan link) hem screenshot.sh bunu kullanır.
set -uo pipefail
# shellcheck disable=SC1091
[[ -f "${SDK_HOME:-/data/sdks}/env.sh" ]] && source "${SDK_HOME:-/data/sdks}/env.sh"
REPO="${REPO_DIR:-/data/repo}"; LOGDIR="${LOG_DIR:-/data/logs}"; MODE=auto
case "${1:-}" in --force) MODE=1 ;; --skip) MODE=0 ;; "") ;; *) echo "bilinmeyen argüman: $1" >&2; exit 2 ;; esac
mkdir -p "$LOGDIR"; cd "$REPO" || { echo "repo yok: $REPO"; exit 2; }
log() { printf '[web] %s\n' "$*"; }

[[ -f pubspec.yaml ]] || { echo "[web] HATA: Flutter projesi değil (pubspec.yaml yok)"; exit 1; }
[[ -d web ]] || { echo "[web] HATA: web/ dizini yok. Web hedefi ekle: flutter create --platforms=web . (repo değişikliği → onay)"; exit 1; }
command -v flutter >/dev/null || { echo "[web] HATA: flutter PATH'te değil (/init)"; exit 1; }

BUILD_CMD=""
if [[ -f CLAUDE.md ]]; then
  BUILD_CMD="$(awk '/^```screenshot/{f=1;next} /^```/{f=0} f' CLAUDE.md | sed -E 's/#.*//' | awk -F': *' '$1=="build" { sub(/^[^:]*: */, ""); print; exit }')"
fi
[[ -n "$BUILD_CMD" ]] || BUILD_CMD="flutter build web --release"
[[ "$BUILD_CMD" == *--base-href* ]] || BUILD_CMD="$BUILD_CMD --base-href /app/"

if [[ "$MODE" == auto ]]; then
  if [[ -f build/web/index.html && -f build/web/.base-app ]] && [[ -z "$(find lib web pubspec.yaml assets -newer build/web/index.html -type f 2>/dev/null | head -1)" ]]; then MODE=0; else MODE=1; fi
fi
if ((MODE)); then
  TS="$(date +%Y%m%d-%H%M%S)"; BLOG="$LOGDIR/web-build-$TS.log"
  log "build: $BUILD_CMD  (log: $BLOG)"
  flutter config --enable-web >/dev/null 2>&1 || true
  if ! bash -o pipefail -c "$BUILD_CMD" >"$BLOG" 2>&1; then
    echo "[web] HATA: web build başarısız; son satırlar:"; tail -n 25 "$BLOG"; echo "[web] tam log: $BLOG"; exit 1
  fi
  touch build/web/.base-app
  log "build tamam ($(du -sh build/web | cut -f1))"
  echo "WEB: $REPO/build/web built"
else
  [[ -f build/web/index.html ]] || { echo "[web] HATA: build/web/index.html yok (--skip verildi ama build yok)"; exit 1; }
  log "build güncel, atlandı"
  echo "WEB: $REPO/build/web cached"
fi
