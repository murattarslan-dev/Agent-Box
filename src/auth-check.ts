/**
 * Açılışta Claude OAuth token'ını hafifçe doğrular. Amaç: geçersiz/expired token'da
 * Claude Code'un 11 denemelik retry döngüsüne girip "asılı" görünmesini önlemek;
 * kullanıcıya Telegram'dan net mesaj vermek.
 */
export type AuthCheck = { ok: true } | { ok: false; status?: number; reason: string };

export async function checkClaudeAuth(): Promise<AuthCheck> {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) return { ok: false, reason: "CLAUDE_CODE_OAUTH_TOKEN boş" };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch("https://api.anthropic.com/v1/models?limit=1", {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: ctrl.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, reason: "Claude OAuth token geçersiz ya da süresi dolmuş. `claude setup-token` ile yenile." };
    }
    return { ok: true };
  } catch (e: any) {
    // ağ hatası: kesin yargı verme
    return { ok: true };
  } finally {
    clearTimeout(t);
  }
}
