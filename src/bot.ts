/**
 * Telegram katmanı: yetki, komutlar, mesaj → ajan, inline-buton soru/izin akışı.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { Bot, InlineKeyboard, InputFile, InputMediaBuilder, type Context } from "grammy";
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
/quick [görev] — hızlı mod: analiz + alt-ajan review yok (typo, config, tek dosya)
/status — faz, dal, maliyet
/cancel — çalışan işi durdur
/init — repo'yu analiz edip eksik SDK'ları kur (bootstrap-env)
/karakter — repo için "sanal karakter" dosyası (CLAUDE.md) üret/güncelle: mimari kuralları + komutlar + sdk'lar, onaylı PR
/review — mevcut değişiklikleri review et
/pr — review + PR onayı + PR aç
/diff — çalışma ağacındaki değişiklikler
/log — son commit'ler
/sdk — bağlı SDK'lar
/limit — abonelik kullanımı (5 saat / 7 gün, canlı)
/model [ad] — modeli seç (sonnet / opus / haiku / tam ad)
/test /lint /build /format /doctor — repo görevini Claude'suz çalıştır (.agent-tasks ya da varsayılan); hata olursa "ajana düzelttir" butonu
/task [ad] — görev listesi / özel görev
/apk [small|release|profile|debug] [all] [flavor X] [limit MB] [ref dal] — en küçük APK'yı build et ve gönder (≤50 MB dosya, üstü link); APK_BUILDER=actions ise GitHub Actions'ta
/apk setup — hedef repoya Actions workflow'unu PR ile ekle (container'da JDK/Android gerekmez)
/preview [build|stop] — uygulamayı web olarak yayınla, telefondan açacağın link gönder (girişi kendin yaparsın; token gerekmez)
/ss [rota…] [build] [hash] [desktop] — Flutter web build'ini telefon boyutunda açıp ekran görüntüsü gönder (emülatörsüz); rotalar CLAUDE.md'den
/builds — son build'ler ve linkleri
/tunnel [check|restart] — download linki tüneli durumu
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

  /** PNG/JPG'leri fotoğraf olarak (albüm, 10'arlı) gönderir; Telegram fotoğraf sınırı 10 MB, üstü belge olarak gider. */
  const IMG_RE = /\.(png|jpe?g|webp)$/i;
  async function sendPhotos(chatId: number, items: { file: string; caption?: string }[]): Promise<void> {
    const photos = items.filter((i) => IMG_RE.test(i.file) && fs.statSync(i.file).size <= 10 * 1024 * 1024);
    const rest = items.filter((i) => !photos.includes(i));
    for (let i = 0; i < photos.length; i += 10) {
      const group = photos.slice(i, i + 10);
      if (group.length === 1) {
        await bot.api.sendPhoto(chatId, new InputFile(group[0].file), { caption: group[0].caption ?? path.basename(group[0].file) });
      } else {
        await bot.api.sendMediaGroup(chatId, group.map((g) => InputMediaBuilder.photo(new InputFile(g.file), { caption: g.caption ?? path.basename(g.file) })));
      }
    }
    for (const r of rest) await sendFile(chatId, r.file, r.caption);
  }

  bot.command("tunnel", async (ctx) => {
    const arg = (ctx.match ?? "").trim();
    if (arg === "restart") {
      files.restartTunnel();
      await ctx.reply("🔁 cloudflared yeniden başlatılıyor; ~20 sn sonra /tunnel ile bak.");
      return;
    }
    if (arg === "check") await files.verify();
    const base = files.baseUrl;
    let probe = "";
    if (base) {
      const url = files.link(path.join(config.dataDir, "state.json"));
      probe = url ? `\n\nTest linki (küçük json, 24 sa): ${url}` : "";
    }
    await ctx.reply("🌐 Dosya linkleri\n" + files.status() + probe + "\n\nKomutlar: /tunnel check · /tunnel restart");
  });

  /** Web build'ini /app/ altında yayınla ve linki gönder (web-build.sh sonrası). */
  async function publishPreview(chatId: number, note?: string): Promise<void> {
    const dir = path.join(config.repoDir, "build", "web");
    if (!fs.existsSync(path.join(dir, "index.html"))) {
      await bot.api.sendMessage(chatId, "❌ build/web yok; /preview build ile derle.");
      return;
    }
    const url = files.setPreview(dir);
    if (!url) {
      await bot.api.sendMessage(chatId, `❌ Dışarıdan erişilebilir adres yok: ${files.reason()}`);
      return;
    }
    await bot.api.sendMessage(
      chatId,
      `📱 <b>Uygulama önizlemesi</b>${note ? " · " + escapeHtml(note) : ""}\n<a href="${url}">Telefonda aç</a>  <i>(${config.linkTtlHours} sa geçerli; anahtar ilk açılışta çereze yazılır)</i>\n<code>${escapeHtml(url)}</code>\nGiriş ekranından kendin giriş yaparsın. Yeni build sonrası aynı link çalışmaya devam eder; kapatmak için /preview stop.`,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
    );
  }

  /** /preview [build|stop] — Flutter web build'ini telefondan açılacak bir linkle yayınla (Claude çalışmaz). */
  let previewBusy = false;
  bot.command(["preview", "onizle", "önizle"], async (ctx) => {
    const arg = (ctx.match ?? "").trim();
    const chatId = ctx.chat.id;
    if (arg === "stop" || arg === "kapat") {
      files.clearPreview();
      await ctx.reply("🛑 Önizleme kapatıldı; eski link artık çalışmaz.");
      return;
    }
    if (arg === "status" || arg === "durum") {
      await ctx.reply("📱 Önizleme: " + (files.previewStatus() ?? "kapalı"));
      return;
    }
    if (previewBusy) {
      await ctx.reply("⏳ Web build sürüyor; bitince link gelecek.");
      return;
    }
    previewBusy = true;
    const progress = new ProgressMessage(bot, chatId, `preview${arg === "build" ? " (build)" : ""}`, 12);
    progress.push("web build kontrol ediliyor (değiştiyse 1-3 dk)…");
    const child = spawn("/app/scripts/web-build.sh", arg === "build" ? ["--force"] : [], { cwd: config.repoDir, env: process.env });
    const tail: string[] = [];
    let built = "";
    let buf = "";
    const onLine = (line: string) => {
      const t = line.replace(/\s+$/, "");
      if (!t.trim()) return;
      tail.push(t);
      if (tail.length > 25) tail.shift();
      const m = t.match(/^WEB: (\S+) (built|cached)$/);
      if (m) built = m[2];
      else progress.push(t.replace(/^\[web\]\s*/, ""));
    };
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
      previewBusy = false;
      if (code !== 0 || !built) {
        await progress.close(`hata (çıkış ${code})`);
        await new Sender(bot, chatId).sendPlain("❌ Web build başarısız. Son satırlar:\n" + tail.slice(-15).join("\n"));
        return;
      }
      await progress.close(built === "built" ? "build tamam" : "build güncel");
      await publishPreview(chatId, built === "built" ? "yeni build" : "mevcut build");
    });
  });

  /** /ss [rota…] [build] [hash] [desktop] [full] — Flutter web build'ini headless Chromium'da açıp ekran görüntüsü al (Claude çalışmaz). */
  let ssBusy = false;
  bot.command(["ss", "screenshot"], async (ctx) => {
    const args = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    const flags: string[] = [];
    const routes: string[] = [];
    for (const a of args) {
      if (a === "build") flags.push("--build");
      else if (a === "hash") flags.push("--hash");
      else if (a === "desktop") flags.push("--desktop");
      else if (a === "full") flags.push("--full");
      else if (a.startsWith("--")) flags.push(a);
      else routes.push(a);
    }
    if (ssBusy) {
      await ctx.reply("⏳ Zaten ekran görüntüsü alınıyor; bitince gelecek.");
      return;
    }
    ssBusy = true;
    const chatId = ctx.chat.id;
    const progress = new ProgressMessage(bot, chatId, `screenshot ${routes.join(" ") || "(CLAUDE.md rotaları)"}`, 12);
    progress.push("web build kontrol ediliyor (değiştiyse 1-3 dk)…");
    const child = spawn("/app/scripts/screenshot.sh", [...routes, ...flags], { cwd: config.repoDir, env: process.env });
    const shots: { file: string; caption: string }[] = [];
    const errs: string[] = [];
    const tail: string[] = [];
    let buf = "";
    const onLine = (line: string) => {
      const t = line.replace(/\s+$/, "");
      if (!t.trim()) return;
      tail.push(t);
      if (tail.length > 25) tail.shift();
      let m: RegExpMatchArray | null;
      if ((m = t.match(/^SHOT: (\S+) (.*)$/))) shots.push({ file: m[1], caption: m[2] });
      else if ((m = t.match(/^SHOTERR: (\S+) (.*)$/))) errs.push(`${m[1]}: ${m[2]}`);
      else if (/^SHOTS: /.test(t)) return;
      else progress.push(t.replace(/^\[shot\]\s*/, ""));
    };
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
      ssBusy = false;
      if (!shots.length) {
        await progress.close(`hata (çıkış ${code})`);
        await new Sender(bot, chatId).sendPlain("❌ Ekran görüntüsü alınamadı. Son satırlar:\n" + tail.slice(-15).join("\n"));
        return;
      }
      await progress.close(`${shots.length} görüntü${errs.length ? `, ${errs.length} hata` : ""}`);
      try {
        await sendPhotos(chatId, shots);
      } catch (e: any) {
        await bot.api.sendMessage(chatId, `❌ gönderilemedi: ${e?.description ?? e?.message ?? e}`).catch(() => undefined);
      }
      if (errs.length) await bot.api.sendMessage(chatId, "⚠️ Alınamayan rotalar:\n" + errs.join("\n")).catch(() => undefined);
    });
  });

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
      const req = path.join(config.repoDir, ".agent", "preview.request");
      if (fs.existsSync(req)) {
        const note = fs.readFileSync(req, "utf8").trim().slice(0, 80);
        fs.unlinkSync(req);
        await publishPreview(chatId, note || undefined);
        n++;
      }
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
          if (IMG_RE.test(f)) await sendPhotos(chatId, [{ file: f }]);
          else await sendFile(chatId, f);
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
    if (data.startsWith("fix:") || data.startsWith("log:")) {
      const id = data.slice(4);
      const f = failFixes.get(id);
      if (!f) {
        await ctx.answerCallbackQuery({ text: "Bu kayıt artık yok." });
        return;
      }
      await ctx.answerCallbackQuery();
      if (data.startsWith("log:")) {
        try {
          await sendFile(ctx.chat!.id, f.log, `${f.task} tam log`);
        } catch (e: any) {
          await ctx.reply("log gönderilemedi: " + (e?.message ?? e));
        }
        return;
      }
      failFixes.delete(id);
      void runPrompt(
        ctx.chat!.id,
        `\`${f.task}\` görevi başarısız oldu (çıkış kodu ${f.code}). Komut: /app/scripts/run-task.sh ${f.task}\nSon satırlar:\n\`\`\`\n${f.tail}\n\`\`\`\nTam log: ${f.log} (gerekirse \`tail -n 200 ${f.log}\`). Sebebi bul, düzelt (repo değişikliği plan onayı gerektirir), sonra aynı komutla doğrula.`,
        { title: `${f.task} düzelt` },
      );
      return;
    }
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
      const k = (n: number) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n));
      const tk = r.tokens;
      const tokLine = tk
        ? ` · ${k(tk.input + tk.cacheRead + tk.cacheWrite)} giriş (${tk.input + tk.cacheRead + tk.cacheWrite ? Math.round((100 * tk.cacheRead) / (tk.input + tk.cacheRead + tk.cacheWrite)) : 0}% cache) / ${k(tk.output)} çıkış`
        : "";
      await progress.close(
        `${r.ok ? "bitti" : "durdu"} · ${r.turns} tur · ${(r.durationMs / 1000).toFixed(0)}s${tokLine} · ≈$${r.costUsd.toFixed(2)} (toplam ≈$${s.costUsd.toFixed(2)})`,
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

  bot.command("quick", async (ctx) => {
    const task = (ctx.match ?? "").trim();
    if (agent.busy) {
      await ctx.reply("Önce /cancel ile çalışan işi durdur.");
      return;
    }
    if (!task) {
      const s = saveState({ quick: !loadState().quick });
      await ctx.reply(s.quick ? "⚡ Hızlı mod açık: analiz ve alt-ajan review atlanır (küçük işler). Görevi yaz." : "Hızlı mod kapalı.");
      return;
    }
    cancelPending();
    queue.length = 0;
    resetState();
    saveState({ quick: true });
    await ctx.reply("⚡ Hızlı mod · yeni oturum. Başlıyor…");
    void runPrompt(ctx.chat.id, task, { fresh: true });
  });

  bot.command("status", async (ctx) => {
    await refreshUsageIfStale();
    const s = loadState();
    const branch = git("rev-parse", "--abbrev-ref", "HEAD").trim();
    const dirty = git("status", "--porcelain").trim();
    await ctx.reply(
      [
        `📍 <b>Faz:</b> ${s.phase}${s.freeMode ? " (SERBEST MOD)" : ""}${s.quick ? " ⚡hızlı" : ""}`,
        `🔐 Plan onayı: ${s.approved ? "✅" : "❌"} · PR onayı: ${s.prApproved ? "✅" : "❌"}`,
        `🌿 Dal: <code>${escapeHtml(branch)}</code>${dirty ? ` · ${dirty.split("\n").length} değişik dosya` : " · temiz"}`,
        s.task ? `🎯 Görev: ${escapeHtml(s.task)}` : "🎯 Görev yok",
        s.prUrl ? `🔗 PR: ${escapeHtml(s.prUrl)}` : "",
        `🧠 Oturum: ${s.sessionId ? s.sessionId.slice(0, 8) : "-"} · ${s.turns} tur · ≈$${s.costUsd.toFixed(2)} API eşdeğeri · model: ${s.model || config.model || "varsayılan"}`,
        s.tokens ? `🔢 Token: ${Math.round((s.tokens.input + s.tokens.cacheRead + s.tokens.cacheWrite) / 1000)}k giriş (${s.tokens.input + s.tokens.cacheRead + s.tokens.cacheWrite ? Math.round((100 * s.tokens.cacheRead) / (s.tokens.input + s.tokens.cacheRead + s.tokens.cacheWrite)) : 0}% cache) · ${Math.round(s.tokens.output / 1000)}k çıkış` : "",
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

  bot.command(["karakter", "character"], async (ctx) => {
    const extra = (ctx.match || "").toString().trim();
    void runPrompt(
      ctx.chat.id,
      "`character` skill'ini uygula: repo için karakter dosyasını (CLAUDE.md) üret ya da güncelle; taslağı .agent/outbox'a koy, onay al, agent/character dalında commit'le ve PR onayı iste." +
        (extra ? ` Kullanıcı notu: ${extra}` : ""),
      { title: "character", fresh: true },
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

  // ---------- deterministik görevler: /test /lint /build /format /doctor /task <ad> (Claude çalışmaz) ----------
  let taskBusy = false;
  const failFixes = new Map<string, { task: string; tail: string; log: string; code: number }>();
  async function runTask(chatId: number, task: string, extra: string[] = []) {
    if (taskBusy) {
      await bot.api.sendMessage(chatId, "⏳ Başka bir görev sürüyor; bitince dene.");
      return;
    }
    taskBusy = true;
    const progress = new ProgressMessage(bot, chatId, `${task}${extra.length ? " " + extra.join(" ") : ""}`, 14);
    const child = spawn("/app/scripts/run-task.sh", [task, ...extra], { cwd: config.repoDir, env: { ...process.env, TASK_TAIL: "60" } });
    const tail: string[] = [];
    let summary: RegExpMatchArray | null = null;
    let buf = "";
    const feed = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const parts = buf.split(/\r?\n/);
      buf = parts.pop() ?? "";
      for (const line of parts) {
        const t = line.replace(/\s+$/, "");
        if (!t.trim()) continue;
        const m = t.match(/^TASK: (\S+) (ok|fail) (\d+) (\S+)(?: \((\d+)s\))?$/);
        if (m) {
          summary = m;
          continue;
        }
        tail.push(t);
        if (tail.length > 60) tail.shift();
        if (!t.startsWith("[task]")) progress.push(t.replace(/^\s+/, ""));
        else progress.push(t);
      }
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("close", async (code) => {
      taskBusy = false;
      const ok = code === 0;
      const dur = summary?.[5] ? ` · ${summary[5]}s` : "";
      await progress.close(ok ? `✅ ${task} geçti${dur}` : `❌ ${task} başarısız (kod ${code})${dur}`);
      if (ok) return;
      const id = `f${++seq}`;
      const log = summary?.[4] ?? "-";
      failFixes.set(id, { task, tail: tail.slice(-40).join("\n"), log, code: code ?? 1 });
      const kb = new InlineKeyboard().text("🤖 Ajana düzelttir", `fix:${id}`).text("📄 Tam log", `log:${id}`);
      await bot.api.sendMessage(chatId, `<b>${escapeHtml(task)}</b> başarısız. Son satırlar:\n<pre>${escapeHtml(tail.slice(-15).join("\n"))}</pre>`, {
        parse_mode: "HTML",
        reply_markup: kb,
      });
    });
  }
  for (const t of ["test", "lint", "build", "format", "doctor", "deps"]) {
    bot.command(t, (ctx) => runTask(ctx.chat.id, t, (ctx.match ?? "").trim().split(/\s+/).filter(Boolean)));
  }
  bot.command("task", async (ctx) => {
    const args = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    if (!args.length) {
      let list = "";
      try {
        list = execFileSync("/app/scripts/run-task.sh", ["--list"], { encoding: "utf8", cwd: config.repoDir, env: process.env });
      } catch (e: any) {
        list = String(e?.stdout ?? e?.message ?? e);
      }
      await ctx.reply(`<pre>${escapeHtml(list.trim())}</pre>\nKullanım: /task &lt;ad&gt; · repo köküne .agent-tasks ile özelleştir ("ad: komut")`, { parse_mode: "HTML" });
      return;
    }
    await runTask(ctx.chat.id, args[0], args.slice(1));
  });

  let apkBusy = false;
  /**
   * APK üret ve gönder. builder=local → /app/scripts/build-apk.sh (container'da flutter+gradle);
   * builder=actions → /app/scripts/apk-remote.sh (GitHub Actions tetikle/izle/indir). İki script de aynı satırları basar.
   * runId verilirse yalnızca o koşunun artifact'i indirilir (webhook / push tetiklemeli koşular).
   */
  async function runApkBuild(chatId: number, opts: { mode?: string; flavor?: string; limit?: string; allAbi?: boolean; ref?: string; runId?: string; note?: string }) {
    const mode = opts.mode ?? "small";
    const builder = config.apkBuilder;
    if (apkBusy) {
      await bot.api.sendMessage(chatId, "⏳ Zaten bir APK build'i sürüyor; bitince gelecek.");
      return;
    }
    if (builder === "local" && agent.busy) await bot.api.sendMessage(chatId, "ℹ️ Ajan da çalışıyor; build paralel gidecek, biraz yavaş olabilir.");
    apkBusy = true;
    const title = opts.runId ? `apk (Actions koşusu ${opts.runId})` : `apk ${mode}${opts.flavor ? " " + opts.flavor : ""}${opts.allAbi ? " (fat)" : ""}${builder === "actions" ? " · GitHub Actions" : ""}`;
    const progress = new ProgressMessage(bot, chatId, title, 12);
    if (opts.runId) progress.push("artifact indiriliyor…");
    else if (builder === "actions") progress.push("workflow tetikleniyor; cache'li koşu 4-8 dk, ilk koşu 10-15 dk");
    else progress.push(mode === "small" ? "hedef ≤ 50 MB: release → profile → debug, yalnızca arm64 (ilk seferde 10-20 dk)" : "başlıyor… (ilk seferde gradle indirir, 10-20 dk)");
    const script = builder === "actions" ? "/app/scripts/apk-remote.sh" : "/app/scripts/build-apk.sh";
    const scriptArgs = opts.runId
      ? ["--run", opts.runId]
      : [mode, ...(opts.allAbi ? ["--all-abi"] : []), ...(opts.flavor ? ["--flavor", opts.flavor] : []), ...(opts.limit ? ["--limit", opts.limit] : []), ...(opts.ref && builder === "actions" ? ["--ref", opts.ref] : [])];
    const child = spawn(script, scriptArgs, { cwd: config.repoDir, env: process.env });
    const apks: { file: string; size: number }[] = [];
    const sizes: string[] = [];
    const analyze: string[] = [];
    const tail: string[] = [];
    let runUrl = "";
    const onLine = (line: string) => {
      const t = line.replace(/\s+$/, "");
      if (!t.trim()) return;
      tail.push(t);
      if (tail.length > 25) tail.shift();
      let m: RegExpMatchArray | null;
      if ((m = t.match(/^APK: (\S+) (\d+)$/))) apks.push({ file: m[1], size: Number(m[2]) });
      else if ((m = t.match(/^SIZE: \S+ (\S+) (\S+) (\S+)$/))) {
        sizes.push(`${m[2]} ${m[1]} MB ${m[3] === "sığdı" ? "✓" : "✗"}`);
        progress.push(`${m[2]}: ${m[1]} MB ${m[3] === "sığdı" ? "✓ sığdı" : "✗ büyük"}`);
      } else if ((m = t.match(/^ANALYZE: (.*)$/))) analyze.push(m[1]);
      else if ((m = t.match(/^RUN: (\S+)$/))) {
        runUrl = m[1];
        progress.push(`koşu: ${runUrl}`);
      } else progress.push(t.replace(/^\s+/, "").replace(/^\[apk(-ci)?\]\s*/, ""));
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
        await new Sender(bot, chatId).sendPlain("❌ APK build başarısız. Son satırlar:\n" + tail.slice(-15).join("\n") + (runUrl ? "\n\nKoşu: " + runUrl : ""));
        return;
      }
      await progress.close(`bitti · ${sizes.join(" · ") || apks.length + " apk"}`);
      for (const a of apks) {
        try {
          await sendFile(chatId, a.file, `${path.basename(a.file)} · ${(a.size / 1048576).toFixed(1)} MB${opts.note ? " · " + opts.note : ""}${sizes.length ? " · denemeler: " + sizes.join(", ") : ""}`);
        } catch (e: any) {
          await bot.api.sendMessage(chatId, `❌ gönderilemedi: ${e?.description ?? e?.message ?? e}`).catch(() => undefined);
        }
      }
      if (analyze.length) {
        await bot.api
          .sendMessage(chatId, "📐 Limitin üstünde kaldı; paketi büyüten bileşenler:\n<pre>" + escapeHtml(analyze.join("\n")) + "</pre>\nKüçültme için ajana yaz: \"apk'yı küçültme planı çıkar\" (build-apk skill'i asset/eklenti önerileri sunar).", { parse_mode: "HTML" })
          .catch(() => undefined);
      }
    });
  }

  /** /apk setup — hedef repoya Actions workflow'unu PR ile ekle (Claude çalışmaz, bot doğrudan git+gh). */
  async function apkSetup(chatId: number) {
    if (config.provider !== "github") {
      await bot.api.sendMessage(chatId, "APK_BUILDER=actions yalnızca GitHub için; GitLab CI şablonu henüz yok.");
      return;
    }
    const tpl = "/app/templates/github/agent-apk.yml";
    const rel = path.join(".github", "workflows", config.apkWorkflow);
    const branch = "agent/ci-apk";
    const r = (...a: string[]) => git(...a);
    const dirty = r("status", "--porcelain").trim();
    if (dirty && !dirty.startsWith("git hata")) {
      await bot.api.sendMessage(chatId, "Çalışma ağacı kirli; önce ajanın işini bitir/commit'le (/diff ile bak), sonra tekrar /apk setup.");
      return;
    }
    const cur = r("rev-parse", "--abbrev-ref", "HEAD").trim();
    try {
      r("fetch", "origin");
      r("switch", "-C", branch, `origin/${config.defaultBranch}`);
      fs.mkdirSync(path.join(config.repoDir, ".github", "workflows"), { recursive: true });
      fs.copyFileSync(tpl, path.join(config.repoDir, rel));
      r("add", rel);
      r("commit", "-m", "ci: add agent-apk workflow (APK built on GitHub Actions for claude-telegram-agent)");
      const push = r("push", "-u", "origin", branch, "--force-with-lease");
      if (push.startsWith("git hata")) throw new Error(push);
      const pr = execFileSync("gh", ["pr", "create", "--head", branch, "--base", config.defaultBranch, "--title", "ci: agent-apk workflow", "--body", "APK artık GitHub Actions'ta üretilir; bot `gh workflow run` ile tetikler, artifact'i indirip Telegram'a gönderir. Container'da JDK/Android/Gradle gerekmez.\n\n🤖 claude-telegram-agent `/apk setup`"], { cwd: config.repoDir, encoding: "utf8" }).trim();
      await bot.api.sendMessage(
        chatId,
        `✅ Workflow PR'ı açıldı: ${pr}\n\nMerge ettikten sonra:\n1) .env: <code>APK_BUILDER=actions</code> (container'da JDK/Android gerekmez → <code>SDKS=flutter:&lt;sürüm&gt;</code>)\n2) REPO_TOKEN izni: <b>Actions → Read and write</b> (tetikleme + artifact indirme; fine-grained PAT'ta ekle)\n3) İsteğe bağlı hız: repo secrets <code>AGENT_WEBHOOK_URL</code>=${escapeHtml((files.baseUrl ?? "https://<bot-adresi>") + "/hook/build")} ve <code>AGENT_WEBHOOK_SECRET</code>=.env'deki <code>BUILD_WEBHOOK_SECRET</code>\n\nSonra <code>/apk</code> Actions'ta build alır; <code>agent/**</code> dallarına push'ta da otomatik koşar ve webhook varsa APK kendiliğinden gelir.`,
        { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
      );
    } catch (e: any) {
      const err = String(e?.stderr ?? e?.message ?? e);
      let hint = "";
      if (/workflow.*scope|without `workflow`|refusing to allow.*workflow/i.test(err)) {
        hint =
          "\n\n➡️ GitHub, workflow dosyası push'una ayrı izin ister. REPO_TOKEN'ı düzenle: fine-grained PAT'ta <b>Workflows: Read and write</b> (Actions'tan ayrı bir satır); classic PAT'ta <code>workflow</code> scope'u. Sonra tekrar /apk setup. Alternatif: dosyayı elle ekle — şablon <code>templates/github/agent-apk.yml</code>, hedef <code>.github/workflows/agent-apk.yml</code>.";
      } else if (/403|permission|not permitted/i.test(err)) {
        hint = "\n\n➡️ Token izinlerine bak: Contents RW, Pull requests RW, Workflows RW, Actions RW.";
      }
      await bot.api.sendMessage(chatId, `❌ setup başarısız: <pre>${escapeHtml(err.slice(0, 600))}</pre>${hint}`, { parse_mode: "HTML" });
    } finally {
      if (cur && cur !== "HEAD") r("switch", cur);
    }
  }

  bot.command("apk", async (ctx) => {
    const args = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    if (args[0] === "setup") {
      await apkSetup(ctx.chat.id);
      return;
    }
    if (args[0] === "run" && args[1]) {
      void runApkBuild(ctx.chat.id, { runId: args[1] });
      return;
    }
    const mode = args.find((a) => ["small", "debug", "release", "profile"].includes(a)) ?? "small";
    const li = args.findIndex((a) => a === "limit" || a === "--limit");
    const limit = li >= 0 ? args[li + 1] : undefined;
    const allAbi = args.some((a) => a === "all" || a === "--all-abi" || a === "fat");
    const fi = args.findIndex((a) => a === "flavor" || a === "--flavor");
    const flavor = fi >= 0 ? args[fi + 1] : undefined;
    const ri = args.findIndex((a) => a === "ref" || a === "branch" || a === "--ref");
    const ref = ri >= 0 ? args[ri + 1] : undefined;
    void runApkBuild(ctx.chat.id, { mode, flavor, limit, allAbi, ref });
  });

  // GitHub Actions webhook ping'i: süren build varsa polling'i kısaltır; yoksa (push tetiklemeli koşu) APK'yı indirip gönderir.
  files.onBuildHook = (p) => {
    const runId = String(p.run_id ?? "");
    if (!/^\d+$/.test(runId)) return;
    const hooks = path.join(config.dataDir, "hooks");
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(path.join(hooks, `${runId}.done`), JSON.stringify(p));
    const chatId = config.allowedUserIds[0];
    if (!chatId || apkBusy) return;
    if (p.status !== "success") {
      void bot.api.sendMessage(chatId, `❌ Actions APK koşusu başarısız (${p.ref ?? "?"}, run ${runId}): ${p.status}`).catch(() => undefined);
      return;
    }
    void runApkBuild(chatId, { runId, note: `Actions · ${p.ref ?? ""} ${String(p.sha ?? "").slice(0, 7)}`.trim() });
  };

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
