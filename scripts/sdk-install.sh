#!/usr/bin/env bash
# Tek bir SDK'yı hedef dizine kurar (idempotent) ve yanına yeniden konumlanabilir bir env.sh yazar.
#   sdk-install.sh <name> <version> [target-dir]
#   name ∈ jdk android flutter dart go node rust ; target varsayılan /sdks/<name>/<version>
# Hedef bir docker volume / PVC mount'u olabilir; root ile çağrılırsa sahipliği 'agent'a verip
# kendini agent olarak yeniden çalıştırır (Flutter root'ta çalışmaz).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/sdk-lib.sh"

NAME="${1:?sdk adı}"; VER="${2:?sürüm}"; T="${3:-}"
ARCH="$(sdk_arch)"
# Hedef verilmediyse: /sdks/<isim>/<sürüm> bir mount ise (volume) oraya, değilse container'a özel $SDK_HOME'a
if [[ -z "$T" ]]; then
  T="$(sdk_mount_path "$NAME" "$VER")"
  if ! mountpoint -q "$T" 2>/dev/null; then T="${SDK_HOME:-/data/sdks}/$NAME/$VER"; fi
fi

# ---- root → agent ----
if [[ "$(id -u)" == 0 ]]; then
  mkdir -p "$T"
  if id agent >/dev/null 2>&1; then
    chown -R agent:agent "$T"
    exec sudo -u agent -H -E "$0" "$NAME" "$VER" "$T"
  else
    sdk_warn "agent kullanıcısı yok; root ile devam"
  fi
fi
mkdir -p "$T"
[[ -w "$T" ]] || sdk_die "$T yazılabilir değil ($(id -un))"

if [[ -f "$T/.installed" && "$(cat "$T/.installed")" == "$VER" && -f "$T/env.sh" ]]; then
  sdk_log "$NAME $VER zaten kurulu: $T"
  exit 0
fi
sdk_log "$NAME $VER kuruluyor → $T (arch=$ARCH)"
rm -f "$T/.installed"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export HOME="${HOME:-/home/agent}"
PRIVATE="${SDK_HOME:-/data/sdks}"   # paylaşımlı volume'u kirletmemek için cache'ler buraya

write_env() {  # stdin → $T/env.sh (başına SDK_DIR tanımı eklenir)
  { echo '# otomatik üretildi: sdk-install.sh'; echo "# $NAME $VER ($(date -u +%F))";
    echo 'SDK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"'; cat; } > "$T/env.sh"
}

case "$NAME" in
  # ---------------- JDK (Temurin) ----------------
  jdk)
    A=$ARCH; [[ "$A" == arm64 ]] && A=aarch64
    _download "https://api.adoptium.net/v3/binary/latest/${VER}/ga/linux/${A}/jdk/hotspot/normal/eclipse" "$TMP/jdk.tgz"
    rm -rf "$T/jdk"; mkdir -p "$T/jdk"
    tar -xzf "$TMP/jdk.tgz" -C "$T/jdk" --strip-components=1
    "$T/jdk/bin/java" -version
    write_env <<'EOF'
export JAVA_HOME="$SDK_DIR/jdk"
export PATH="$JAVA_HOME/bin:$PATH"
EOF
    ;;

  # ---------------- Android SDK ----------------
  android)
    # Java bul: JAVA_HOME → mount edilmiş jdk volume'u → private jdk → sistem
    if [[ -z "${JAVA_HOME:-}" || ! -x "${JAVA_HOME}/bin/java" ]]; then
      for d in /sdks/jdk/*/jdk "$PRIVATE"/jdk/*/jdk; do [[ -x "$d/bin/java" ]] && { export JAVA_HOME="$d"; break; }; done
    fi
    [[ -x "${JAVA_HOME:-/nonexistent}/bin/java" ]] || sdk_die "Android SDK için JDK gerekli; önce 'sdk-install.sh jdk 17' (ya da jdk volume'unu bağla)"
    export PATH="$JAVA_HOME/bin:$PATH"
    CLT_ID="${ANDROID_CMDLINE_TOOLS_ID:-11076708}"
    _download "https://dl.google.com/android/repository/commandlinetools-linux-${CLT_ID}_latest.zip" "$TMP/clt.zip"
    rm -rf "$T/cmdline-tools"; mkdir -p "$T/cmdline-tools"
    unzip -q "$TMP/clt.zip" -d "$TMP/clt"
    mv "$TMP/clt/cmdline-tools" "$T/cmdline-tools/latest"
    SDKM="$T/cmdline-tools/latest/bin/sdkmanager"
    yes | "$SDKM" --sdk_root="$T" --licenses >/dev/null 2>&1 || true
    BT="$(printf '%s' "$VER" | grep -oE '^[0-9]+').0.0"
    "$SDKM" --sdk_root="$T" "platform-tools" "platforms;android-${VER}" "build-tools;${BT}" | tail -5
    write_env <<'EOF'
