/**
 * Gürültülü Bash komutlarını (build/test/paket yöneticisi) otomatik kırpar:
 * tam çıktı /data/logs'a, modele yalnızca son N satır. Model fark etmez; context şişmez.
 */
import { config } from "./config.js";

const NOISY = [
  /\bflutter\s+(build|test|pub|analyze|doctor|precache|clean|create)\b/,
  /\bdart\s+(analyze|test|pub|run|compile)\b/,
  /\b(\.\/)?gradlew?\b/,
  /\b(npm|pnpm|yarn)\s+(ci|install|i|test|run|build)\b/,
  /\bgo\s+(test|build|vet|mod|run|generate)\b/,
  /\bcargo\s+(build|test|clippy|check|fetch)\b/,
  /\b(pytest|mvn|sdkmanager|apt-get|pip3?\s+install)\b/,
  /\/app\/scripts\/(build-apk|sdk-install)\.sh\b/,
  /\bsdk-install\b/,
];
// Zaten kırpılmış / kendi filtresi olan / arka plana atılan komutlara dokunma
const SKIP = [/\|\s*(tail|head|grep|wc|awk|sed|cut|sort|uniq|jq)\b/, /run-task\.sh/, /\brun-task\b/, />\s*\/dev\/null/, /\btee\b/, /\b__trimmed__\b/, /&\s*$/];

export interface TrimResult {
  command: string;
  wrapped: boolean;
}

export function trimCommand(cmd: string, tailLines = config.bashTailLines): TrimResult {
  if (!tailLines || tailLines <= 0) return { command: cmd, wrapped: false };
  if (!NOISY.some((re) => re.test(cmd))) return { command: cmd, wrapped: false };
  if (SKIP.some((re) => re.test(cmd))) return { command: cmd, wrapped: false };
  const log = `${config.logDir}/bash-$(date +%Y%m%d-%H%M%S)-$$.log`;
  // orijinal komutu alt kabukta çalıştır, tam çıktıyı logla, son N satırı göster, çıkış kodunu koru
  const wrapped =
    `__trimmed__=1; mkdir -p ${config.logDir}; __log="${log}"; ( ${cmd} ) > "$__log" 2>&1; __rc=$?; ` +
    `__n=$(wc -l < "$__log"); if [ "$__n" -gt ${tailLines} ]; then echo "… ($((__n-${tailLines})) satır kırpıldı; tamamı: $__log)"; fi; ` +
    `tail -n ${tailLines} "$__log"; exit $__rc`;
  return { command: wrapped, wrapped: true };
}
