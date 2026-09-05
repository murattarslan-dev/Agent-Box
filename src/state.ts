import fs from "node:fs";
import { config } from "./config.js";

export type Phase =
  | "idle"
  | "analyzing"
  | "awaiting_approval"
  | "implementing"
  | "reviewing"
  | "awaiting_pr_approval"
  | "pr_opened";

export interface LimitInfo {
  status: "allowed" | "allowed_warning" | "rejected" | string;
  /** 0-100 */
  utilization?: number;
  /** epoch ms */
  resetsAt?: number;
  at: string;
}

export interface AgentState {
  /** Claude Code oturum id'si (resume için). */
  sessionId?: string;
  phase: Phase;
  /** Plan onaylandı → repo dosyalarına yazma serbest. */
  approved: boolean;
  /** Review tamam + kullanıcı PR onayı → push / PR serbest. */
  prApproved: boolean;
  /** Onay kapısı tamamen kapalı (FREE_MODE veya /free). */
  freeMode: boolean;
  /** Ajanın bu görev için açtığı dal. */
  branch?: string;
  /** Kısa görev başlığı (ilk prompt'tan). */
  task?: string;
  prUrl?: string;
  /** Toplam maliyet (USD, API eşdeğeri) — oturum boyunca. */
  costUsd: number;
  /** Bot üzerinden seçilen model (boş = CLAUDE_MODEL / Claude Code varsayılanı). */
  model?: string;
  /** Abonelik limitleri (SDK rate_limit_event / usage API): pencere → doluluk. */
  limits?: Record<string, LimitInfo>;
  turns: number;
  updatedAt: string;
}

const defaults = (): AgentState => ({
  phase: "idle",
  approved: false,
  prApproved: false,
  freeMode: config.freeMode,
  costUsd: 0,
  turns: 0,
  updatedAt: new Date().toISOString(),
});

let cached: AgentState | undefined;

export function loadState(): AgentState {
  if (cached) return cached;
  try {
    const raw = fs.readFileSync(config.statePath, "utf8");
    cached = { ...defaults(), ...(JSON.parse(raw) as Partial<AgentState>) };
  } catch {
    cached = defaults();
  }
  return cached;
}

export function saveState(patch: Partial<AgentState> = {}): AgentState {
  const s = { ...loadState(), ...patch, updatedAt: new Date().toISOString() };
  cached = s;
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = config.statePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, config.statePath);
  return s;
}

/** Yeni görev: oturum ve kapılar sıfırlanır, freeMode korunur. */
export function resetState(): AgentState {
  const prev = loadState();
  cached = { ...defaults(), freeMode: prev.freeMode, model: prev.model, limits: prev.limits };
  return saveState();
}
