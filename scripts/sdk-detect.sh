#!/usr/bin/env bash
# Repo'yu tarar, ihtiyaç duyulan SDK'ları "isim sürüm" satırları olarak basar.
#   sdk-detect.sh <repo-dir> [--raw]     (--raw: sürümü ağdan çözümleme, istenen haliyle bas)
# Çıktı örneği:
#   jdk 17
#   android 34
#   flutter 3.24.3
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/sdk-lib.sh"

REPO="${1:?repo dizini}"; RAW=0; [[ "${2:-}" == --raw ]] && RAW=1
cd "$REPO"

declare -A WANT=()
need() { [[ -n "${WANT[$1]:-}" ]] || WANT[$1]="$2"; }   # ilk bulunan kazanır
has()  { [[ -e "$1" ]]; }
rd()   { cat "$1" 2>/dev/null || true; }

tool_versions() {  # .tool-versions / asdf → "flutter 3.24.3-stable" → 3.24.3
  if has .tool-versions; then
    awk -v k="$1" '$1==k{print $2}' .tool-versions | sed -E 's/-stable$//; s/^temurin-//; s/^v//' | head -1
  fi
  return 0
}

# ---------- Flutter / Dart ----------
if has pubspec.yaml; then
  if grep -qE '^\s+sdk:\s*flutter\s*$|^\s+flutter:\s*$' pubspec.yaml; then
    v="$(jq -r '.flutter // empty' .fvmrc 2>/dev/null || true)"
    [[ -z "$v" ]] && v="$(jq -r '.flutterSdkVersion // empty' .fvm/fvm_config.json 2>/dev/null || true)"
    [[ -z "$v" ]] && v="$(tool_versions flutter)"
    need flutter "${v:-stable}"
  else
    v="$(tool_versions dart)"
    need dart "${v:-stable}"
  fi
fi

# ---------- Android (Flutter android/ ya da native Kotlin/Java) ----------
android_root=""
if has android/build.gradle || has android/build.gradle.kts || has android/settings.gradle || has android/settings.gradle.kts || has android/app/build.gradle || has android/app/build.gradle.kts; then
  android_root=android
elif has settings.gradle || has settings.gradle.kts || has build.gradle || has build.gradle.kts; then
  grep -qsE 'com\.android\.(application|library)' settings.gradle* build.gradle* app/build.gradle* 2>/dev/null && android_root=.
fi
if [[ -n "$android_root" ]]; then
  compile="$(grep -rhoE 'compileSdk(Version)?\s*[=(]?\s*[0-9]+' "$android_root"/app/build.gradle* "$android_root"/build.gradle* 2>/dev/null | grep -oE '[0-9]+$' | sort -n | tail -1 || true)"
  jdk="$(tool_versions java)"; [[ -z "$jdk" ]] && jdk="$(rd .java-version | tr -d '[:space:]')"
  if [[ -z "$jdk" ]]; then
    jt="$(grep -rhoE '(jvmTarget|sourceCompatibility|targetCompatibility)\s*[=:]?\s*(JavaVersion\.VERSION_)?["'"'"']?[0-9_]+' "$android_root"/app/build.gradle* 2>/dev/null | grep -oE '[0-9]+(_[0-9]+)?$' | sed 's/^1_//' | sort -n | tail -1 || true)"
    jdk="${jt:-17}"; (( ${jdk%%.*} < 17 )) && jdk=17   # AGP 8+ → JDK 17 şart
  fi
  need jdk "${jdk%%.*}"
  need android "${compile:-35}"
fi

# ---------- Go ----------
if has go.mod; then
  v="$(awk '/^toolchain go/{print $2; exit}' go.mod | sed 's/^go//')"
  [[ -z "$v" ]] && v="$(awk '/^go /{print $2; exit}' go.mod)"
  [[ -z "$v" ]] && v="$(tool_versions golang)"
  need go "${v:-latest}"
fi

# ---------- Node (imajda 22 var; farklı major istenirse) ----------
if has package.json; then
  v="$(rd .nvmrc | tr -d '[:space:]v')"; [[ -z "$v" ]] && v="$(rd .node-version | tr -d '[:space:]v')"
  [[ -z "$v" ]] && v="$(tool_versions nodejs)"
  [[ -z "$v" ]] && v="$(jq -r '.engines.node // empty' package.json 2>/dev/null | grep -oE '[0-9]+(\.[0-9]+)*' | head -1 || true)"
  if [[ -n "$v" && "${v%%.*}" != "22" ]]; then need node "$v"; fi
fi

# ---------- Rust ----------
if has Cargo.toml; then
  v=""
  has rust-toolchain.toml && v="$(grep -oE 'channel\s*=\s*"[^"]+"' rust-toolchain.toml | grep -oE '"[^"]+"' | tr -d '"')"
  [[ -z "$v" && -f rust-toolchain ]] && v="$(rd rust-toolchain | tr -d '[:space:]')"
  [[ -z "$v" ]] && v="$(tool_versions rust)"
  need rust "${v:-stable}"
fi

# ---------- çıktı (kurulum sırasına göre) ----------
for n in "${SDK_NAMES[@]}"; do
  [[ -n "${WANT[$n]:-}" ]] || continue
  if (( RAW )); then echo "$n ${WANT[$n]}"; else echo "$n $(resolve_version "$n" "${WANT[$n]}")"; fi
done
