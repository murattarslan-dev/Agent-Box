# Railway'de (ya da benzer bir PaaS'ta) çalıştırmak

Bot bir Docker imajı + tek bir kalıcı volume (`/data`) ister; Railway bunu doğrudan verir. Fark: `up.sh` yok, o yüzden
SDK'lar önden volume'a kurulmaz — container açılışta kendisi kurar (`SDK_AUTOINSTALL=1`). Maliyeti düşük tutmanın
anahtarı **APK build'ini GitHub Actions'a taşımak** (`APK_BUILDER=actions`): container'da JDK/Android/Gradle olmaz,
RAM tepe noktası kaybolur, volume 1.5-2 GB'ta kalır.

## Adımlar

1. **Repo'yu Railway'e bağla** — New Project → Deploy from GitHub repo → `claude-telegram-agent`. Dockerfile otomatik
   tanınır. (Alternatif: `railway up` CLI.)
2. **Volume** — servise bir volume ekle, mount path `/data`. Boyut: Flutter SDK + pub cache + repo için 3-5 GB yeter.
3. **Değişkenler** (Variables sekmesi) — `.env.example`'daki zorunlular + şunlar:

   ```
   SDK_AUTOINSTALL=1
   SDKS=flutter:3.24.5            # bilgisayarındaki sürüm; jdk/android YOK (Actions'ta)
   APK_BUILDER=actions
   FILE_LINKS=lan
   PUBLIC_BASE_URL=https://<servis>.up.railway.app   # Settings → Networking → Generate Domain
   BUILD_WEBHOOK_SECRET=<openssl rand -hex 16>        # isteğe bağlı
   TZ=Europe/Istanbul
   ```

   Railway `PORT` değişkenini kendisi verir; bot HTTP sunucusu (download linkleri, `/preview`, webhook) onu dinler.
   Cloudflare tüneli gerekmez.
4. **Deploy** — ilk açılışta Flutter SDK arka planda iner (2-5 dk; `/sdk` ile durum, log `/data/logs/sdk-autoinstall.log`).
   Bot bu sırada çalışır; `/status` yazınca cevap gelir.
5. **Actions workflow'u** — Telegram'da `/apk setup`: hedef repoya `.github/workflows/agent-apk.yml` PR'ı açılır.
   Merge et. `REPO_TOKEN` (fine-grained PAT) izinlerine **Actions: Read and write** ekle.
6. **Webhook (isteğe bağlı)** — hedef repo → Settings → Secrets → `AGENT_WEBHOOK_URL=https://<servis>.up.railway.app/hook/build`,
   `AGENT_WEBHOOK_SECRET=<aynı değer>`. Bu olmadan da `/apk` çalışır (bot koşuyu 20 sn'de bir sorgular); webhook ile
   `agent/**` dallarına her push'ta üretilen APK Telegram'a kendiliğinden gelir.

## Kaynak boyutu

Boşta bot ~250-350 MB RAM, ~0 CPU. Ajan çalışırken (Claude Code + `flutter test`/`dart analyze`) 1-1.5 GB. Web
önizleme/ekran görüntüsü (`flutter build web` + Chromium) anlık 2 GB'a çıkabilir; Railway'de servis limitini 2 GB'a
çek ya da bu iki özelliği seyrek kullan. APK build'i Actions'ta olduğu için 4-6 GB'lık Gradle tepe noktası yok.

Fatura kalemleri: vCPU-saat + RAM-GB-saat (yalnızca kullanılan), volume GB-ay, egress. Güncel fiyatlar için
Railway'in pricing sayfasına bak; kabaca boşta bekleyen bot ayda birkaç dolar, kullanım ajanın ne kadar çalıştığına
bağlı. GitHub Actions: private repoda ayda 2000 dk ücretsiz (cache'li Flutter APK koşusu 4-8 dk).

## Notlar

- `SDKS` yalnızca `flutter:<sürüm>` olsun; `jdk`/`android` eklersen volume'a 3-4 GB iner ve gerekmez.
- Repo'nun `.tool-versions` / `.sdks` / `CLAUDE.md` ```sdks bloğu Actions'ta da okunur; sürümü bir yerde tut.
- Web önizleme (`/preview`) ve `/ss` için Chromium imajda var, ek ayar gerekmez; `PUBLIC_BASE_URL` yeterli.
- Log: Railway → Deployments → View logs; ajan logları ayrıca `/data/logs`.
- Yeniden deploy volume'u silmez; repo klonu, oturumlar ve SDK'lar kalır.
