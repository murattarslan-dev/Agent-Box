/**
 * Telegram katmanı: yetki, komutlar, mesaj → ajan, inline-buton soru/izin akışı.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import { config } from "./config.js";
import { Agent, type AgentIO, type Question } from "./agent.js";
import { loadState, resetState, saveState } from "./state.js";
import { ProgressMessage, Sender, escapeHtml } from "./telegram-io.js";
import { formatLimits } from "./limits.js";
import { FileServer } from "./files.js";
import { fetchUsage, refreshUsageIfStale } from "./usage.js";

interface PendingQuestion {
  kind: "question";
  chatId: number;
  questions: Question[];
  index: number;
  answers: Record<string, string>;
  selected: Set<number>;
  msgId?: number;
  resolve: (a: Record<string, string>) => void;
  reject: (e: Error) => void;
  awaitingFreeText: boolean;
}
interface PendingPermission {
  kind: "permission";
  chatId: number;
  msgId?: number;
  resolve: (ok: boolean) => void;
}

const HELP = `🤖 <b>Claude Agent</b> — repo: <code>${escapeHtml(config.repoPath || config.repoUrl)}</code>

Bir görev yaz, ajan şu akışı izler:
1️⃣ Mimariyi analiz eder → 2️⃣ Plan sunar, <b>onay</b> ister → 3️⃣ Geliştirir → 4️⃣ Review yapar → 5️⃣ <b>PR onayı</b> ister → 6️⃣ PR açar

<b>Komutlar</b>
/new [görev] — yeni oturum (kapılar sıfırlanır)
/status — faz, dal, maliyet
/cancel — çalışan işi durdur
/init — repo'yu analiz edip eksik SDK'ları kur (bootstrap-env)
/review — mevcut değişiklikleri review et
/pr — review + PR onayı + PR aç
/diff — çalışma ağacındaki değişiklikler
/log — son commit'ler
/sdk — bağlı SDK'lar
/limit — abonelik kullanımı (5 saat / 7 gün, canlı)
/model [ad] — modeli seç (sonnet / opus / haiku / tam ad)
/apk [debug|release] [all] [flavor X] — APK build et ve gönder (≤50 MB dosya, üstü download linki)
/builds — son build'ler ve linkleri
/approve — plan kapısını elle aç
/free — kapıları tamamen aç/kapat (dikkat)
/whoami — Telegram kullanıcı id'n`;

export function createBot(agent: Agent, files: FileServer): Bot {
  const bot = new Bot(config.telegramToken);
  const pending = new Map<string, PendingQuestion | PendingPermission>();
  const queue: { chatId: number; text: string }[] = [];
  let seq = 0;

  // ---------- yetki ----------
  bot.use(async (ctx, next) => {
    const uid = ctx.from?.id;
    if (uid === undefined) return;
    if (!config.allowedUserIds.includes(uid)) {
      if (ctx.message?.text || ctx.callbackQuery) {
        await ctx.reply(
          `⛔ Yetkisiz. Telegram kullanıcı id'n: ${uid}\nBunu TELEGRAM_ALLOWED_USER_IDS env'ine ekleyip container'ı yeniden başlat.`,
        );
      }
      return;
    }
    await next();
  });

  const git = (...args: string[]) => {
    try {
      return execFileSync("git", ["-C", config.repoDir, ...args], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    } catch (e: any) {
      return `git hata: ${e?.stderr ?? e?.message ?? e}`;
    }
  };

  // ---------- dosya teslimi (Telegram bot sınırı 50 MB) ----------
  const TG_FILE_LIMIT = 50 * 1024 * 1024;
  async function sendFile(chatId: number, filePath: string, caption?: string): Promise<boolean> {
    const name = path.basename(filePath);
    const size = fs.statSync(filePath).size;
    const mb = (size / 1048576).toFixed(1);
    if (size > TG_FILE_LIMIT) {
      const url = files.link(filePath);
      if (url) {
        await bot.api.sendMessage(
          chatId,
          `📦 <b>${escapeHtml(name)}</b> · ${mb} MB${caption ? "\n" + escapeHtml(caption) : ""}\n⬇️ <a href="${url}">İndir</a>  <i>(link ${config.linkTtlHours} sa geçerli)</i>\n<code>${escapeHtml(url)}</code>`,
          { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
        );
      } else {
        await bot.api.sendMessage(chatId, `📦 ${name} (${mb} MB) Telegram'ın 50 MB sınırını aşıyor ve link üretilemedi: ${files.reason()}\nContainer'da: ${filePath}\nDaha küçük çıktı: /apk release`);
      }
      return Boolean(url);
    }
    await bot.api.sendDocument(chatId, new InputFile(filePath, name), { caption: caption ?? `${name} · ${mb} MB` });
    return true;
  }

  /** Son build'leri linkleriyle listele. */
  bot.command("builds", async (ctx) => {
    const root = path.join(config.dataDir, "builds");
    let dirs: string[] = [];
    try {
      dirs = fs.readdirSync(root).sort().reverse().slice(0, 8);
    } catch {
      /* yok */
    }
    if (!dirs.length) {
      await ctx.reply("Henüz build yok. /apk ile başlat.");
      return;
    }
    const lines: string[] = ["📦 <b>Son build'ler</b>"];
    for (const d of dirs) {
      const apks = fs.readdirSync(path.join(root, d)).filter((f) => /\.(apk|aab)$/.test(f));
      for (const f of apks) {
        const fp = path.join(root, d, f);
        const mb = (fs.statSync(fp).size / 1048576).toFixed(1);
        const url = files.link(fp);
        lines.push(url ? `• <a href="${url}">${escapeHtml(f)}</a> · ${mb} MB` : `• ${escapeHtml(f)} · ${mb} MB (link yok: ${escapeHtml(files.reason())})`);
      }
    }
    lines.push(`<i>linkler ${config.linkTtlHours} sa geçerli</i>`);
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  });

  /** Ajanın .agent/outbox/ altına koyduğu dosyaları gönderir, .agent/sent/ altına taşır. */
  let outboxBusy = false;
  async function flushOutbox(chatId: number): Promise<number> {
    if (outboxBusy) return 0;
    outboxBusy = true;
    let n = 0;
    try {
      const dir = path.join(config.repoDir, ".agent", "outbox");
      const sent = path.join(config.repoDir, ".agent", "sent");
      if (!fs.existsSync(dir)) return 0;
      const files = fs
        .readdirSync(dir)
        .map((f) => path.join(dir, f))
        .filter((f) => fs.statSync(f).isFile() && !path.basename(f).startsWith("."))
        .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
      for (const f of files) {
        // yazılması bitmemiş dosyayı gönderme (son 3 sn içinde değişmişse bekle)
        if (Date.now() - fs.statSync(f).mtimeMs < 3000) continue;
        try {
          await sendFile(chatId, f);
          n++;
        } catch (e: any) {
          await bot.api.sendMessage(chatId, `❌ ${path.basename(f)} gönderilemedi: ${e?.description ?? e?.message ?? e}`).catch(() => undefined);
        }
        fs.mkdirSync(sent, { recursive: true });
        fs.renameSync(f, path.join(sent, path.basename(f)));
      }
    } catch {
      /* yut */
    } finally {
      outboxBusy = false;
    }
    return n;
  }

  // ---------- IO uygulaması ----------
  function makeIO(chatId: number, title: string): { io: AgentIO; progress: ProgressMessage } {
    const sender = new Sender(bot, chatId);
    const progress = new ProgressMessage(bot, chatId, title);
    const io: AgentIO = {
      async text(md) {
        await progress.flush();
        await sender.sendMarkdown(md);
      },
      progress(line) {
        progress.push(line);
      },
      async status(line) {
        await sender.sendPlain(line);
      },
      askQuestions(questions) {
        return new Promise<Record<string, string>>((resolve, reject) => {
          const id = `q${++seq}`;
          const pq: PendingQuestion = {
            kind: "question",
            chatId,
            questions,
            index: 0,
            answers: {},
            selected: new Set(),
            resolve,
            reject,
            awaitingFreeText: false,
          };
          pending.set(id, pq);
          void progress.flush().then(() => showQuestion(id, pq));
        });
      },
      askPermission(toolName, input) {
        return new Promise<boolean>((resolve) => {
          const id = `p${++seq}`;
          const pp: PendingPermission = { kind: "permission", chatId, resolve };
          pending.set(id, pp);
          const kb = new InlineKeyboard().text("✅ İzin ver", `${id}:allow`).text("⛔ Reddet", `${id}:deny`);
          const body = JSON.stringify(input, null, 1).slice(0, 1500);
          void progress
            .flush()
            .then(() =>
              bot.api.sendMessage(
                chatId,
                `🔐 <b>İzin isteği:</b> <code>${escapeHtml(toolName)}</code>\n<pre>${escapeHtml(body)}</pre>`,
                { parse_mode: "HTML", reply_markup: kb },
              ),
            )
            .then((m) => (pp.msgId = m.message_id))
            .catch(() => undefined);
        });
      },
    };
    return { io, progress };
  }

  async function showQuestion(id: string, pq: PendingQuestion) {
    const q = pq.questions[pq.index];
    const kb = new InlineKeyboard();
    q.options.forEach((o, i) => {
      const mark = q.multiSelect ? (pq.selected.has(i) ? "☑ " : "☐ ") : "";
      kb.text(`${mark}${o.label}`.slice(0, 60), `${id}:${i}`).row();
    });
    if (q.multiSelect) kb.text("✔ Tamam", `${id}:done`).row();
    kb.text("✍️ Kendi cevabımı yazacağım", `${id}:other`);

    const lines = [
      `❓ <b>${escapeHtml(q.header ?? "Soru")}</b> (${pq.index + 1}/${pq.questions.length})`,
      escapeHtml(q.question),
      "",
      ...q.options.map((o) => `• <b>${escapeHtml(o.label)}</b>${o.description ? " — " + escapeHtml(o.description) : ""}`),
    ];
    const text = lines.join("\n").slice(0, 4000);
    if (pq.msgId) {
      try {
        await bot.api.editMessageText(pq.chatId, pq.msgId, text, { parse_mode: "HTML", reply_markup: kb });
        return;
      } catch {
        /* yeni mesaj gönder */
      }
    }
    const m = await bot.api.sendMessage(pq.chatId, text, { parse_mode: "HTML", reply_markup: kb });
    pq.msgId = m.message_id;
  }

  async function answerCurrent(id: string, pq: PendingQuestion, answer: string) {
    const q = pq.questions[pq.index];
    pq.answers[q.question] = answer;
    try {
      if (pq.msgId)
        await bot.api.editMessageText(
          pq.chatId,
          pq.msgId,
          `❓ <b>${escapeHtml(q.header ?? "Soru")}</b>\n${escapeHtml(q.question)}\n\n➡️ <b>${escapeHtml(answer)}</b>`,
          { parse_mode: "HTML" },
        );
    } catch {
      /* yut */
    }
    pq.index += 1;
    pq.selected = new Set();
    pq.msgId = undefined;
    pq.awaitingFreeText = false;
    if (pq.index < pq.questions.length) {
      await showQuestion(id, pq);
    } else {
      pending.delete(id);
      pq.resolve(pq.answers);
    }
  }

  // ---------- callback (buton) ----------
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (data.startsWith("model:")) {
      const m = data.slice(6);
      saveState({ model: m === "default" ? undefined : m });
      await ctx.answerCallbackQuery({ text: `Model: ${m === "default" ? "varsayılan" : m}` });
      try {
        await ctx.editMessageText(`🧠 Model: ${m === "default" ? "varsayılan" : m} (bir sonraki turdan itibaren)`);
      } catch {
        /* yut */
      }
      return;
    }
    const sep = data.indexOf(":");
    const id = data.slice(0, sep);
    const action = data.slice(sep + 1);
    const p = pending.get(id);
    if (!p) {
      await ctx.answerCallbackQuery({ text: "Bu soru artık geçerli değil." });
      return;
    }
    await ctx.answerCallbackQuery();

    if (p.kind === "permission") {
      pending.delete(id);
      p.resolve(action === "allow");
      try {
        if (p.msgId)
          await bot.api.editMessageText(p.chatId, p.msgId, action === "allow" ? "🔐 ✅ İzin verildi" : "🔐 ⛔ Reddedildi");
      } catch {
        /* yut */
      }
      return;
    }

    const q = p.questions[p.index];
    if (action === "other") {
      p.awaitingFreeText = true;
      await ctx.reply("✍️ Cevabını yaz:");
      return;
    }
    if (action === "done") {
      const labels = [...p.selected].sort().map((i) => q.options[i].label);
      if (!labels.length) {
        await ctx.reply("En az bir seçenek seç ya da kendi cevabını yaz.");
        return;
      }
      await answerCurrent(id, p, labels.join(", "));
      return;
    }
    const idx = Number(action);
    if (Number.isNaN(idx) || !q.options[idx]) return;
    if (q.multiSelect) {
      if (p.selected.has(idx)) p.selected.delete(idx);
      else p.selected.add(idx);
      await showQuestion(id, p);
      return;
    }
    await answerCurrent(id, p, q.options[idx].label);
  });

  // ---------- görev çalıştırma ----------
  // NOT: grammY güncellemeleri sırayla işler; bu fonksiyon handler içinde ASLA await edilmez
  // (void runPrompt(...)), yoksa ajan soru sorup cevabı beklerken buton tıklaması işlenemez.
  async function runPrompt(chatId: number, text: string, opts: { fresh?: boolean; title?: string } = {}) {
    if (agent.busy) {
      queue.push({ chatId, text });
      await bot.api.sendMessage(chatId, `⏸ Ajan meşgul; mesaj kuyruğa alındı (${queue.length}). /cancel ile durdurabilirsin.`);
      return;
    }
    const st = loadState();
    if (opts.fresh || !st.task) {
      saveState({ task: text.slice(0, 120), phase: "analyzing" });
    }
    const title = opts.title ?? text.slice(0, 60);
    const { io, progress } = makeIO(chatId, title);
    const sender = new Sender(bot, chatId);
    const typing = setInterval(() => void sender.typing(), 5000);
    const outboxTimer = setInterval(() => void flushOutbox(chatId), 15_000);
    try {
      const r = await agent.run(text, io, { fresh: opts.fresh });
      await flushOutbox(chatId);
      const s = loadState();
      await progress.close(
        `${r.ok ? "bitti" : "durdu"} · ${r.turns} tur · ${(r.durationMs / 1000).toFixed(0)}s · ≈$${r.costUsd.toFixed(2)} API eşd. (toplam ≈$${s.costUsd.toFixed(2)})`,
      );
      if (!r.ok) await sender.sendPlain(`⚠️ ${r.summary}`);
    } catch (e: any) {
      await progress.close("hata").catch(() => undefined);
      await sender.sendPlain("❌ " + (e?.message ?? String(e))).catch(() => undefined);
    } finally {
      clearInterval(typing);
      clearInterval(outboxTimer);
    }
    const next = queue.shift();
    if (next) void runPrompt(next.chatId, next.text);
  }

  function cancelPending(reason = "İptal edildi") {
    for (const [id, p] of pending) {
      pending.delete(id);
      if (p.kind === "permission") p.resolve(false);
      else p.reject(new Error(reason));
    }
  }

  // ---------- komutlar ----------
  bot.command(["start", "help"], (ctx) => ctx.reply(HELP, { parse_mode: "HTML" }));
  bot.command("whoami", (ctx) => ctx.reply(`id: ${ctx.from?.id}`));

  bot.command("new", async (ctx) => {
    if (agent.busy) {
      await ctx.reply("Önce /cancel ile çalışan işi durdur.");
      return;
    }
    cancelPending();
    queue.length = 0;
    resetState();
    const task = ctx.match?.trim();
    if (task) {
      await ctx.reply("🆕 Yeni oturum. Görev başlıyor…");
      void runPrompt(ctx.chat.id, task, { fresh: true });
    } else {
      await ctx.reply("🆕 Yeni oturum açıldı. Görevi yaz.");
    }
  });

  bot.command("status", async (ctx) => {
    await refreshUsageIfStale();
    const s = loadState();
    const branch = git("rev-parse", "--abbrev-ref", "HEAD").trim();
    const dirty = git("status", "--porcelain").trim();
    await ctx.reply(
      [
        `📍 <b>Faz:</b> ${s.phase}${s.freeMode ? " (SERBEST MOD)" : ""}`,
        `🔐 Plan onayı: ${s.approved ? "✅" : "❌"} · PR onayı: ${s.prApproved ? "✅" : "❌"}`,
        `🌿 Dal: <code>${escapeHtml(branch)}</code>${dirty ? ` · ${dirty.split("\n").length} değişik dosya` : " · temiz"}`,
        s.task ? `🎯 Görev: ${escapeHtml(s.task)}` : "🎯 Görev yok",
        s.prUrl ? `🔗 PR: ${escapeHtml(s.prUrl)}` : "",
        `🧠 Oturum: ${s.sessionId ? s.sessionId.slice(0, 8) : "-"} · ${s.turns} tur · ≈$${s.costUsd.toFixed(2)} API eşdeğeri · model: ${s.model || config.model || "varsayılan"}`,
        s.limits && Object.keys(s.limits).length ? "📊 " + escapeHtml(formatLimits(s.limits)).split("\n").join("\n    ") : "",
        `⚙️ ${agent.busy ? "çalışıyor" : "boşta"} · kuyruk: ${queue.length} · bekleyen soru: ${pending.size}`,
      ]
        .filter(Boolean)
        .join("\n"),
      { parse_mode: "HTML" },
    );
  });

  bot.command("cancel", async (ctx) => {
    cancelPending();
    queue.length = 0;
    if (agent.busy) {
      await agent.interrupt();
      await ctx.reply("🛑 Durduruluyor…");
    } else {
      await ctx.reply("Çalışan iş yok.");
    }
  });

  bot.command("approve", async (ctx) => {
    saveState({ approved: true, phase: "implementing" });
    await ctx.reply("✅ Plan kapısı elle açıldı. Ajan artık repo'ya yazabilir.");
  });

  bot.command("free", async (ctx) => {
    const s = saveState({ freeMode: !loadState().freeMode });
    await ctx.reply(s.freeMode ? "🔓 SERBEST MOD: onay kapıları kapalı (dikkatli ol)." : "🔒 Kapılar tekrar aktif.");
  });

  bot.command("init", async (ctx) => {
    void runPrompt(
      ctx.chat.id,
      "`bootstrap-env` skill'ini uygula: repoyu analiz et, gereken SDK/araçları tespit et, eksikleri $SDK_HOME altına kur, env.sh'ı güncelle ve doğrula. Sonunda kısa bir rapor ver.",
      { title: "bootstrap-env" },
    );
  });

  bot.command("review", async (ctx) => {
    void runPrompt(ctx.chat.id, "`review` skill'ini uygula: mevcut dalın değişikliklerini review et ve bulguları raporla.", {
      title: "review",
    });
  });

  bot.command("pr", async (ctx) => {
    void runPrompt(
      ctx.chat.id,
      "Review tamamlanmadıysa `review` skill'ini uygula; sonra `open-pr` skill'i ile PR onayı al ve PR'ı aç.",
      { title: "open-pr" },
    );
  });

  bot.command("diff", async (ctx) => {
    const stat = git("diff", "--stat", "HEAD");
    const full = git("diff", "HEAD");
    const sender = new Sender(bot, ctx.chat.id);
    await sender.sendMarkdown(stat.trim() ? "```\n" + stat + "\n```" : "Değişiklik yok.");
    if (full.trim()) await sender.sendDocument("changes.diff", full, "Çalışma ağacı diff'i");
  });

  let apkBusy = false;
  bot.command("apk", async (ctx) => {
    const args = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    const mode = args.find((a) => ["debug", "release", "profile"].includes(a)) ?? "debug";
    const allAbi = args.some((a) => a === "all" || a === "--all-abi" || a === "fat");
    const fi = args.findIndex((a) => a === "flavor" || a === "--flavor");
    const flavor = fi >= 0 ? args[fi + 1] : undefined;
    if (apkBusy) {
      await ctx.reply("⏳ Zaten bir APK build'i sürüyor; bitince gelecek.");
      return;
    }
    if (agent.busy) await ctx.reply("ℹ️ Ajan da çalışıyor; build paralel gidecek, biraz yavaş olabilir.");
    apkBusy = true;
    const chatId = ctx.chat.id;
    const progress = new ProgressMessage(bot, chatId, `apk ${mode}${flavor ? " " + flavor : ""}${allAbi ? " (fat)" : ""}`, 12);
    progress.push("başlıyor… (ilk seferde gradle indirir, 10-20 dk)");
    const scriptArgs = [mode, ...(allAbi ? ["--all-abi"] : []), ...(flavor ? ["--flavor", flavor] : [])];
    const child = spawn("/app/scripts/build-apk.sh", scriptArgs, { cwd: config.repoDir, env: process.env });
    const apks: { file: string; size: number }[] = [];
    const tail: string[] = [];
    const onLine = (line: string) => {
      const t = line.replace(/\s+$/, "");
      if (!t.trim()) return;
      tail.push(t);
      if (tail.length > 25) tail.shift();
      const m = t.match(/^APK: (\S+) (\d+)$/);
      if (m) apks.push({ file: m[1], size: Number(m[2]) });
      else progress.push(t.replace(/^\s+/, ""));
    };
    let buf = "";
    const feed = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const parts = buf.split(/\r?\n/);
      buf = parts.pop() ?? "";
      parts.forEach(onLine);
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("close", async (code) => {
      if (buf) onLine(buf);
      apkBusy = false;
      if (code !== 0 || !apks.length) {
        await progress.close(`hata (çıkış ${code})`);
        await new Sender(bot, chatId).sendPlain("❌ APK build başarısız. Son satırlar:\n" + tail.slice(-15).join("\n"));
        return;
      }
      // split build'de arm64 öncelikli; "all" denmediyse tek dosya gönder
      const pick = allAbi ? apks : apks.filter((a) => /arm64/.test(a.file)).length ? apks.filter((a) => /arm64/.test(a.file)) : apks.slice(0, 1);
      await progress.close(`bitti · ${apks.length} apk · gönderiliyor`);
      for (const a of pick) {
        try {
          await sendFile(chatId, a.file, `${path.basename(a.file)} · ${(a.size / 1048576).toFixed(1)} MB · ${mode}`);
        } catch (e: any) {
          await bot.api.sendMessage(chatId, `❌ gönderilemedi: ${e?.description ?? e?.message ?? e}`).catch(() => undefined);
        }
      }
      if (!allAbi && apks.length > pick.length) {
        await bot.api.sendMessage(chatId, `Diğer ABI'ler container'da: ${apks.filter((a) => !pick.includes(a)).map((a) => path.basename(a.file)).join(", ")}  (hepsi için: /apk ${mode} all)`).catch(() => undefined);
      }
    });
  });

  bot.command("limit", async (ctx) => {
    const r = await fetchUsage();
    const s = loadState();
    const head = r.ok ? "📊 Abonelik kullanımı (canlı)" : `📊 Abonelik kullanımı (son bilinen; canlı alınamadı: ${r.reason})`;
    await ctx.reply(
      head + "\n" + formatLimits(s.limits) +
        "\n\n5 saatlik pencere dolunca ajan sıfırlanmaya kadar bekler; 7 günlük dolunca hafta sonuna kadar. " +
        "Ajan çalışırken %80'i geçince ve dolunca buraya kendiliğinden uyarı gelir.",
    );
  });

  const MODEL_CHOICES = ["default", "sonnet", "opus", "haiku"];
  bot.command("model", async (ctx) => {
    const arg = (ctx.match ?? "").trim();
    if (arg) {
      const m = arg === "default" || arg === "varsayılan" ? undefined : arg;
      saveState({ model: m });
      await ctx.reply(`🧠 Model: ${m ?? "varsayılan"} (bir sonraki turdan itibaren)`);
      return;
    }
    const cur = loadState().model || config.model || "varsayılan";
    const kb = new InlineKeyboard();
    MODEL_CHOICES.forEach((m, i) => {
      kb.text((m === "default" ? "varsayılan" : m) + (cur === m || (m === "default" && cur === "varsayılan") ? " ✓" : ""), `model:${m}`);
      if (i % 2 === 1) kb.row();
    });
    await ctx.reply(
      `🧠 Şu anki model: ${cur}\nSeç ya da tam ad yaz: /model claude-sonnet-4-5\nsonnet = hızlı/ucuz, opus = en güçlü (limiti hızlı tüketir), haiku = en hafif.`,
      { reply_markup: kb },
    );
  });

  bot.command("sdk", async (ctx) => {
    let out = "";
    try {
      out = execFileSync("/app/scripts/sdk-env.sh", ["--list"], { encoding: "utf8", env: process.env });
    } catch (e: any) {
      out = "sdk-env hata: " + (e?.message ?? e);
    }
    await ctx.reply(`🧰 <b>Bağlı SDK'lar</b>\n<pre>${escapeHtml(out.trim() || "-")}</pre>\nEksik varsa: /init`, { parse_mode: "HTML" });
  });

  bot.command("log", async (ctx) => {
    const log = git("log", "--oneline", "-15");
    await ctx.reply(`<pre>${escapeHtml(log || "-")}</pre>`, { parse_mode: "HTML" });
  });

  // ---------- serbest metin ----------
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (!text) return;

    // bekleyen bir soru varsa metin cevaptır
    const waiting = [...pending.entries()].find(([, p]) => p.kind === "question") as
      | [string, PendingQuestion]
      | undefined;
    if (waiting) {
      const [id, pq] = waiting;
      await answerCurrent(id, pq, text);
      return;
    }
    void runPrompt(ctx.chat.id, text);
  });

  bot.catch((err) => {
    console.error("[bot] hata:", err.error);
  });

  return bot;
}

export function markHealthy() {
  try {
    fs.writeFileSync(config.healthPath, new Date().toISOString());
  } catch {
    /* yut */
  }
}
