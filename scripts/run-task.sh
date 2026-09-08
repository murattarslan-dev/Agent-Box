#!/usr/bin/env bash
# Repo görevlerini (test / lint / build / format / …) Claude'suz, deterministik çalıştırır.
#   run-task.sh <görev> [ek argümanlar…]        run-task.sh --list
# Komut kaynağı: repo kökündeki .agent-tasks (satır: "ad: komut"), yoksa proje türüne göre varsayılan.
# Tam çıktı /data/logs/<görev>-<zaman>.log'a yazılır; ekrana yalnızca son N satır (TASK_TAIL, varsayılan 60).
# Çıkış kodu = komutun çıkış kodu. Son satır: "TASK: <ad> <ok|fail> <kod> <log>"
set -uo pipefail
# shellcheck disable=SC1091
[[ -f "${SDK_HOME:-/data/sdks}/env.sh" ]] && source "${SDK_HOME:-/data/sdks}/env.sh"
REPO="${REPO_DIR:-/data/repo}"; LOGDIR="${LOG_DIR:-/data/logs}"; TAIL="${TASK_TAIL:-60}"
mkdir -p "$LOGDIR"; cd "$REPO" || { echo "repo yok: $REPO"; exit 2; }

# ---- varsayılanlar (proje türüne göre)
default_cmd() {
  local t="$1"
  if [[ -f pubspec.yaml ]]; then
    case "$t" in
      test)   echo "flutter test" ;;
      lint)   echo "dart analyze --fatal-infos --fatal-warnings" ;;
      format) echo "dart format --output=none --set-exit-if-changed ." ;;
      build)  echo "flutter build apk --debug --split-per-abi --target-platform android-arm64" ;;
      deps)   echo "flutter pub get" ;;
      doctor) echo "flutter doctor -v" ;;
    esac
  elif [[ -f go.mod ]]; then
    case "$t" in
      test)   echo "go test ./..." ;;
      lint)   echo "go vet ./..." ;;
      format) echo "test -z \"\$(gofmt -l .)\" || { gofmt -l .; exit 1; }" ;;
      build)  echo "go build ./..." ;;
      deps)   echo "go mod download" ;;
      doctor) echo "go version && go env GOPATH GOFLAGS" ;;
    esac
  elif [[ -f package.json ]]; then
    case "$t" in
      test)   echo "npm test" ;;
      lint)   echo "npm run lint --if-present" ;;
      format) echo "npm run format:check --if-present" ;;
      build)  echo "npm run build --if-present" ;;
      deps)   echo "npm ci" ;;
      doctor) echo "node -v && npm -v" ;;
    esac
  elif [[ -f Cargo.toml ]]; then
    case "$t" in
      test)   echo "cargo test" ;;
      lint)   echo "cargo clippy -- -D warnings" ;;
      format) echo "cargo fmt --check" ;;
      build)  echo "cargo build" ;;
      deps)   echo "cargo fetch" ;;
      doctor) echo "rustc --version && cargo --version" ;;
    esac
  elif [[ -f gradlew ]]; then
    case "$t" in
      test)   echo "./gradlew test" ;;
      lint)   echo "./gradlew lint" ;;
      build)  echo "./gradlew assembleDebug" ;;
      doctor) echo "./gradlew --version" ;;
    esac
  fi
}

task_cmd() {  # .agent-tasks → varsayılan
  local t="$1" c=""
  [[ -f .agent-tasks ]] && c="$(sed -E 's/#.*//' .agent-tasks | awk -v t="$t" -F': *' '$1==t { sub(/^[^:]*: */, ""); print; exit }')"
  [[ -n "$c" ]] || c="$(default_cmd "$t")"
  printf '%s' "$c"
}

if [[ "${1:-}" == --list || -z "${1:-}" ]]; then
  echo "Görevler (.agent-tasks → varsayılan):"
  for t in test lint format build deps doctor; do c="$(task_cmd "$t")"; [[ -n "$c" ]] && printf '  %-7s %s\n' "$t" "$c"; done
  if [[ -f .agent-tasks ]]; then sed -E 's/#.*//; /^\s*$/d' .agent-tasks | awk -F': *' '$1!~/^(test|lint|format|build|deps|doctor)$/ {printf "  %-7s %s\n", $1, substr($0, index($0,":")+2)}'; fi
  exit 0
fi

TASK="$1"; shift
CMD="$(task_cmd "$TASK")"
[[ -n "$CMD" ]] || { echo "TASK: $TASK fail 2 -"; echo "'$TASK' için komut yok. Repo köküne .agent-tasks ekle: '$TASK: <komut>'"; exit 2; }
[[ $# -gt 0 ]] && CMD="$CMD $*"
TS="$(date +%Y%m%d-%H%M%S)"; LOG="$LOGDIR/$TASK-$TS.log"
echo "[task] $TASK → $CMD"
echo "[task] log: $LOG"
START=$(date +%s)
( bash -o pipefail -c "$CMD" ) > "$LOG" 2>&1
CODE=$?
DUR=$(( $(date +%s) - START ))
LINES=$(wc -l < "$LOG")
if (( LINES > TAIL )); then echo "… ($((LINES - TAIL)) satır atlandı; tamamı: $LOG)"; fi
tail -n "$TAIL" "$LOG"
if (( CODE == 0 )); then echo "TASK: $TASK ok 0 $LOG (${DUR}s)"; else echo "TASK: $TASK fail $CODE $LOG (${DUR}s)"; fi
exit "$CODE"
