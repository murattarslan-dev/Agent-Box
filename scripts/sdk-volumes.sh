#!/usr/bin/env bash
# HOST tarafı: SDK volume'larını (sdk-<isim>-<sürüm>) tespit et / oluştur / bağla.
# up.sh tarafından çağrılır; tek başına da kullanılabilir.
#
#   sdk-volumes.sh detect                 → "isim sürüm" satırları (SDKS env override'ı uygular)
#   sdk-volumes.sh ensure  <list-file>    → docker: her satır için volume yoksa oluştur + kur
#   sdk-volumes.sh compose <list-file>    → docker-compose.override.yml yaz
#   sdk-volumes.sh k8s-ensure <list-file> → k8s: PVC + install Job (yoksa) ; annotasyonla işaretle
#   sdk-volumes.sh k8s-mounts <list-file> <mounts-out> <volumes-out> → Deployment fragmanları
#   sdk-volumes.sh list                   → docker volume'ları
#
# Gerekli env: IMAGE, DATA_PATH, REPO_URL, REPO_TOKEN, (GIT_PROVIDER), (SDKS), K8S_NAMESPACE …
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/sdk-lib.sh"

: "${IMAGE:=claude-telegram-agent:latest}"
: "${DATA_PATH:=./data}"
: "${K8S_NAMESPACE:=claude-agent}"
: "${K8S_SDK_ACCESS_MODE:=ReadWriteOnce}"

sdk_size() {  # k8s PVC boyutu
  case "$1" in flutter|android) echo "${K8S_SDK_SIZE_BIG:-10Gi}" ;; rust) echo 4Gi ;; *) echo 2Gi ;; esac
}

# ---------------- detect ----------------
cmd_detect() {
  if [[ -n "${SDKS:-}" ]]; then
    [[ "$SDKS" == none ]] && return 0
    # "flutter:3.24.3,jdk:17,android"  → satırlar (sürüm boşsa çözümle)
    tr ',' '\n' <<<"$SDKS" | sed 's/^ *//; s/ *$//' | grep -v '^$' | while IFS=: read -r n v; do
      echo "$n $(resolve_version "$n" "${v:-}")"
    done
    return 0
  fi
  local repo_mount=()
  [[ -d "$DATA_PATH/repo/.git" ]] && repo_mount=(-v "$(cd "$DATA_PATH/repo" && pwd):/repo:ro")
  docker run --rm "${repo_mount[@]}" \
    -e REPO_URL -e REPO_TOKEN -e GIT_PROVIDER \
    --entrypoint /app/scripts/sdk-detect-remote.sh "$IMAGE"
}

# ---------------- docker ----------------
vol_installed() {  # vol name ver → 0 kuruluysa
  docker volume inspect "$1" >/dev/null 2>&1 || return 1
  local got
  got="$(docker run --rm -v "$1:/x:ro" --entrypoint sh "$IMAGE" -c 'cat /x/.installed 2>/dev/null' || true)"
  [[ "$got" == "$2" ]]
}

extra_mounts_for() {  # android için jdk volume'unu da bağla
  local name="$1" list="$2"
  if [[ "$name" == android ]]; then
    local jv; jv="$(awk '$1=="jdk"{print $2}' "$list" | head -1)"
    [[ -n "$jv" ]] && echo "-v $(sdk_vol_name jdk "$jv"):$(sdk_mount_path jdk "$jv"):ro"
  fi
}

cmd_ensure() {
  local list="$1" name ver vol mp
  while read -r name ver; do
    [[ -n "$name" ]] || continue
    vol="$(sdk_vol_name "$name" "$ver")"; mp="$(sdk_mount_path "$name" "$ver")"
    if vol_installed "$vol" "$ver"; then sdk_log "✓ $vol mevcut"; continue; fi
    docker volume inspect "$vol" >/dev/null 2>&1 || { docker volume create "$vol" >/dev/null; sdk_log "+ volume oluşturuldu: $vol"; }
    # container'ın kendi /data/sdks'inde zaten kuruluysa kopyala (yeniden indirme yok)
    local priv="$DATA_PATH/sdks/$name/$ver"
    if [[ -f "$priv/.installed" && "$(cat "$priv/.installed")" == "$ver" ]]; then
      sdk_log "↑ $priv → $vol kopyalanıyor (terfi)"
      docker run --rm --user root -v "$(cd "$priv" && pwd):/src:ro" -v "$vol:/dst" --entrypoint sh "$IMAGE" \
        -c 'cp -a /src/. /dst/ && chown -R 1000:1000 /dst'
      continue
    fi
    sdk_log "⬇ $name $ver kuruluyor → $vol (bir kere; sonraki container'lar hazır bulur)"
    # shellcheck disable=SC2046
    docker run --rm $([[ -t 1 ]] && echo -t) --user root -v "$vol:$mp" $(extra_mounts_for "$name" "$list") \
      -e SDK_HOME=/tmp/sdk-private \
      --entrypoint /app/scripts/sdk-install.sh "$IMAGE" "$name" "$ver" "$mp"
  done < "$list"
}

cmd_compose() {
  local list="$1" out="${2:-docker-compose.override.yml}" name ver vol mp
  if [[ ! -s "$list" ]]; then
    printf '# OTOMATİK ÜRETİLDİ: SDK volume gerekmiyor\nservices: {}\n' > "$out"; sdk_log "$out yazıldı (boş)"; return
  fi
  {
    echo "# OTOMATİK ÜRETİLDİ: up.sh → sdk-volumes.sh compose  (elle düzenleme)"
    echo "services:"
    echo "  agent:"
    echo "    volumes:"
    while read -r name ver; do [[ -n "$name" ]] || continue
      echo "      - $(sdk_vol_name "$name" "$ver"):$(sdk_mount_path "$name" "$ver")"
    done < "$list"
    echo "volumes:"
    while read -r name ver; do [[ -n "$name" ]] || continue
      echo "  $(sdk_vol_name "$name" "$ver"):"
      echo "    external: true"
    done < "$list"
  } > "$out"
  sdk_log "$out yazıldı"
}

