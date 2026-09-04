/**
 * Faz kapısı (gate): ajan onay almadan repo'ya yazamaz, review + PR onayı
 * olmadan push/PR atamaz. PreToolUse hook'u olarak çalışır; model "yanlışlıkla"
 * atlasa bile kapı teknik olarak kapalıdır.
 */
import path from "node:path";
import { config } from "./config.js";
import { loadState, saveState } from "./state.js";

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

const PUSH_RE = /\bgit\s+(?:-C\s+\S+\s+)?push\b/;
const PR_CREATE_RE = /\b(?:gh\s+pr\s+create|glab\s+mr\s+create)\b/;
const COMMIT_RE = /\bgit\s+(?:-C\s+\S+\s+)?commit\b/;
const FORCE_PUSH_RE = /\bgit\s+(?:-C\s+\S+\s+)?push\b[^|;&]*(?:--force\b|-f\b|\+\S+)/;
const DANGEROUS_RE = [
  /\brm\s+-[a-z]*r[a-z]*f?\s+(?:\/|~|\$HOME|\/data)(?:\s|$)/,
  /\bgit\s+(?:-C\s+\S+\s+)?reset\s+--hard\b.*\borigin\/(?:main|master)\b/,
  /\bgit\s+(?:-C\s+\S+\s+)?branch\s+-D\s+(?:main|master)\b/,
  /\bgit\s+(?:-C\s+\S+\s+)?checkout\s+(?:main|master)\s*&&.*\bgit\s+push\b/,
];

/** Repo içindeki yol mu (ve .agent/ not dizini değil mi)? */
function isRepoSourcePath(p: unknown): boolean {
  if (typeof p !== "string" || !p) return false;
  const abs = path.resolve(config.repoDir, p);
  const rel = path.relative(config.repoDir, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false; // repo dışı
  if (rel === ".agent" || rel.startsWith(".agent" + path.sep)) return false; // not defteri serbest
  return true;
}

export interface GateDecision {
  allow: boolean;
  reason?: string;
}

const DENY_APPROVAL =
  "KAPI KAPALI: plan henüz kullanıcı tarafından onaylanmadı. Repo dosyalarına yazmadan önce " +
  "`plan-and-approve` skill'ini uygula ve AskUserQuestion ile (header: \"Onay\") onay al. " +
  "Not ve analiz dosyalarını `.agent/` altına yazabilirsin.";

const DENY_PR =
  "KAPI KAPALI: push / PR için önce `review` skill'i ile review'ı tamamla ve AskUserQuestion ile " +
  "(header: \"PR\") kullanıcıdan PR onayı al. Onay alındıktan sonra `open-pr` skill'ini uygula.";

export function decide(toolName: string, input: Record<string, unknown>): GateDecision {
  const st = loadState();

  // Tehlikeli komutlar her modda kapalı
  if (toolName === "Bash") {
    const cmd = String(input.command ?? "");
    if (FORCE_PUSH_RE.test(cmd) && new RegExp(`\\b${config.defaultBranch}\\b`).test(cmd)) {
      return { allow: false, reason: `Varsayılan dala (${config.defaultBranch}) force-push yasak.` };
    }
    for (const re of DANGEROUS_RE) {
      if (re.test(cmd)) return { allow: false, reason: "Yıkıcı komut engellendi: " + cmd.slice(0, 120) };
    }
    if (PUSH_RE.test(cmd) && new RegExp(`\\borigin\\s+(?:HEAD:)?${config.defaultBranch}\\b`).test(cmd)) {
      return { allow: false, reason: `Doğrudan ${config.defaultBranch} dalına push yasak; feature dalı + PR kullan.` };
    }
  }

  if (st.freeMode) return { allow: true };

  if (WRITE_TOOLS.has(toolName)) {
    const p = input.file_path ?? input.notebook_path;
    if (isRepoSourcePath(p) && !st.approved) return { allow: false, reason: DENY_APPROVAL };
    return { allow: true };
  }

  if (toolName === "Bash") {
    const cmd = String(input.command ?? "");
    if (PUSH_RE.test(cmd) || PR_CREATE_RE.test(cmd)) {
      if (!st.approved) return { allow: false, reason: DENY_APPROVAL };
      if (!st.prApproved) return { allow: false, reason: DENY_PR };
      return { allow: true };
    }
    if (COMMIT_RE.test(cmd) && !st.approved) return { allow: false, reason: DENY_APPROVAL };
  }

  return { allow: true };
}

/** Kullanıcı onay sorusuna cevap verdi → kapıyı güncelle. */
export function applyAnswer(header: string, answer: string): void {
  const h = header.toLowerCase();
  const a = answer.toLowerCase();
  const yes = /^(✅|onay|evet|approve|yes|ok|tamam|devam)/.test(a.trim());

  if (/onay|approv|plan/.test(h)) {
    if (yes) saveState({ approved: true, prApproved: config.autoPr, phase: "implementing" });
    else if (/iptal|cancel|❌/.test(a)) saveState({ approved: false, phase: "idle" });
    else saveState({ approved: false, phase: "awaiting_approval" });
  } else if (/\bpr\b|merge|push/.test(h)) {
    if (yes) saveState({ prApproved: true, phase: "pr_opened" });
    else if (/iptal|cancel|❌/.test(a)) saveState({ prApproved: false, phase: "implementing" });
    else saveState({ prApproved: false, phase: "reviewing" });
  }
}

/** PR açıldıktan sonra kapılar bir sonraki görev için tekrar kapanır. */
export function onPrCreated(url: string): void {
  saveState({ prUrl: url, phase: "pr_opened", approved: false, prApproved: false });
}
