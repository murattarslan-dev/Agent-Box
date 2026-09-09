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
      let detail = "";
      try {
        const j: any = await res.json();
        detail = j?.error?.message ?? j?.error?.type ?? "";
      } catch {
        /* gövde yok */
      }
      const len = token.length;
      const shape = `${token.slice(0, 13)}… (${len} karakter${/\s/.test(token) ? ", İÇİNDE BOŞLUK/SATIR SONU VAR" : ""}${/^["']|["']$/.test(token) ? ", TIRNAKLI" : ""})`;
      console.error(`[auth] HTTP ${res.status} ${detail} · token: ${shape}`);
      const hint =
        res.status === 401
          ? "Token reddedildi (401): değer yanlış kopyalanmış, tırnaklı/boşluklu ya da süresi dolmuş. `claude setup-token` çıktısını olduğu gibi yapıştır."
          : "Erişim reddedildi (403): token geçerli görünüyor ama bu istek engellendi (bölge/IP kısıtı ya da hesap durumu). Anthropic'in döndürdüğü mesaja bak.";
      return { ok: false, status: res.status, reason: `${hint}${detail ? ` Sunucu: "${detail}"` : ""} · token ${shape}` };
    }
    if (!res.ok) console.warn(`[auth] beklenmedik HTTP ${res.status} (token kontrolü atlandı)`);
    return { ok: true };
  } catch (e: any) {
    // ağ hatası: kesin yargı verme
    return { ok: true };
  } finally {
    clearTimeout(t);
  }
}
