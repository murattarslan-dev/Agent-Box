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
    return "Limit bilgisi alınamadı — token geçerli mi? (/limit tekrar dener)";
  }
  const order = ["five_hour", "seven_day", "seven_day_sonnet", "seven_day_opus", "seven_day_overage_included", "overage"];
  const keys = Object.keys(limits).sort((a, b) => (order.indexOf(a) + 99) - (order.indexOf(b) + 99));
  const lines = keys.map((k) => {
    const l = limits[k];
    const label = LABELS[k] ?? k;
    const u = l.utilization;
    const pct = u !== undefined ? `%${Math.round(u)} kullanıldı · %${Math.max(0, Math.round(100 - u))} kaldı` : "doluluk bilinmiyor";
    const flag = l.status === "rejected" ? " ⛔ doldu" : l.status === "allowed_warning" ? " ⚠️" : "";
    return `${label}\n  ${u !== undefined ? bar(u) + " " : ""}${pct}${flag}\n  sıfırlanma: ${fmtTime(l.resetsAt)}`;
  });
  const last = keys.map((k) => limits[k].at).sort().pop();
  return lines.join("\n") + (last ? `\n(son güncelleme ${fmtTime(new Date(last).getTime()).replace(/ \(.*\)$/, "")})` : "");
}
