import path from "node:path";

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
  maxTurns: Number(process.env.MAX_TURNS ?? 400),
  /** PR açma sorusunu atla: review geçtiyse doğrudan PR aç. */
  autoPr: bool("AUTO_PR", false),
  /** true: onay kapısı kapalı (her şey serbest). Sadece güvenli ortamda. */
  freeMode: bool("FREE_MODE", false),
  gitUserName: process.env.GIT_USER_NAME ?? "Claude Agent",
  gitUserEmail: process.env.GIT_USER_EMAIL ?? "claude-agent@noreply.local",
  logLevel: process.env.LOG_LEVEL ?? "info",

  get statePath() {
    return path.join(this.dataDir, "state.json");
  },
  get healthPath() {
    return path.join(this.dataDir, ".healthy");
  },
};
