#!/usr/bin/env bash
# Mac/Linux/WSL: değişiklikleri göster, commit mesajı sor, hepsini commit'le ve push et.
set -e
cd "$(dirname "${BASH_SOURCE[0]}")"
echo; echo "=== Değişiklikler ==="; git status --short
if git diff --quiet && git diff --cached --quiet; then
  echo; read -rp "Commit'lenecek değişiklik yok. Yine de push edeyim mi? [E/h]: " a
  [[ "$a" =~ ^[Hh] ]] && exit 0
else
  echo; read -rp "Commit mesajı (boş: 'update'): " MSG
  git add -A && git commit -m "${MSG:-update}"
fi
echo; echo "=== Push ==="; git push
echo; git log --oneline -3
