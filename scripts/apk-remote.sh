#!/usr/bin/env bash
# APK'yı GitHub Actions'ta üretir (APK_BUILDER=actions): workflow'u tetikler, koşuyu izler, artifact'i indirir.
#   apk-remote.sh [small|release|profile|debug] [--all-abi] [--flavor <ad>] [--limit <MB>] [--ref <dal>] [--outbox]
#   apk-remote.sh --run <run_id> [--outbox]        # yalnızca indir (webhook / push tetiklemeli koşular için)
# Çıktı satırları build-apk.sh ile aynı (bot ayrıştırır):
#   RUN: <url>     SIZE: <yol> <MB> <mod> <sığdı|büyük>     APK: <yol> <bayt>     ANALYZE: <satır>
# Gerekli: gh (REPO_TOKEN ile; PAT'ta Actions: Read and write — workflow dosyasını push etmek için ayrıca Workflows: Read and write),
#          repoda .github/workflows/$APK_WORKFLOW (→ /apk setup).
set -uo pipefail
REPO="${REPO_DIR:-/data/repo}"; BUILDS="${DATA_DIR:-/data}/builds"; HOOKS="${DATA_DIR:-/data}/hooks"
WF="${APK_WORKFLOW:-agent-apk.yml}"; MODE=small; ALL_ABI=false; FLAVOR=""; LIMIT_MB="${APK_LIMIT_MB:-50}"; REF=""; RUN_ID=""; OUTBOX=0
POLL="${APK_POLL_SECONDS:-20}"; MAX_WAIT="${APK_MAX_WAIT_SECONDS:-2700}"
while (($#)); do
  case "$1" in
    small|release|profile|debug) MODE="$1" ;;
    --all-abi) ALL_ABI=true ;; --flavor) FLAVOR="$2"; shift ;; --limit) LIMIT_MB="$2"; shift ;;
    --ref) REF="$2"; shift ;; --run) RUN_ID="$2"; shift ;; --outbox) OUTBOX=1 ;;
    --) break ;;   # build-apk.sh'nin "-- <ek flutter argümanları>" kısmı uzakta desteklenmez; yok say
    *) echo "bilinmeyen argüman: $1" >&2; exit 2 ;;
  esac; shift
done
log() { printf '[apk-ci] %s\n' "$*"; }
cd "$REPO" || { echo "[apk-ci] HATA: repo yok: $REPO"; exit 1; }
command -v gh >/dev/null || { echo "[apk-ci] HATA: gh yok"; exit 1; }
[[ "${GIT_PROVIDER:-github}" == github ]] || { echo "[apk-ci] HATA: APK_BUILDER=actions yalnızca GitHub için (GitLab CI desteği henüz yok; APK_BUILDER=local kullan)"; exit 1; }
mkdir -p "$BUILDS" "$HOOKS"

if [[ -z "$RUN_ID" ]]; then
  [[ -n "$REF" ]] || REF="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "${DEFAULT_BRANCH:-main}")"
  # dal uzakta var mı? (Actions yalnızca push edilmiş dalı build eder)
  if ! git ls-remote --exit-code --heads origin "$REF" >/dev/null 2>&1; then
    echo "[apk-ci] HATA: '$REF' dalı origin'de yok. Actions push edilmiş kodu build eder; önce push et (PR onayı sonrası ajan push eder) ya da --ref <dal> ver."; exit 1
  fi
  if ! gh workflow view "$WF" >/dev/null 2>&1; then
    echo "[apk-ci] HATA: repoda '$WF' workflow'u yok ya da token Actions'ı göremiyor. Telegram'da /apk setup ile ekle; PAT izni: Actions → Read and write."; exit 1
  fi
  log "workflow tetikleniyor: $WF @ $REF (mod=$MODE${FLAVOR:+ flavor=$FLAVOR} limit=${LIMIT_MB}MB${ALL_ABI:+ all_abi=$ALL_ABI})"
  T0="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if ! gh workflow run "$WF" --ref "$REF" -f "mode=$MODE" -f "flavor=$FLAVOR" -f "limit=$LIMIT_MB" -f "all_abi=$ALL_ABI" 2>&1; then
    echo "[apk-ci] HATA: tetiklenemedi (yukarıdaki gh çıktısı). PAT izinleri: Actions RW, Contents R."; exit 1
  fi
  # koşu id'sini bul (dispatch birkaç sn sonra listede görünür)
  for _ in $(seq 1 20); do
    sleep 3
    RUN_ID="$(gh run list --workflow "$WF" --branch "$REF" --event workflow_dispatch --json databaseId,createdAt --limit 5 \
      --jq --arg t "$T0" '[.[] | select(.createdAt >= $t)] | sort_by(.createdAt) | last | .databaseId // empty' 2>/dev/null || true)"
    [[ -n "$RUN_ID" ]] && break
  done
  [[ -n "$RUN_ID" ]] || { echo "[apk-ci] HATA: koşu listede görünmedi (gh run list). Actions'ta elle bak."; exit 1; }
