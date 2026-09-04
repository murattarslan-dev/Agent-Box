#!/usr/bin/env bash
# ============================================================================
#  claude-telegram-agent — tek script ile ayağa kaldır
#
#  ./up.sh                 Docker ile başlat (compose varsa compose, yoksa docker run)
#  ./up.sh --k8s           Kubernetes'e kur (namespace + secret + pvc + deployment)
#  ./up.sh --k8s --build   Önce imajı yerel build et (kind/minikube/k3s/docker-desktop)
#  ./up.sh --k8s --push    Build edip IMAGE registry'sine push et, sonra kur
#  ./up.sh setup           .env'i sihirbazla (yeniden) oluştur
#  ./up.sh logs|restart|down|shell|status|sdk [--k8s]
#
#  SDK volume'ları: repo taranır, gereken her SDK için sdk-<isim>-<sürüm> volume'u
#  yoksa bir kere kurulur, varsa doğrudan bağlanır (.env: SDKS ile override, SDKS=none ile kapat).
#  Windows: WSL2 ya da Git Bash içinden çalıştır.
# ============================================================================
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

MODE=docker; ACTION=up; BUILD=0; PUSH=0
for a in "$@"; do
  case "$a" in
    --k8s|--kube) MODE=k8s ;;
    --build) BUILD=1 ;;
    --push) BUILD=1; PUSH=1 ;;
    up|down|logs|restart|shell|status|sdk|setup) ACTION=$a ;;
    -h|--help) sed -n "2,15p" "$0"; exit 0 ;;
    *) echo "Bilinmeyen argüman: $a" >&2; exit 2 ;;
  esac
done

c_red=$'\e[31m'; c_grn=$'\e[32m'; c_ylw=$'\e[33m'; c_off=$'\e[0m'
info() { echo "${c_grn}▶${c_off} $*"; }
warn() { echo "${c_ylw}!${c_off} $*" >&2; }
die()  { echo "${c_red}✗${c_off} $*" >&2; exit 1; }

# ---------- .env ----------
if [[ "$ACTION" == setup ]]; then
  bash ./scripts/setup-env.sh
  info "Şimdi başlatmak için: ./up.sh"; exit 0
fi
if [[ ! -f .env ]]; then
  info ".env yok — kurulum sihirbazı başlıyor (tekrar çalıştırmak için: ./up.sh setup)"
  bash ./scripts/setup-env.sh
