#!/usr/bin/env bash
# Flutter uygulamasını web olarak build eder, headless Chromium'da telefon boyutunda açar, rota rota PNG alır.
# Emülatör/KVM gerekmez. (Native/platform-özel görünümler yakalanmaz; UI'nin %95'i için yeterli.)
#   screenshot.sh [rota…] [--build|--no-build] [--outbox] [--hash] [--width N] [--height N] [--scale N]
#                 [--wait ms] [--storage k=v]… [--full] [--desktop] [--out DIR]
# Varsayılanlar repo CLAUDE.md içindeki ```screenshot bloğundan okunur (satır: "anahtar: değer"):
#   routes: /home, /home/m/customers      hash: true|false     width: 390   height: 844   scale: 2
#   wait: 1500                            storage: auth_token=$APP_TEST_TOKEN, theme=dark   ($VAR → env'den)
#   build: flutter build web --release --dart-define=API_URL=https://staging.example.com   (web-build.sh okur)
# Çıktı satırları (bot ayrıştırır):  SHOT: <png> <rota>   SHOTERR: <rota> <mesaj>   SHOTS: <dizin> <adet>
set -uo pipefail
# shellcheck disable=SC1091
[[ -f "${SDK_HOME:-/data/sdks}/env.sh" ]] && source "${SDK_HOME:-/data/sdks}/env.sh"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${REPO_DIR:-/data/repo}"; LOGDIR="${LOG_DIR:-/data/logs}"; BUILDS="${DATA_DIR:-/data}/builds"
mkdir -p "$LOGDIR" "$BUILDS"
cd "$REPO" || { echo "repo yok: $REPO"; exit 2; }
log() { printf '[shot] %s\n' "$*"; }

# ---- CLAUDE.md ```screenshot bloğu
cfg() {  # cfg <anahtar> → değer (yoksa boş)
  [[ -f CLAUDE.md ]] || return 0
  awk '/^```screenshot/{f=1;next} /^```/{f=0} f' CLAUDE.md | sed -E 's/#.*//' | awk -v k="$1" -F': *' '$1==k { sub(/^[^:]*: */, ""); print; exit }'
}
ROUTES=(); BUILD=auto; OUTBOX=0; HASH="$(cfg hash)"; WIDTH="$(cfg width)"; HEIGHT="$(cfg height)"; SCALE="$(cfg scale)"
WAIT="$(cfg wait)"; STORAGE=(); FULL=0; UA=mobile; OUT=""
IFS=',' read -r -a _st <<<"$(cfg storage)"; for s in "${_st[@]}"; do s="${s## }"; s="${s%% }"; [[ -n "$s" ]] && STORAGE+=("$s"); done
while (($#)); do
  case "$1" in
    --build) BUILD=1 ;; --no-build) BUILD=0 ;; --outbox) OUTBOX=1 ;; --hash) HASH=true ;; --full) FULL=1 ;; --desktop) UA=desktop ;;
    --width) WIDTH="$2"; shift ;; --height) HEIGHT="$2"; shift ;; --scale) SCALE="$2"; shift ;; --wait) WAIT="$2"; shift ;;
    --storage) STORAGE+=("$2"); shift ;; --out) OUT="$2"; shift ;;
    --*) echo "bilinmeyen argüman: $1" >&2; exit 2 ;;
    *) ROUTES+=("$1") ;;
  esac; shift