fi

URL="$(gh run view "$RUN_ID" --json url --jq .url 2>/dev/null || echo "run $RUN_ID")"
echo "RUN: $URL"

# ---- izle: her POLL sn'de durum; webhook geldiyse ($HOOKS/<id>.done) hemen çık
START=$(date +%s); LAST=""
while :; do
  J="$(gh run view "$RUN_ID" --json status,conclusion,jobs --jq '{s:.status,c:.conclusion,step:([.jobs[]?.steps[]? | select(.status=="in_progress") | .name] | first // "")}' 2>/dev/null || echo '{}')"
  S="$(jq -r '.s // ""' <<<"$J")"; C="$(jq -r '.c // ""' <<<"$J")"; STEP="$(jq -r '.step // ""' <<<"$J")"
  MSG="$S${STEP:+ · $STEP}"
  [[ "$MSG" != "$LAST" ]] && { log "$MSG ($(( $(date +%s) - START ))s)"; LAST="$MSG"; }
  [[ "$S" == completed ]] && break
  (( $(date +%s) - START > MAX_WAIT )) && { echo "[apk-ci] HATA: ${MAX_WAIT}s doldu; koşu hâlâ $S: $URL"; exit 1; }
  for _ in $(seq 1 "$POLL"); do [[ -f "$HOOKS/$RUN_ID.done" ]] && break; sleep 1; done
  [[ -f "$HOOKS/$RUN_ID.done" ]] && { log "webhook geldi"; rm -f "$HOOKS/$RUN_ID.done"; POLL=5; sleep 3; }   # bitişe yakın: sık sorgula
done
if [[ "$C" != success ]]; then
  echo "[apk-ci] HATA: koşu $C — $URL"
  gh run view "$RUN_ID" --log-failed 2>/dev/null | grep -vE '^\s*$' | tail -n 25 | sed 's/^/  /'
  exit 1
fi

# ---- indir
SHA="$(gh run view "$RUN_ID" --json headSha --jq '.headSha[0:7]' 2>/dev/null || echo ci)"
OUT="$BUILDS/$(date +%Y%m%d-%H%M%S)-$SHA-ci"; mkdir -p "$OUT"
log "artifact indiriliyor → $OUT"
if ! gh run download "$RUN_ID" -n apk -D "$OUT" 2>&1; then echo "[apk-ci] HATA: artifact indirilemedi (adı 'apk' olmalı)"; exit 1; fi
gh run download "$RUN_ID" -n symbols -D "$OUT/symbols" >/dev/null 2>&1 || true
[[ -f "$OUT/result.txt" ]] || { echo "[apk-ci] HATA: result.txt yok"; exit 1; }
# result.txt'deki göreli adları mutlak yola çevir; APK: satırında bayt sayısını yerelden doğrula
while IFS= read -r line; do
  case "$line" in
    "SIZE: "*) set -- $line; echo "SIZE: $OUT/$2 $3 $4 $5" ;;
    "APK: "*)  set -- $line; [[ -f "$OUT/$2" ]] && echo "APK: $OUT/$2 $(stat -c %s "$OUT/$2")" ;;
    "ANALYZE: "*|"FAIL: "*) echo "$line" ;;
  esac
done < "$OUT/result.txt"
if ((OUTBOX)); then mkdir -p .agent/outbox; cp "$OUT"/*.apk .agent/outbox/ 2>/dev/null || true; fi
log "bitti ($(( $(date +%s) - START ))s)"
