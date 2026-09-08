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

# ---------- 0) Repo'da .sdks varsa tek kaynak odur (tahmin yok) ----------
#   # yorum satırı
#   flutter 3.24.5      (ya da flutter:3.24.5 / flutter=3.24.5)
#   jdk 17
#   android 34
#   Aynı içerik CLAUDE.md içinde ```sdks … ``` bloğu olarak da verilebilir (tek dosya "karakter" yaklaşımı).
SDKS_FILE=""; SDKS_TEXT=""
for f in .sdks sdks.txt .sdk-versions; do [[ -f "$f" ]] && { SDKS_FILE="$f"; break; }; done
if [[ -n "$SDKS_FILE" ]]; then
  SDKS_TEXT="$(cat "$SDKS_FILE")"
elif [[ -f CLAUDE.md ]] && grep -q '^```sdks' CLAUDE.md; then
  SDKS_FILE="CLAUDE.md (sdks bloğu)"
  SDKS_TEXT="$(awk '/^```sdks/{f=1;next} /^```/{f=0} f' CLAUDE.md)"
fi
if [[ -n "$SDKS_TEXT" ]] && ! grep -qE '<[^>]*>' <<<"$SDKS_TEXT"; then   # "<3.x.y>" gibi doldurulmamış şablon → yok say
  echo "# kaynak: $SDKS_FILE" >&2
  sed -E 's/#.*//; s/[[:space:]]+/ /g; s/^ //; s/ $//; s/[:=]/ /' <<<"$SDKS_TEXT" | grep -v '^$' | while read -r n v; do
    if (( RAW )); then echo "$n ${v:-stable}"; else echo "$n $(resolve_version "$n" "${v:-}")"; fi
  done
  exit 0
elif [[ -n "$SDKS_TEXT" ]]; then
  echo "# UYARI: $SDKS_FILE içinde doldurulmamış <…> sürüm var, yok sayıldı" >&2
fi
echo "# kaynak: tahmin (repoda .sdks / CLAUDE.md sdks bloğu yok)" >&2

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
    # Öncelik: FLUTTER_VERSION env (sihirbaz / .env) > .fvmrc > fvm_config > .tool-versions
    #          > pubspec.yaml environment.sdk Dart alt sınırı (projenin doğduğu sürüm) > pubspec.lock > stable
    v="${FLUTTER_VERSION:-}"
    [[ -z "$v" ]] && v="$(grep -oE '"flutter"[[:space:]]*:[[:space:]]*"[^"]+"' .fvmrc 2>/dev/null | grep -oE '"[^"]+"$' | tr -d '"' || true)"
    [[ -z "$v" ]] && v="$(grep -oE '"flutterSdkVersion"[[:space:]]*:[[:space:]]*"[^"]+"' .fvm/fvm_config.json 2>/dev/null | grep -oE '"[^"]+"$' | tr -d '"' || true)"
    [[ -z "$v" ]] && v="$(tool_versions flutter)"
    if [[ -z "$v" ]]; then
      # environment:\n  sdk: ^3.5.4  |  sdk: ">=3.5.4 <4.0.0"  |  sdk: '>=3.5.4 <4.0.0'
      dart_lo="$(awk '/^environment:/{f=1;next} f&&/^[^ ]/{f=0} f&&/^[ \t]+sdk:/{print; exit}' pubspec.yaml | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
      [[ -z "$dart_lo" ]] && dart_lo="$(awk '/^sdks:/{f=1;next} f&&/^[ \t]+dart:/{print; exit}' pubspec.lock 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
      [[ -n "$dart_lo" ]] && v="dart:$dart_lo"
    fi
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
  jdk="${JDK_VERSION:-}"
  [[ -z "$jdk" ]] && jdk="$(tool_versions java)"; [[ -z "$jdk" ]] && jdk="$(rd .java-version | tr -d '[:space:]')"
  if [[ -z "$jdk" ]]; then
    # Gradle wrapper + AGP sürümünden JDK: Gradle < 7.3 ya da AGP < 7.2 → 11; aksi halde 17 (AGP 8.x/Gradle 8.x ile uyumlu)
    gw="$(grep -oE 'gradle-[0-9]+\.[0-9]+(\.[0-9]+)?' "$android_root"/gradle/wrapper/gradle-wrapper.properties 2>/dev/null | head -1 | sed 's/gradle-//' || true)"
    agp="$(grep -rhoE 'com\.android\.(application|library|tools\.build:gradle)[^0-9]*[0-9]+\.[0-9]+(\.[0-9]+)?' "$android_root"/settings.gradle* "$android_root"/build.gradle* 2>/dev/null | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?$' | sort -V | tail -1 || true)"
    if [[ -n "$gw" ]] && [[ "$(printf '%s\n' "$gw" 7.3 | sort -V | head -1)" != 7.3 ]]; then jdk=11
    elif [[ -n "$agp" ]] && [[ "$(printf '%s\n' "$agp" 7.2 | sort -V | head -1)" != 7.2 ]]; then jdk=11
    fi
  fi
  if [[ -z "$jdk" ]]; then
    jt="$(grep -rhoE '(jvmTarget|sourceCompatibility|targetCompatibility)\s*[=:]?\s*(JavaVersion\.VERSION_)?["'"'"']?[0-9_]+' "$android_root"/app/build.gradle* 2>/dev/null | grep -oE '[0-9]+(_[0-9]+)?$' | sed 's/^1_//' | sort -n | tail -1 || true)"
    jdk="${jt:-17}"; (( ${jdk%%.*} < 17 )) && jdk=17   # AGP 8+ → JDK 17 şart
  fi
  need jdk "${jdk%%.*}"
  need android "${ANDROID_API:-${compile:-35}}"
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
