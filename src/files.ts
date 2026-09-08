/**
 * Büyük dosyalar (APK vb.) için download linki:
 *  - Yerleşik HTTP sunucusu: GET /d/<token>/<ad>  (token rastgele, süreli)
 *  - Dış erişim: Cloudflare quick tunnel (hesap gerektirmez, rastgele https://…trycloudflare.com)
 *    ya da PUBLIC_BASE_URL (LAN ip:port, kendi domain'in vb.)
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { config } from "./config.js";

interface Entry {
  file: string;
  expires: number;
  downloads: number;
}

const MIME: Record<string, string> = {
  ".apk": "application/vnd.android.package-archive",
  ".aab": "application/octet-stream",
  ".zip": "application/zip",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".json": "application/json",
  ".pdf": "application/pdf",
};

export class FileServer {
  private entries = new Map<string, Entry>();
  private server?: http.Server;
  private tunnel?: ChildProcess;
  private tunnelUrl?: string;
  private tunnelRestarts = 0;
  private tunnelReady = false;
  private lastCheck?: { at: number; ok: boolean; detail: string };
  private lastErr?: string;
  private checkTimer?: NodeJS.Timeout;
  private onDownload?: (name: string, entry: Entry) => void;

  constructor(private port = config.filePort) {}

  /** Sunucuyu ve (ayarlıysa) tüneli başlat. Hata fırlatmaz. */
  start(onDownload?: (name: string, entry: Entry) => void) {
    this.onDownload = onDownload;
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.on("error", (e) => console.error("[files] sunucu hatası:", e.message));
    this.server.listen(this.port, "0.0.0.0", () => console.log(`[files] http :${this.port} dinliyor`));
    if (config.fileLinks === "tunnel") {
      this.startTunnel();
      let fails = 0;
      this.checkTimer = setInterval(async () => {
        if (!this.tunnelUrl) return;
        if (await this.verify()) {
          fails = 0;
          if (!this.tunnelReady) {
            this.tunnelReady = true;
            console.log("[files] tünel tekrar erişilebilir");
          }
        } else if (++fails >= 2) {
          console.warn(`[files] tünel ${fails} kez erişilemedi (${this.lastCheck?.detail}); yeniden başlatılıyor`);
          fails = 0;
          this.restartTunnel();
        }
      }, 5 * 60_000);
    }
  }

  get baseUrl(): string | undefined {
    if (config.fileLinks === "off") return undefined;
    if (config.publicBaseUrl) return config.publicBaseUrl.replace(/\/+$/, "");
    if (config.fileLinks === "tunnel") return this.tunnelReady ? this.tunnelUrl : undefined;
    return undefined;
  }

  /** /tunnel komutu için durum metni. */
  status(): string {
    const lines = [`mod: ${config.fileLinks}`, `port: ${this.port}`];
    if (config.publicBaseUrl) lines.push(`PUBLIC_BASE_URL: ${config.publicBaseUrl}`);
    if (config.fileLinks === "tunnel") {
      lines.push(`cloudflared: ${this.tunnel ? "çalışıyor (pid " + this.tunnel.pid + ")" : "çalışmıyor"}`);
      lines.push(`adres: ${this.tunnelUrl ?? "henüz yok"}`);
      lines.push(`doğrulama: ${this.tunnelReady ? "✅ dışarıdan erişilebilir" : "❌ henüz doğrulanmadı"}`);
      if (this.lastCheck) lines.push(`son kontrol: ${new Date(this.lastCheck.at).toISOString().slice(11, 19)}Z → ${this.lastCheck.ok ? "ok" : "hata"} ${this.lastCheck.detail}`);
      if (this.lastErr) lines.push(`son cloudflared hatası: ${this.lastErr}`);
      lines.push(`yeniden başlatma: ${this.tunnelRestarts}`);
    }
    lines.push(`aktif link: ${this.entries.size}`);
    return lines.join("\n");
  }

  /** Tüneli dışarıdan doğrula (public URL üzerinden /_health). */
  async verify(): Promise<boolean> {
    const url = this.tunnelUrl;
    if (!url) return false;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12_000);
    try {
      const res = await fetch(`${url}/_health`, { signal: ctrl.signal, headers: { "user-agent": "claude-telegram-agent" } });
      const body = (await res.text()).slice(0, 60);
      const ok = res.status === 200 && body.startsWith("ok");
      this.lastCheck = { at: Date.now(), ok, detail: ok ? "" : `HTTP ${res.status} ${body.replace(/\s+/g, " ")}` };
      return ok;
    } catch (e: any) {
      this.lastCheck = { at: Date.now(), ok: false, detail: e?.name === "AbortError" ? "zaman aşımı" : String(e?.message ?? e) };
      return false;
    } finally {
      clearTimeout(t);
    }
  }

  /** Tüneli zorla yeniden başlat (/tunnel restart). */
  restartTunnel() {
    this.tunnelReady = false;
    if (this.tunnel) this.tunnel.kill("SIGTERM");
    else this.startTunnel();
  }

  /** Yeni URL alındığında: birkaç kez dene, başarılıysa hazır işaretle. */
  private async verifyLoop() {
    const url = this.tunnelUrl;
    for (let i = 0; i < 15 && this.tunnelUrl === url; i++) {
      await new Promise((r) => setTimeout(r, i === 0 ? 3000 : 4000));
      if (await this.verify()) {
        this.tunnelReady = true;
        console.log(`[files] tünel doğrulandı: ${url}`);
        return;
      }
    }
    if (this.tunnelUrl === url) {
      console.warn(`[files] tünel doğrulanamadı (${this.lastCheck?.detail}); cloudflared yeniden başlatılıyor`);
      this.restartTunnel();
    }
  }

  /** Kullanıcıya verilecek link; base URL yoksa undefined. */
  link(file: string): string | undefined {
    const base = this.baseUrl;
    if (!base) return undefined;
    const token = crypto.randomBytes(16).toString("hex");
    this.entries.set(token, { file, expires: Date.now() + config.linkTtlHours * 3_600_000, downloads: 0 });
    this.gc();
    return `${base}/d/${token}/${encodeURIComponent(path.basename(file))}`;
  }

  /** Neden link üretilemediğini açıklayan kısa metin. */
  reason(): string {
    if (config.fileLinks === "off") return "dosya linkleri kapalı (FILE_LINKS=off)";
    if (config.fileLinks === "tunnel") {
      if (!this.tunnel) return "cloudflared çalışmıyor" + (this.lastErr ? " (" + this.lastErr + ")" : "");
      if (!this.tunnelUrl) return "tünel adresi henüz alınmadı (cloudflared başlıyor)";
      return `tünel adresi alındı ama dışarıdan doğrulanamadı (${this.lastCheck?.detail ?? "kontrol sürüyor"}); /tunnel ile durum, /tunnel restart ile yeniden dene`;
    }
    return "PUBLIC_BASE_URL ayarlı değil (.env: PUBLIC_BASE_URL=http://<PC-LAN-IP>:" + this.port + ")";
  }

  private gc() {
    const now = Date.now();
    for (const [t, e] of this.entries) if (e.expires < now) this.entries.delete(t);
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.url === "/_health") {
      res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" }).end("ok " + Date.now());
      return;
    }
    const m = (req.url ?? "").match(/^\/d\/([a-f0-9]{32})\/[^/]+$/);
    if (!m || (req.method !== "GET" && req.method !== "HEAD")) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    const e = this.entries.get(m[1]);
    if (!e || e.expires < Date.now() || !fs.existsSync(e.file)) {
      res.writeHead(410, { "content-type": "text/plain; charset=utf-8" }).end("link süresi dolmuş ya da dosya yok");
      return;
    }
    const st = fs.statSync(e.file);
    const name = path.basename(e.file);
    const headers: Record<string, string> = {
      "content-type": MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream",
      "content-length": String(st.size),
      "content-disposition": `attachment; filename="${name.replace(/"/g, "")}"`,
      "cache-control": "no-store",
      "accept-ranges": "bytes",
    };
    // basit Range desteği (indirme yöneticileri / kesilen indirmeler için)
    const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
    let start = 0;
    let end = st.size - 1;
    let status = 200;
    if (range && (range[1] || range[2])) {
      start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
      end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : end;
      if (start > end || start >= st.size) {
        res.writeHead(416, { "content-range": `bytes */${st.size}` }).end();
        return;
      }
      status = 206;
      headers["content-range"] = `bytes ${start}-${end}/${st.size}`;
      headers["content-length"] = String(end - start + 1);
    }
    res.writeHead(status, headers);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    if (status === 200) {
      e.downloads++;
      this.onDownload?.(name, e);
    }
    fs.createReadStream(e.file, { start, end }).pipe(res);
  }

  // ---------------- Cloudflare quick tunnel ----------------
  private startTunnel() {
    if (this.tunnel) return;
    const bin = config.cloudflaredPath;
    if (!fs.existsSync(bin)) {
      console.warn(`[files] cloudflared yok (${bin}); FILE_LINKS=lan + PUBLIC_BASE_URL kullan`);
      return;
    }
    const args = ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${this.port}`, "--loglevel", "info"];
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.tunnel = child;
    const onData = (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      const m = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && this.tunnelUrl !== m[0]) {
        this.tunnelUrl = m[0];
        this.tunnelReady = false;
        console.log(`[files] tünel adresi alındı: ${this.tunnelUrl} — doğrulanıyor…`);
        void this.verifyLoop();
      }
      if (/\bERR\b|error/i.test(s) && !/context canceled/.test(s)) {
        this.lastErr = s.trim().split("\n").pop()?.slice(0, 200);
        console.warn("[cloudflared] " + this.lastErr);
      } else if (config.logLevel === "debug") process.stderr.write("[cloudflared] " + s);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", (code) => {
      console.warn(`[files] cloudflared kapandı (kod ${code}); ${this.tunnelUrl ? "eski linkler geçersiz, " : ""}yeniden başlatılıyor`);
      this.tunnel = undefined;
      this.tunnelUrl = undefined;
      this.tunnelReady = false;
      const delay = Math.min(60_000, 5_000 * 2 ** Math.min(this.tunnelRestarts++, 4));
      setTimeout(() => this.startTunnel(), delay);
    });
  }

  stop() {
    if (this.checkTimer) clearInterval(this.checkTimer);
    this.tunnel?.removeAllListeners("exit");
    this.tunnel?.kill("SIGTERM");
    this.server?.close();
  }
}
