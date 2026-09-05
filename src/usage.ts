/**
 * Abonelik kullanımını Claude Code'un /usage ekranıyla aynı uç noktadan çeker:
 *   GET https://api.anthropic.com/api/oauth/usage  (Bearer <CLAUDE_CODE_OAUTH_TOKEN>)
 * Cevap: { five_hour: {utilization, resets_at}, seven_day: {...}, seven_day_opus, seven_day_sonnet, ... }
 * utilization yüzde (0-100), resets_at ISO tarih. Alan adları değişebilir; savunmacı ayrıştırılır.
 */
import type { LimitInfo } from "./state.js";
import { loadState, saveState } from "./state.js";

export type UsageResult = { ok: true; limits: Record<string, LimitInfo> } | { ok: false; reason: string };

let lastFetch = 0;

export async function fetchUsage(): Promise<UsageResult> {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) return { ok: false, reason: "CLAUDE_CODE_OAUTH_TOKEN yok" };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        "user-agent": "claude-telegram-agent",
      },
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, reason: `usage uç noktası ${res.status} döndü` };
    const data = (await res.json()) as Record<string, unknown>;
    const limits: Record<string, LimitInfo> = {};
    const now = new Date().toISOString();
    for (const [k, v] of Object.entries(data)) {
      if (!v || typeof v !== "object") continue;
      const o = v as Record<string, unknown>;
      const rawU = o.utilization ?? o.used_percentage ?? o.percent;
      if (typeof rawU !== "number") continue;
      const util = rawU; // yüzde (0-100)
      const rs = o.resets_at ?? o.reset_at ?? o.resetsAt;
      let resetsAt: number | undefined;
      if (typeof rs === "string") resetsAt = Date.parse(rs) || undefined;
      else if (typeof rs === "number") resetsAt = rs < 1e12 ? rs * 1000 : rs;
      limits[k] = {
        status: util >= 100 ? "rejected" : util >= 80 ? "allowed_warning" : "allowed",
        utilization: Math.max(0, Math.min(100, util)),
        resetsAt,
        at: now,
      };
    }
    if (!Object.keys(limits).length) return { ok: false, reason: "usage cevabında pencere bulunamadı" };
    lastFetch = Date.now();
    // olaylardan gelen eski kayıtların üstüne yaz (API daha güncel)
    saveState({ limits: { ...(loadState().limits ?? {}), ...limits } });
    return { ok: true, limits };
  } catch (e: any) {
    return { ok: false, reason: e?.name === "AbortError" ? "zaman aşımı" : e?.message ?? String(e) };
  } finally {
    clearTimeout(t);
  }
}

/** 5 dakikadan eskiyse tazele; hata olursa sessizce eldekini kullan. */
export async function refreshUsageIfStale(maxAgeMs = 5 * 60_000): Promise<void> {
  if (Date.now() - lastFetch < maxAgeMs) return;
  await fetchUsage();
}
