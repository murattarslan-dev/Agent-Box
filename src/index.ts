import { config } from "./config.js";
import { Agent } from "./agent.js";
import { createBot, markHealthy } from "./bot.js";
import { loadState } from "./state.js";
import { checkClaudeAuth } from "./auth-check.js";

async function main() {
  const agent = new Agent();
  const bot = createBot(agent);

  const st = loadState();
  console.log(
    `[bot] başlıyor · repo=${config.repoPath || config.repoUrl} provider=${config.provider} ` +
      `faz=${st.phase} oturum=${st.sessionId?.slice(0, 8) ?? "-"} yetkili=${config.allowedUserIds.join(",") || "(yok!)"}`,
  );
  if (!config.allowedUserIds.length) {
    console.warn("[bot] UYARI: TELEGRAM_ALLOWED_USER_IDS boş — bot kimseye cevap vermez, sadece id söyler.");
  }

  await bot.api.setMyCommands([
    { command: "new", description: "Yeni oturum / görev" },
    { command: "status", description: "Durum" },
    { command: "cancel", description: "Çalışan işi durdur" },
    { command: "init", description: "Ortamı kur (SDK'lar)" },
    { command: "review", description: "Review yap" },
    { command: "pr", description: "PR aç" },
    { command: "diff", description: "Değişiklikler" },
    { command: "log", description: "Son commit'ler" },
    { command: "sdk", description: "Bağlı SDK'lar" },
    { command: "approve", description: "Plan kapısını aç" },
    { command: "free", description: "Serbest modu aç/kapat" },
    { command: "help", description: "Yardım" },
  ]);

  // healthcheck
  markHealthy();
  setInterval(markHealthy, 30_000);

  // token kontrolü + yetkili kullanıcılara açılış bildirimi
  const auth = await checkClaudeAuth();
  if (!auth.ok) console.error(`[bot] UYARI: ${auth.reason}`);
  const hello = auth.ok
    ? `🟢 Ajan ayakta · ${config.repoPath || config.repoUrl} · faz: ${st.phase}${st.sessionId ? " (oturum devam ediyor)" : ""}`
    : `🔴 Ajan ayakta ama Claude token sorunu var: ${auth.reason}`;
  for (const uid of config.allowedUserIds) {
    bot.api.sendMessage(uid, hello).catch(() => undefined);
  }

  const stop = async () => {
    console.log("[bot] kapanıyor…");
    await agent.interrupt();
    await bot.stop();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  await bot.start({
    drop_pending_updates: false,
    onStart: (me) => console.log(`[bot] @${me.username} dinliyor`),
  });
}

main().catch((e) => {
  console.error("[bot] ölümcül:", e);
  process.exit(1);
});