cmd_list() {
  docker volume ls --filter name='^sdk-' --format '{{.Name}}' | while read -r v; do
    printf '%-28s %s\n' "$v" "$(docker run --rm -v "$v:/x:ro" --entrypoint sh "$IMAGE" -c 'cat /x/.meta 2>/dev/null | tr "\n" " "' || echo '?')"
  done
}

# ---------------- kubernetes ----------------
k8s_pvc_yaml() {
  local name="$1" ver="$2" n; n="$(sdk_k8s_name "$name" "$ver")"
  local scl=""; [[ -n "${K8S_STORAGE_CLASS:-}" ]] && scl="  storageClassName: ${K8S_STORAGE_CLASS}"
  cat <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: $n
  namespace: $K8S_NAMESPACE
  labels: { app: claude-agent-sdk, sdk: "$name", version: "$ver" }
spec:
  accessModes: ["$K8S_SDK_ACCESS_MODE"]
$scl
  resources: { requests: { storage: $(sdk_size "$name") } }
EOF
}

k8s_job_yaml() {
  local name="$1" ver="$2" list="$3" n; n="$(sdk_k8s_name "$name" "$ver")"
  local mp; mp="$(sdk_mount_path "$name" "$ver")"
  local extra_m="" extra_v=""
  if [[ "$name" == android ]]; then
    local jv; jv="$(awk '$1=="jdk"{print $2}' "$list" | head -1)"
    if [[ -n "$jv" ]]; then
      extra_m="            - { name: jdk, mountPath: $(sdk_mount_path jdk "$jv"), readOnly: true }"
      extra_v="        - { name: jdk, persistentVolumeClaim: { claimName: $(sdk_k8s_name jdk "$jv") } }"
    fi
  fi
  cat <<EOF
apiVersion: batch/v1
kind: Job
metadata:
  name: install-$n
  namespace: $K8S_NAMESPACE
spec:
  backoffLimit: 1
  ttlSecondsAfterFinished: 3600
  template:
    spec:
      restartPolicy: Never
      securityContext: { fsGroup: 1000 }
      containers:
        - name: install
          image: ${IMAGE}
          imagePullPolicy: ${IMAGE_PULL_POLICY:-IfNotPresent}
          command: ["/app/scripts/sdk-install.sh", "$name", "$ver", "$mp"]
          env: [{ name: SDK_HOME, value: /tmp/sdk-private }]
          resources: { requests: { cpu: "500m", memory: "1Gi" }, limits: { memory: "4Gi" } }
          volumeMounts:
            - { name: sdk, mountPath: $mp }
$extra_m
      volumes:
        - { name: sdk, persistentVolumeClaim: { claimName: $n } }
$extra_v
EOF
}

cmd_k8s_ensure() {
  local list="$1" name ver n ann
  while read -r name ver; do [[ -n "$name" ]] || continue
    n="$(sdk_k8s_name "$name" "$ver")"
    ann="$(kubectl -n "$K8S_NAMESPACE" get pvc "$n" -o jsonpath='{.metadata.annotations.claude-agent/installed}' 2>/dev/null || true)"
    if [[ "$ann" == "$ver" ]]; then sdk_log "✓ PVC $n kurulu"; continue; fi
    k8s_pvc_yaml "$name" "$ver" | kubectl apply -f - >/dev/null
    kubectl -n "$K8S_NAMESPACE" delete job "install-$n" --ignore-not-found >/dev/null 2>&1 || true
    sdk_log "⬇ $name $ver kuruluyor (Job install-$n)…"
    k8s_job_yaml "$name" "$ver" "$list" | kubectl apply -f - >/dev/null
    if kubectl -n "$K8S_NAMESPACE" wait --for=condition=complete "job/install-$n" --timeout="${K8S_SDK_INSTALL_TIMEOUT:-45m}"; then
      kubectl -n "$K8S_NAMESPACE" annotate pvc "$n" "claude-agent/installed=$ver" --overwrite >/dev/null
      sdk_log "✓ $n hazır"
    else
      kubectl -n "$K8S_NAMESPACE" logs "job/install-$n" --tail 40 || true
      sdk_die "$name $ver kurulumu başarısız (job install-$n)"
    fi
  done < "$list"
}

cmd_k8s_mounts() {
  local list="$1" mounts_out="$2" vols_out="$3" name ver n
  : > "$mounts_out"; : > "$vols_out"
  while read -r name ver; do [[ -n "$name" ]] || continue
    n="$(sdk_k8s_name "$name" "$ver")"
    echo "            - { name: $n, mountPath: $(sdk_mount_path "$name" "$ver") }" >> "$mounts_out"
    echo "        - { name: $n, persistentVolumeClaim: { claimName: $n } }" >> "$vols_out"
  done < "$list"
}

case "${1:-}" in
  detect)      cmd_detect ;;
  ensure)      cmd_ensure "$2" ;;
  compose)     cmd_compose "$2" "${3:-}" ;;
  list)        cmd_list ;;
  k8s-ensure)  cmd_k8s_ensure "$2" ;;
  k8s-mounts)  cmd_k8s_mounts "$2" "$3" "$4" ;;
  *) sed -n '2,13p' "$0"; exit 2 ;;
esac
