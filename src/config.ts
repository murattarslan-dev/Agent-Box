import path from "node:path";

/** Yapıştırma kirlerini temizle: CR/LF, baş-son boşluk, çevreleyen tırnak. Sonucu process.env'e geri yazar (Claude Code alt süreci de görsün). */
function clean(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  let v = raw.replace(/[\r\n]/g, "").trim();
  while (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) v = v.slice(1, -1).trim();
  if (v !== raw) {
    process.env[name] = v;
    console.warn(`[config] ${name} temizlendi (boşluk/tırnak/satır sonu kaldırıldı)`);
  }
  return v;
}
for (const n of ["CLAUDE_CODE_OAUTH_TOKEN", "TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USER_IDS", "REPO_URL", "REPO_TOKEN", "GIT_PROVIDER", "GIT_USER_NAME", "GIT_USER_EMAIL",
  "CLAUDE_MODEL", "MODEL_REVIEW", "MODEL_EXPLORE", "PUBLIC_BASE_URL", "FILE_LINKS", "SDKS", "APK_BUILDER", "APK_WORKFLOW", "BUILD_WEBHOOK_SECRET", "APP_TEST_TOKEN", "TZ"]) clean(n);

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Eksik env: ${name}`);
  return v;
}

function bool(name: string, def = false): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  return /^(1|true|yes|on)$/i.test(v);
}

export type Provider = "github" | "gitlab";

export const config = {
  telegramToken: req("TELEGRAM_BOT_TOKEN"),
  /** Boşsa kimse yetkili değildir; bot yazan kişinin ID'sini geri söyler. */
  allowedUserIds: (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number),

  repoUrl: req("REPO_URL"),
  repoHost: process.env.REPO_HOST ?? "",
  repoPath: process.env.REPO_PATH ?? "",
  provider: (process.env.GIT_PROVIDER ?? "github") as Provider,
  defaultBranch: process.env.DEFAULT_BRANCH ?? "main",

  dataDir: process.env.DATA_DIR ?? "/data",
  repoDir: process.env.REPO_DIR ?? "/data/repo",
  sdkHome: process.env.SDK_HOME ?? "/data/sdks",
  agentConfigDir: process.env.AGENT_CONFIG_DIR ?? "/app/agent-config",

  model: process.env.CLAUDE_MODEL || undefined,
  /** Faz bazlı modeller (token tasarrufu): alt-ajanlar için */
  modelReview: process.env.MODEL_REVIEW || "sonnet",
  modelExplore: process.env.MODEL_EXPLORE || "haiku",
  /** Gürültülü Bash çıktılarında modele gösterilecek son satır sayısı (0 = kapalı) */
  bashTailLines: Number(process.env.BASH_TAIL_LINES ?? 80),
  logDir: process.env.LOG_DIR ?? "/data/logs",
  maxTurns: Number(process.env.MAX_TURNS ?? 400),
  /** PR açma sorusunu atla: review geçtiyse doğrudan PR aç. */
  autoPr: bool("AUTO_PR", false),
  /** true: onay kapısı kapalı (her şey serbest). Sadece güvenli ortamda. */
  freeMode: bool("FREE_MODE", false),
  gitUserName: process.env.GIT_USER_NAME ?? "Claude Agent",
  gitUserEmail: process.env.GIT_USER_EMAIL ?? "claude-agent@noreply.local",
  logLevel: process.env.LOG_LEVEL ?? "info",

  /** Büyük dosya linkleri: tunnel (Cloudflare quick tunnel, varsayılan) | lan (PUBLIC_BASE_URL) | off */
  fileLinks: (process.env.FILE_LINKS ?? "tunnel") as "tunnel" | "lan" | "off",
  publicBaseUrl: process.env.PUBLIC_BASE_URL || undefined,
  /** Railway/Render gibi PaaS'lar PORT verir; yoksa FILE_PORT (8787). */
  filePort: Number(process.env.FILE_PORT ?? process.env.PORT ?? 8787),
  linkTtlHours: Number(process.env.LINK_TTL_HOURS ?? 24),
  cloudflaredPath: process.env.CLOUDFLARED_PATH ?? "/usr/local/bin/cloudflared",

  /** APK nerede üretilir: local (container'da flutter/gradle) | actions (GitHub Actions; container'da JDK/Android gerekmez) */
  apkBuilder: (process.env.APK_BUILDER ?? "local") as "local" | "actions",
  apkWorkflow: process.env.APK_WORKFLOW ?? "agent-apk.yml",
  /** Actions → bot webhook ping'i (POST /hook/build, x-agent-secret). Boşsa uç kapalı. */
  buildWebhookSecret: process.env.BUILD_WEBHOOK_SECRET || undefined,

  get statePath() {
    return path.join(this.dataDir, "state.json");
  },
  get healthPath() {
    return path.join(this.dataDir, ".healthy");
  },
};
