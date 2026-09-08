#!/usr/bin/env node
// Flutter web build'ini headless Chromium'da telefon boyutunda açar ve rota rota ekran görüntüsü alır.
//   node web-shot.mjs --base http://127.0.0.1:8080 --out DIR [--routes /a,/b] [--hash] [--width 390] [--height 844]
//                     [--scale 2] [--wait 1500] [--timeout 45000] [--storage k=v ...] [--full] [--ua mobile|desktop]
// Çıktı satırları (bot ayrıştırır):  SHOT: <png yolu> <rota>      SHOTERR: <rota> <mesaj>
// Bekleme: Flutter'ın `flutter-first-frame` olayı (yoksa timeout'a kadar), ardından --wait ms (veri yüklensin).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let puppeteer;
try {
  puppeteer = require("/app/node_modules/puppeteer-core");
} catch {
  puppeteer = require("puppeteer-core");
}

const args = process.argv.slice(2);
const opt = { base: "", out: "", routes: ["/"], hash: false, width: 390, height: 844, scale: 2, wait: 1500, timeout: 45000, storage: [], full: false, ua: "mobile" };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const v = () => args[++i];
  switch (a) {
    case "--base": opt.base = v(); break;
    case "--out": opt.out = v(); break;
    case "--routes": opt.routes = v().split(",").map((s) => s.trim()).filter(Boolean); break;
    case "--hash": opt.hash = true; break;
    case "--width": opt.width = Number(v()); break;
    case "--height": opt.height = Number(v()); break;
    case "--scale": opt.scale = Number(v()); break;
    case "--wait": opt.wait = Number(v()); break;
    case "--timeout": opt.timeout = Number(v()); break;
    case "--storage": opt.storage.push(v()); break;
    case "--full": opt.full = true; break;
    case "--ua": opt.ua = v(); break;
    default: console.error(`bilinmeyen argüman: ${a}`); process.exit(2);
  }
}
if (!opt.base || !opt.out) { console.error("--base ve --out zorunlu"); process.exit(2); }
fs.mkdirSync(opt.out, { recursive: true });

const slug = (r) => (r.replace(/^[#/]+/, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "root");
const chromium = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const storage = opt.storage.map((kv) => { const i = kv.indexOf("="); return [kv.slice(0, i), kv.slice(i + 1)]; }).filter(([k]) => k);
const UA_MOBILE = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

const browser = await puppeteer.launch({
  executablePath: chromium,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--hide-scrollbars", "--font-render-hinting=none", `--window-size=${opt.width},${opt.height}`],
});
let fail = 0;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: opt.width, height: opt.height, deviceScaleFactor: opt.scale, isMobile: opt.ua === "mobile", hasTouch: opt.ua === "mobile" });
  if (opt.ua === "mobile") await page.setUserAgent(UA_MOBILE);
  await page.evaluateOnNewDocument((entries) => {
    window.__ff = false;
    window.addEventListener("flutter-first-frame", () => { window.__ff = true; });
    for (const [k, v] of entries) { try { localStorage.setItem(k, v); } catch {} }
  }, storage);
  page.on("pageerror", (e) => console.error(`[page] ${e.message}`));

  // localStorage kökene bağlı: önce kökü açıp storage'ı yaz, sonra rotalara git
  await page.goto(opt.base + "/", { waitUntil: "domcontentloaded", timeout: opt.timeout }).catch(() => undefined);

  for (const route of opt.routes) {
    const url = opt.base + (opt.hash ? "/#" + (route.startsWith("/") ? route : "/" + route) : route.startsWith("/") ? route : "/" + route);
    const file = path.join(opt.out, `${slug(route)}.png`);
    try {
      await page.goto(url, { waitUntil: "load", timeout: opt.timeout });
      // hash rotalarda goto aynı dokümanda kalabilir; Flutter ilk kareyi bir kez atar
      await page.waitForFunction(() => window.__ff === true, { timeout: opt.timeout }).catch(() => console.error(`[shot] ${route}: flutter-first-frame gelmedi, yine de çekiliyor`));
      await new Promise((r) => setTimeout(r, opt.wait));
      await page.screenshot({ path: file, fullPage: opt.full, type: "png" });
      console.log(`SHOT: ${file} ${route}`);
    } catch (e) {
      fail++;
      console.log(`SHOTERR: ${route} ${String(e?.message ?? e).split("\n")[0]}`);
    }
  }
} finally {
  await browser.close().catch(() => undefined);
}
process.exit(fail && fail === opt.routes.length ? 1 : 0);
