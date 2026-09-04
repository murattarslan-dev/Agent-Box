#!/usr/bin/env bash
# Container içinde çalışır (one-shot): /repo bağlıysa onu, değilse REPO_URL'i sığ klonlayıp tarar.
# Çıktı: "isim sürüm" satırları (sdk-detect.sh)
set -euo pipefail
DIR=/repo
if [[ ! -d "$DIR/.git" ]]; then
  [[ -n "${REPO_URL:-}" ]] || { echo "REPO_URL yok ve /repo bağlı değil" >&2; exit 1; }
  case "${GIT_PROVIDER:-github}" in gitlab) U=oauth2 ;; *) U=x-access-token ;; esac
  DIR="$(mktemp -d)/repo"
  git -c credential.helper="!f(){ echo username=$U; echo password=\${REPO_TOKEN}; }; f" \
      clone --quiet --depth 1 "$REPO_URL" "$DIR" >&2
fi
exec /app/scripts/sdk-detect.sh "$DIR"
