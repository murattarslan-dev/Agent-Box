#!/usr/bin/env bash
# Bağlı SDK'ları bulur ve tek bir env.sh üretir ($SDK_HOME/env.sh; BASH_ENV ile her bash'te yüklenir).
#   sdk-env.sh            → env.sh'ı (yeniden) üret
#   sdk-env.sh --list     → bağlı SDK'ları listele (isim sürüm kaynak)
# Kaynaklar (öncelik sırası): /sdks/<name>/<ver>  (paylaşımlı volume)  >  $SDK_HOME/<name>/<ver> (container'a özel)
set -euo pipefail
SDK_HOME="${SDK_HOME:-/data/sdks}"
ROOTS=(/sdks "$SDK_HOME")
LIST=0; [[ "${1:-}" == --list ]] && LIST=1

declare -A SEEN=()
FRAGMENTS=()
for root in "${ROOTS[@]}"; do
  [[ -d "$root" ]] || continue
  for dir in "$root"/*/*/; do
    dir="${dir%/}"
    [[ -f "$dir/.installed" && -f "$dir/env.sh" ]] || continue
    name="$(basename "$(dirname "$dir")")"; ver="$(cat "$dir/.installed")"
    if [[ -n "${SEEN[$name]:-}" ]]; then
      (( LIST )) && printf '%-8s %-12s %s (gölgede: %s kullanılıyor)\n' "$name" "$ver" "$dir" "${SEEN[$name]}"
      continue
    fi
    SEEN[$name]="$ver"
    FRAGMENTS+=("$dir/env.sh")
    (( LIST )) && printf '%-8s %-12s %s\n' "$name" "$ver" "$dir"
  done
done
(( LIST )) && { (( ${#FRAGMENTS[@]} )) || echo "(bağlı SDK yok)"; exit 0; }

mkdir -p "$SDK_HOME/bin"
{
  echo '# OTOMATİK ÜRETİLDİ (sdk-env.sh) — elle düzenleme; container açılışında yeniden yazılır.'
  echo '# Ek/özel ayarlar için: $SDK_HOME/env.local.sh'
  echo "export SDK_HOME=\"${SDK_HOME}\""
  echo 'export PATH="$SDK_HOME/bin:$PATH"'
  for f in "${FRAGMENTS[@]}"; do
    echo "# --- $f"
    echo "[[ -f \"$f\" ]] && source \"$f\""
  done
  echo '[[ -f "$SDK_HOME/env.local.sh" ]] && source "$SDK_HOME/env.local.sh"'
  echo 'true'
} > "$SDK_HOME/env.sh.tmp"
mv -f "$SDK_HOME/env.sh.tmp" "$SDK_HOME/env.sh"
names=""; for k in "${!SEEN[@]}"; do names+="$k ${SEEN[$k]}, "; done
printf '[sdk] env.sh üretildi: %d SDK (%s)\n' "${#FRAGMENTS[@]}" "${names%, }" >&2