done
if ((${#ROUTES[@]} == 0)); then IFS=',' read -r -a ROUTES <<<"$(cfg routes)"; fi
ROUTES=("${ROUTES[@]// /}"); ((${#ROUTES[@]})) && [[ -n "${ROUTES[0]}" ]] || ROUTES=("/")
: "${WIDTH:=390}" "${HEIGHT:=844}" "${SCALE:=2}" "${WAIT:=1500}"
# storage değerlerinde $VAR → env
_ST=(); for kv in "${STORAGE[@]}"; do k="${kv%%=*}"; v="${kv#*=}"; if [[ "$v" == \$* ]]; then n="${v#\$}"; v="${!n:-}"; [[ -n "$v" ]] || log "UYARI: storage $k için \$$n boş"; fi; _ST+=(--storage "$k=$v"); done

CHROMIUM="${CHROMIUM_PATH:-/usr/bin/chromium}"; [[ -x "$CHROMIUM" ]] || { echo "[shot] HATA: chromium yok ($CHROMIUM); imajı yeniden build et"; exit 1; }

# ---- 1) web build (web-build.sh: değişiklik yoksa atlar; --base-href /app/)
WB=(); [[ "$BUILD" == 1 ]] && WB=(--force); [[ "$BUILD" == 0 ]] && WB=(--skip)
bash "$HERE/web-build.sh" "${WB[@]}" | sed -E 's/^\[web\]/[shot]/' | grep -v '^WEB: '
(( PIPESTATUS[0] == 0 )) || exit 1
[[ -f build/web/index.html ]] || { echo "[shot] HATA: build/web/index.html yok"; exit 1; }

# ---- 2) statik sunucu (SPA fallback: bilinmeyen yol → index.html)
PORT=$(( 20000 + RANDOM % 20000 ))
node -e '
const http=require("http"),fs=require("fs"),p=require("path");const root=process.argv[1],port=+process.argv[2];
const mime={".html":"text/html",".js":"application/javascript",".mjs":"application/javascript",".json":"application/json",".wasm":"application/wasm",".css":"text/css",".png":"image/png",".jpg":"image/jpeg",".svg":"image/svg+xml",".ttf":"font/ttf",".otf":"font/otf",".woff":"font/woff",".woff2":"font/woff2",".ico":"image/x-icon"};
http.createServer((q,s)=>{let u=decodeURIComponent(q.url.split("?")[0]).replace(/^\/app(\/|$)/,"/");let f=p.join(root,u);if(!f.startsWith(root)){s.writeHead(403).end();return}
if(!fs.existsSync(f)||fs.statSync(f).isDirectory()){f=p.join(root,"index.html")}
s.writeHead(200,{"content-type":mime[p.extname(f)]||"application/octet-stream","cache-control":"no-store"});fs.createReadStream(f).pipe(s)}).listen(port,"127.0.0.1");
' "$REPO/build/web" "$PORT" &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
for _ in $(seq 1 30); do curl -fs "http://127.0.0.1:$PORT/app/index.html" >/dev/null 2>&1 && break; sleep 0.2; done

# ---- 3) ekran görüntüleri
TS="$(date +%Y%m%d-%H%M%S)"; SHA="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
[[ -n "$OUT" ]] || OUT="$BUILDS/shots-$TS-$SHA"
mkdir -p "$OUT"
HASHARG=(); [[ "$HASH" == true || "$HASH" == 1 ]] && HASHARG=(--hash)
FULLARG=(); ((FULL)) && FULLARG=(--full)
log "rotalar: ${ROUTES[*]}  (${WIDTH}x${HEIGHT} @${SCALE}x, ${UA})"
node "$HERE/web-shot.mjs" --base "http://127.0.0.1:$PORT/app" --out "$OUT" --routes "$(IFS=,; echo "${ROUTES[*]}")" \
  --width "$WIDTH" --height "$HEIGHT" --scale "$SCALE" --wait "$WAIT" --ua "$UA" "${HASHARG[@]}" "${FULLARG[@]}" "${_ST[@]}" 2>&1 | tee "$LOGDIR/shot-$TS.log"
RC=${PIPESTATUS[0]}
N=$(find "$OUT" -name '*.png' | wc -l)
if ((OUTBOX)) && ((N)); then mkdir -p .agent/outbox; cp "$OUT"/*.png .agent/outbox/; fi
echo "SHOTS: $OUT $N"
exit "$RC"