fi
# Windows editörlerinden gelen CRLF satır sonlarını temizle (yoksa token'ların sonuna \r yapışır)
if grep -q $'\r' .env 2>/dev/null; then sed -i 's/\r$//' .env; fi
# .env'i çalıştırmadan oku (boşluklu değerler, tırnaklar güvenli)
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
  line="${line#export }"; key="${line%%=*}"; val="${line#*=}"
  [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
  if [[ "$val" == \"*\" || "$val" == \'*\' ]]; then val="${val:1:${#val}-2}"; fi
  export "$key=$val"
done < .env

: "${DATA_PATH:=./data}"
: "${IMAGE:=claude-telegram-agent:latest}"
: "${K8S_NAMESPACE:=claude-agent}"
: "${K8S_STORAGE_SIZE:=20Gi}"
export IMAGE DATA_PATH K8S_NAMESPACE REPO_URL REPO_TOKEN GIT_PROVIDER SDKS K8S_STORAGE_CLASS K8S_SDK_ACCESS_MODE IMAGE_PULL_POLICY
SDKV="./scripts/sdk-volumes.sh"
SDK_LIST=".sdk-list"   # tespit edilen "isim sürüm" satırları (üretilir)

# Repo'nun SDK ihtiyacını tespit et → $SDK_LIST. Boş liste = SDK gerekmiyor.
sdk_detect() {
  if [[ "${SDKS:-}" == none ]]; then : > "$SDK_LIST"; info "SDK provizyonu kapalı (SDKS=none)"; return; fi
  info "Repo'nun SDK ihtiyacı tespit ediliyor…"
  if ! "$SDKV" detect > "$SDK_LIST.tmp"; then
    rm -f "$SDK_LIST.tmp"
    warn "SDK tespiti başarısız (ağ/token?). .env'e SDKS=flutter:3.24.3,jdk:17 gibi elle yaz ya da SDKS=none."
    die "Devam edilemiyor."
  fi
  mv "$SDK_LIST.tmp" "$SDK_LIST"
  if [[ -s "$SDK_LIST" ]]; then
    info "Gereken SDK'lar:"; sed 's/^/     • /' "$SDK_LIST"
  else
    info "Bu repo için ek SDK gerekmiyor (Node 22 + Python 3 imajda var)."
  fi
}

check_env() {
  local missing=()
  for v in CLAUDE_CODE_OAUTH_TOKEN TELEGRAM_BOT_TOKEN REPO_URL REPO_TOKEN; do
    [[ -n "${!v:-}" ]] || missing+=("$v")
  done
  ((${#missing[@]} == 0)) || die ".env'de eksik: ${missing[*]}"
  [[ "$REPO_URL" == https://* ]] || die "REPO_URL https:// ile başlamalı"
  [[ -n "${TELEGRAM_ALLOWED_USER_IDS:-}" ]] || warn "TELEGRAM_ALLOWED_USER_IDS boş: bot kimseye cevap vermez; bota /whoami yazıp id'ni öğren, .env'e ekle, ./up.sh restart"
}

# ============================================================================
#  DOCKER
# ============================================================================
docker_cmd() {
  command -v docker >/dev/null || die "docker bulunamadı"
  if docker compose version >/dev/null 2>&1; then echo "docker compose"
  elif command -v docker-compose >/dev/null; then echo "docker-compose"
  else echo ""; fi
}

docker_up() {
  check_env
  mkdir -p "$DATA_PATH"
  # container içindeki agent kullanıcısı uid 1000; bind mount yazılabilir olsun
  if [[ "$(stat -c %u "$DATA_PATH" 2>/dev/null || echo 1000)" != "1000" ]]; then
    chown 1000:1000 "$DATA_PATH" 2>/dev/null || sudo chown 1000:1000 "$DATA_PATH" 2>/dev/null || warn "$DATA_PATH sahipliği 1000'e çevrilemedi; izin hatası alırsan: sudo chown -R 1000:1000 $DATA_PATH"
  fi
  local dc; dc="$(docker_cmd)"
  info "İmaj build ediliyor…"
  docker build -t "$IMAGE" .

  # --- SDK volume'ları: tespit → yoksa kur → bağla ---
  sdk_detect
  "$SDKV" ensure "$SDK_LIST"
  "$SDKV" compose "$SDK_LIST" docker-compose.override.yml

  if [[ -n "$dc" ]]; then
    info "Başlatılıyor…"; $dc up -d
    info "Loglar: ./up.sh logs"
  else
    warn "compose yok; docker run ile başlatılıyor"
    local vols=()
    while read -r n v; do [[ -n "$n" ]] && vols+=(-v "sdk-$n-$v:/sdks/$n/$v"); done < "$SDK_LIST"
    docker rm -f claude-telegram-agent >/dev/null 2>&1 || true
    docker run -d --name claude-telegram-agent --restart unless-stopped \
      --env-file .env -e DATA_DIR=/data \
      -v "$(cd "$DATA_PATH" && pwd):/data" "${vols[@]}" \
      "$IMAGE"
  fi
  wait_healthy
}

# Container'ın gerçekten dinlemeye başlamasını bekle (en fazla 90 sn), sonucu söyle.
wait_healthy() {
  local _i
  for _i in $(seq 1 45); do
    if docker logs claude-telegram-agent 2>&1 | grep -q '\[bot\] @.* dinliyor'; then
      local bot; bot="$(docker logs claude-telegram-agent 2>&1 | grep -o '\[bot\] @[A-Za-z0-9_]* dinliyor' | tail -1 | sed 's/\[bot\] //; s/ dinliyor//')"
      info "Ajan ayakta: Telegram'da $bot sohbetine /status yaz."
      return 0
    fi
    if [[ "$(docker inspect -f '{{.State.Status}}' claude-telegram-agent 2>/dev/null)" == "exited" ]]; then break; fi
    sleep 2
  done
  warn "Bot henüz 'dinliyor' demedi. Son loglar:"
  docker logs --tail 30 claude-telegram-agent 2>&1 | sed 's/^/   /'
  warn "Takip: ./up.sh logs"
}

docker_action() {
  local dc; dc="$(docker_cmd)"
  case "$ACTION" in
    logs)    docker logs -f --tail 200 claude-telegram-agent ;;
    down)    if [[ -n "$dc" ]]; then $dc down; else docker rm -f claude-telegram-agent; fi ;;
    restart) docker restart claude-telegram-agent && docker logs -f --tail 50 claude-telegram-agent ;;
    shell)   docker exec -it claude-telegram-agent bash ;;
    status)  docker ps --filter name=claude-telegram-agent --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'
             docker exec claude-telegram-agent cat /data/state.json 2>/dev/null || true ;;
    sdk)     info "Host'taki SDK volume'ları:"; "$SDKV" list
             info "Container'da bağlı olanlar:"; docker exec claude-telegram-agent /app/scripts/sdk-env.sh --list 2>/dev/null || warn "container çalışmıyor"
             echo "   Silmek için: docker volume rm sdk-<isim>-<sürüm>" ;;
  esac
}

# ============================================================================
#  KUBERNETES
# ============================================================================
k8s_render() {
  local scl=""
  [[ -n "${K8S_STORAGE_CLASS:-}" ]] && scl="storageClassName: ${K8S_STORAGE_CLASS}"
  local pull="${IMAGE_PULL_POLICY:-IfNotPresent}"
  ((PUSH)) && pull=Always
  # SDK mount fragmanları (liste yoksa boş)
  local mf=".sdk-mounts.tmp" vf=".sdk-volumes.tmp"
  if [[ -s "$SDK_LIST" ]]; then "$SDKV" k8s-mounts "$SDK_LIST" "$mf" "$vf"; else : > "$mf"; : > "$vf"; fi
  sed -e "s|\${K8S_NAMESPACE}|${K8S_NAMESPACE}|g" \
      -e "s|\${K8S_STORAGE_SIZE}|${K8S_STORAGE_SIZE}|g" \
      -e "s|\${K8S_STORAGE_CLASS_LINE}|${scl}|g" \
      -e "s|\${IMAGE}|${IMAGE}|g" \
      -e "s|\${IMAGE_PULL_POLICY}|${pull}|g" \
      k8s/agent.yaml \
  | awk -v mf="$mf" -v vf="$vf" '
      function dump(f,  l) { while ((getline l < f) > 0) print l; close(f) }
      /^\$\{SDK_VOLUME_MOUNTS\}$/ { dump(mf); next }
      /^\$\{SDK_VOLUMES\}$/       { dump(vf); next }
      { print }'
  rm -f "$mf" "$vf"
}

k8s_up() {
  check_env
  command -v kubectl >/dev/null || die "kubectl bulunamadı"
  if ((BUILD)); then
    command -v docker >/dev/null || die "docker bulunamadı (build için)"
    info "İmaj build ediliyor: $IMAGE"; docker build -t "$IMAGE" .
    if ((PUSH)); then info "Push: $IMAGE"; docker push "$IMAGE"
    elif command -v kind >/dev/null && kind get clusters 2>/dev/null | grep -q .; then
      info "kind cluster'a yükleniyor"; kind load docker-image "$IMAGE"
    elif command -v minikube >/dev/null && minikube status >/dev/null 2>&1; then
      info "minikube'e yükleniyor"; minikube image load "$IMAGE"
    else
      warn "İmaj yerel; cluster bu imajı görebilmeli (docker-desktop/k3s tek node'da sorun olmaz). Uzak cluster için --push kullan."
    fi
  fi
  info "Namespace + Secret"
  kubectl create namespace "$K8S_NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

  # --- SDK PVC'leri: tespit (docker gerekir; yoksa SDKS elle) → yoksa Job ile kur → bağla ---
  if [[ -z "${SDKS:-}" ]] && ! command -v docker >/dev/null; then
    warn "docker yok: SDK tespiti yapılamıyor. .env'e SDKS=flutter:3.24.3,jdk:17 (ya da SDKS=none) yaz."
    die "SDKS gerekli."
  fi
  ((PUSH)) && export IMAGE_PULL_POLICY=Always
  sdk_detect
  "$SDKV" k8s-ensure "$SDK_LIST"
  # .env'deki her şey secret'a girer (yorum/boş satırlar hariç); k8s-özel anahtarlar zararsız
  grep -Ev '^\s*(#|$)' .env | sed -E 's/^export //' > .env.k8s.tmp
  kubectl -n "$K8S_NAMESPACE" create secret generic claude-agent-env \
    --from-env-file=.env.k8s.tmp --dry-run=client -o yaml | kubectl apply -f -
  rm -f .env.k8s.tmp
  info "Manifest uygulanıyor"
  k8s_render | kubectl apply -f -
  kubectl -n "$K8S_NAMESPACE" rollout restart deployment/claude-agent >/dev/null 2>&1 || true
  kubectl -n "$K8S_NAMESPACE" rollout status deployment/claude-agent --timeout=300s
  info "Ajan ayakta. Loglar: ./up.sh logs --k8s"
}

k8s_action() {
  case "$ACTION" in
    logs)    kubectl -n "$K8S_NAMESPACE" logs -f --tail 200 deployment/claude-agent ;;
    down)    k8s_render | kubectl delete -f - --ignore-not-found
             kubectl -n "$K8S_NAMESPACE" delete secret claude-agent-env --ignore-not-found
             warn "PVC (repo, SDK'lar, oturumlar) silinmedi: kubectl -n $K8S_NAMESPACE delete pvc claude-agent-data" ;;
    restart) kubectl -n "$K8S_NAMESPACE" rollout restart deployment/claude-agent
             kubectl -n "$K8S_NAMESPACE" rollout status deployment/claude-agent ;;
    shell)   kubectl -n "$K8S_NAMESPACE" exec -it deployment/claude-agent -- bash ;;
    status)  kubectl -n "$K8S_NAMESPACE" get pods,pvc -l app=claude-agent 2>/dev/null || kubectl -n "$K8S_NAMESPACE" get pods,pvc
             kubectl -n "$K8S_NAMESPACE" exec deployment/claude-agent -- cat /data/state.json 2>/dev/null || true ;;
    sdk)     info "SDK PVC'leri:"; kubectl -n "$K8S_NAMESPACE" get pvc -l app=claude-agent-sdk -o custom-columns='NAME:.metadata.name,SDK:.metadata.labels.sdk,VERSION:.metadata.labels.version,INSTALLED:.metadata.annotations.claude-agent/installed,SIZE:.spec.resources.requests.storage'
             info "Container'da bağlı olanlar:"; kubectl -n "$K8S_NAMESPACE" exec deployment/claude-agent -- /app/scripts/sdk-env.sh --list 2>/dev/null || true
             echo "   Silmek için: kubectl -n $K8S_NAMESPACE delete pvc sdk-<isim>-<sürüm>" ;;
  esac
}

# ---------- dispatch ----------
case "$MODE:$ACTION" in
  k8s:up)    k8s_up ;;
  k8s:*)     k8s_action ;;
  docker:up) docker_up ;;
  docker:*)  docker_action ;;
esac
