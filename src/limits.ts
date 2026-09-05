import type { LimitInfo } from "./state.js";

const LABELS: Record<string, string> = {
  five_hour: "⏱ 5 saat",
  seven_day: "📅 7 gün",
  seven_day_opus: "📅 7 gün (Opus)",
  seven_day_sonnet: "📅 7 gün (Sonnet)",
  seven_day_overage_included: "📅 7 gün (ek dahil)",
  overage: "💳 Ek kullanım",
};

function bar(pct: number): string {
  const n = Math.max(0, Math.min(10, Math.round(pct / 10)));
  return "▰".repeat(n) + "▱".repeat(10 - n);
}

export function fmtTime(ms?: number): string {
  if (!ms) return "?";
  const d = new Date(ms);
  const tz = process.env.TZ || "UTC";
  const now = Date.now();
  const diffH = (ms - now) / 3_600_000;
  const rel = diffH < 1 ? `${Math.max(1, Math.round(diffH * 60))} dk` : diffH < 48 ? `${Math.round(diffH)} sa` : `${Math.round(diffH / 24)} gün`;
  try {
    const t = new Intl.DateTimeFormat("tr-TR", { timeZone: tz, weekday: diffH >= 24 ? "short" : undefined, hour: "2-digit", minute: "2-digit" }).format(d);
    return `${t} (${rel})`;
  } catch {
    return `${d.toISOString().slice(11, 16)} UTC (${rel})`;
  }
}

/** Telegram için limit özeti (düz metin). */
export function formatLimits(limits?: Record<string, LimitInfo>): string {
  if (!limits || !Object.keys(limits).length) {
    return "Limit bilgisi henüz yok — ilk görevden sonra gelir (Claude Code her turda bildirir).";
  }
  const order = ["five_hour", "seven_day", "seven_day_sonnet", "seven_day_opus", "seven_day_overage_included", "overage"];
  const keys = Object.keys(limits).sort((a, b) => (order.indexOf(a) + 99) - (order.indexOf(b) + 99));
  const lines = keys.map((k) => {
    const l = limits[k];
    const label = LABELS[k] ?? k;
    const pct = l.utilization !== undefined ? `%${Math.round(l.utilization)}` : "?";
    const flag = l.status === "rejected" ? " ⛔ doldu" : l.status === "allowed_warning" ? " ⚠️" : "";
    return `${label}: ${l.utilization !== undefined ? bar(l.utilization) + " " : ""}${pct}${flag} · sıfırlanma ${fmtTime(l.resetsAt)}`;
  });
  const last = keys.map((k) => limits[k].at).sort().pop();
  return lines.join("\n") + (last ? `\n(son güncelleme ${fmtTime(new Date(last).getTime()).replace(/ \(.*\)$/, "")})` : "");
}