export ANDROID_HOME="$SDK_DIR"
export ANDROID_SDK_ROOT="$SDK_DIR"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
EOF
    ;;

  # ---------------- Flutter ----------------
  flutter)
    export PUB_CACHE="${PUB_CACHE:-$PRIVATE/pub-cache}"; mkdir -p "$PUB_CACHE" 2>/dev/null || export PUB_CACHE="$T/pub-cache"
    rm -rf "$T/flutter"
    git clone --depth 1 -b "$VER" https://github.com/flutter/flutter.git "$T/flutter" 2>&1 | tail -2
    git config --global --add safe.directory "$T/flutter" || true
    F="$T/flutter/bin/flutter"
    "$F" --version
    "$F" config --no-analytics --enable-android --enable-linux-desktop >/dev/null 2>&1 || true
    "$F" precache --android --linux --no-ios --no-web --no-macos --no-windows 2>&1 | tail -3 || sdk_warn "precache tamamlanamadı (ilk build'de iner)"
    write_env <<'EOF'
export FLUTTER_ROOT="$SDK_DIR/flutter"
export PATH="$FLUTTER_ROOT/bin:$FLUTTER_ROOT/bin/cache/dart-sdk/bin:$PATH"
export PUB_CACHE="${PUB_CACHE:-/data/sdks/pub-cache}"
EOF
    ;;

  # ---------------- Dart ----------------
  dart)
    _download "https://storage.googleapis.com/dart-archive/channels/stable/release/${VER}/sdk/dartsdk-linux-${ARCH}-release.zip" "$TMP/dart.zip"
    rm -rf "$T/dart-sdk"; unzip -q "$TMP/dart.zip" -d "$T"
    "$T/dart-sdk/bin/dart" --version
    write_env <<'EOF'
export DART_SDK="$SDK_DIR/dart-sdk"
export PATH="$DART_SDK/bin:$PATH"
export PUB_CACHE="${PUB_CACHE:-/data/sdks/pub-cache}"
EOF
    ;;

  # ---------------- Go ----------------
  go)
    A=$ARCH; [[ "$A" == x64 ]] && A=amd64
    _download "https://go.dev/dl/go${VER}.linux-${A}.tar.gz" "$TMP/go.tgz"
    rm -rf "$T/go"; tar -xzf "$TMP/go.tgz" -C "$T"
    "$T/go/bin/go" version
    write_env <<'EOF'
export GOROOT="$SDK_DIR/go"
export GOPATH="${GOPATH:-/data/sdks/gopath}"
export GOTOOLCHAIN=local
export PATH="$GOROOT/bin:$GOPATH/bin:$PATH"
EOF
    ;;

  # ---------------- Node ----------------
  node)
    _download "https://nodejs.org/dist/v${VER}/node-v${VER}-linux-${ARCH}.tar.xz" "$TMP/node.txz"
    rm -rf "$T/node"; mkdir -p "$T/node"; tar -xJf "$TMP/node.txz" -C "$T/node" --strip-components=1
    "$T/node/bin/node" -v
    write_env <<'EOF'
export PATH="$SDK_DIR/node/bin:$PATH"
export NPM_CONFIG_PREFIX="${NPM_CONFIG_PREFIX:-/data/sdks/npm-global}"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
EOF
    ;;

  # ---------------- Rust ----------------
  rust)
    _download https://sh.rustup.rs "$TMP/rustup-init.sh"
    RUSTUP_HOME="$T/rustup" CARGO_HOME="$T/cargo" sh "$TMP/rustup-init.sh" -y --no-modify-path --profile minimal --default-toolchain "$VER" 2>&1 | tail -2
    RUSTUP_HOME="$T/rustup" CARGO_HOME="$T/cargo" "$T/cargo/bin/rustc" --version
    write_env <<'EOF'
export RUSTUP_HOME="$SDK_DIR/rustup"
export CARGO_HOME="$SDK_DIR/cargo"
export PATH="$CARGO_HOME/bin:$PATH"
EOF
    ;;

  *) sdk_die "bilinmeyen sdk: $NAME" ;;
esac

printf '%s\n' "$VER" > "$T/.installed"
printf 'name=%s\nversion=%s\narch=%s\ndate=%s\n' "$NAME" "$VER" "$ARCH" "$(date -u +%FT%TZ)" > "$T/.meta"
sdk_log "$NAME $VER hazır: $T"
