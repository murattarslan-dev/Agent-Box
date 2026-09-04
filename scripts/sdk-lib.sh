#!/usr/bin/env bash
# Ortak yardımcılar: mimari, sürüm çözümleme, volume adı.
# Kaynak olarak yüklenir: source "$(dirname "$0")/sdk-lib.sh"

sdk_log()  { printf '[sdk] %s\n' "$*" >&2; }
sdk_warn() { printf '[sdk] UYARI: %s\n' "$*" >&2; }
sdk_die()  { printf '[sdk] HATA: %s\n' "$*" >&2; exit 1; }

# Desteklenen SDK adları (sıra = kurulum sırası; android jdk'ya bağımlı)
# shellcheck disable=SC2034  # sdk-detect.sh kullanır
SDK_NAMES=(jdk android flutter dart go node rust)

sdk_arch() {           # x64 | arm64
  case "$(uname -m)" in
    x86_64|amd64) echo x64 ;;
    aarch64|arm64) echo arm64 ;;
    *) sdk_die "desteklenmeyen mimari: $(uname -m)" ;;
  esac
}

# Volume adı: sdk-<name>-<version>  (docker); k8s'te nokta → tire (sdk_k8s_name)
sdk_vol_name() { printf 'sdk-%s-%s' "$1" "$2"; }
sdk_k8s_name() { printf 'sdk-%s-%s' "$1" "$2" | tr '.+_' '---' | tr '[:upper:]' '[:lower:]'; }
sdk_mount_path() { printf '/sdks/%s/%s' "$1" "$2"; }

_fetch() { curl -fsSL --retry 2 --max-time 20 "$@"; }   # küçük metadata istekleri

# Büyük dosya indirme: zaman sınırı yok; 60 sn boyunca 1 KB/s altına düşerse (takılma) keser,
# 10 sn sonra kaldığı yerden (-C -) devam eder; en fazla 8 deneme.
_download() {  # url out
  local url="$1" out="$2" i
  for i in 1 2 3 4 5 6 7 8; do
    if curl -fL --connect-timeout 30 --speed-time 60 --speed-limit 1000 -C - -o "$out" "$url"; then return 0; fi
    sdk_warn "indirme kesildi ($i/8), 10 sn sonra kaldığı yerden devam: $(basename "$out")"; sleep 10
  done
  sdk_die "indirilemedi: $url"
}

# ---- sürüm çözümleyiciler: "stable"/"latest"/kısmi sürümü sabit sürüme çevirir ----
# Ağ yoksa girdiyi olduğu gibi döndürür (volume adı yine deterministik kalır).

resolve_flutter() {   # stable | 3.24 | 3.24.3
  local want="$1" json
  [[ "$want" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]] && { echo "$want"; return; }
  json="$(_fetch https://storage.googleapis.com/flutter_infra_release/releases/releases_linux.json 2>/dev/null)" || { echo "$want"; return; }
  if [[ "$want" == stable || "$want" == latest ]]; then
    echo "$json" | jq -r '.current_release.stable as $h | .releases[] | select(.hash==$h) | .version' | head -1
  else  # 3.24 → en yeni 3.24.x stable
    echo "$json" | jq -r --arg p "$want." '[.releases[] | select(.channel=="stable" and (.version|startswith($p)))][0].version // $p' | sed 's/\.$//'
  fi
}

resolve_dart() {      # stable | 3.5 | 3.5.4
  local want="$1" latest
  [[ "$want" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && { echo "$want"; return; }
  latest="$(_fetch https://storage.googleapis.com/dart-archive/channels/stable/release/latest/VERSION 2>/dev/null | jq -r .version)" || latest=""
  [[ -z "$latest" ]] && { echo "$want"; return; }
  if [[ "$want" == stable || "$want" == latest ]]; then echo "$latest"
  elif [[ "$latest" == "$want".* ]]; then echo "$latest"
  else echo "$want.0"; fi
}

resolve_go() {        # latest | 1.22 | 1.22.5
  local want="$1" json
  [[ "$want" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && { echo "$want"; return; }
  json="$(_fetch 'https://go.dev/dl/?mode=json&include=all' 2>/dev/null)" || { echo "$want"; return; }
  if [[ "$want" == latest || "$want" == stable ]]; then
    echo "$json" | jq -r '[.[] | select(.stable)][0].version' | sed 's/^go//'
  else
    echo "$json" | jq -r --arg p "go$want." '[.[] | select(.version|startswith($p))][0].version // ("go"+$p+"0")' | sed 's/^go//; s/\.0$/.0/'
  fi
}

resolve_node() {      # 20 | 20.11 | 20.11.1 | lts
  local want="$1" json
  [[ "$want" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && { echo "$want"; return; }
  json="$(_fetch https://nodejs.org/dist/index.json 2>/dev/null)" || { echo "$want"; return; }
  if [[ "$want" == lts || "$want" == latest ]]; then
    echo "$json" | jq -r '[.[] | select(.lts!=false)][0].version' | sed 's/^v//'
  else
    echo "$json" | jq -r --arg p "v$want." '[.[] | select(.version|startswith($p))][0].version // ("v"+$p)' | sed 's/^v//'
  fi
}

resolve_jdk() {       # 17 | 21  (major; Temurin GA)
  echo "${1%%.*}"
}

resolve_android() {   # compileSdk: 34 | 35
  echo "${1%%.*}"
}

resolve_rust() {      # stable | 1.80 | 1.80.1
  local want="$1" v
  [[ "$want" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && { echo "$want"; return; }
  if [[ "$want" == stable || "$want" == latest ]]; then
    v="$(_fetch https://static.rust-lang.org/dist/channel-rust-stable.toml 2>/dev/null | awk '/^\[pkg.rust\]/{f=1} f&&/^version/{print $3; exit}' | tr -d '"' | cut -d' ' -f1)"
    echo "${v:-$want}"
  else
    echo "$want"
  fi
}

resolve_version() {   # name want → version
  local name="$1" want="${2:-}"
  case "$name" in
    flutter) resolve_flutter "${want:-stable}" ;;
    dart)    resolve_dart "${want:-stable}" ;;
    go)      resolve_go "${want:-latest}" ;;
    node)    resolve_node "${want:-lts}" ;;
    jdk)     resolve_jdk "${want:-17}" ;;
    android) resolve_android "${want:-35}" ;;
    rust)    resolve_rust "${want:-stable}" ;;
    *) sdk_die "bilinmeyen sdk: $name" ;;
  esac
}
