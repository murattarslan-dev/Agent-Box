---
name: build-apk
description: Flutter projesinden Android APK (debug/profile/release) build eder ve kullanıcıya Telegram'dan gönderir (.agent/outbox/ üzerinden). Kullanıcı "apk ver", "build al", "telefonda deneyeyim", "apk gönder" dediğinde ya da bir özellik bittikten sonra kullanıcı elle test etmek istediğinde kullanılır. Kapı gerektirmez (repo dosyalarına yazmaz).
---

# build-apk

Amaç: kullanıcının telefonuna kurup deneyebileceği bir APK'yı en az sürtünmeyle ulaştırmak. Hazır script her şeyi yapar; sen yalnızca çağırır ve sonucu bildirirsin.

## Adımlar

1. **Dal kontrolü** — hangi daldan build alındığını kullanıcıya söyleyeceksin: `git rev-parse --abbrev-ref HEAD` ve `git status --porcelain | head` (commit'lenmemiş değişiklik varsa build'e girer; bunu belirt).

2. **Build + teslim** (tek komut, `run_in_background` ile başlat, `BashOutput` ile izle; ilk seferde 10-20 dk):
   ```bash
   /app/scripts/build-apk.sh debug --outbox 2>&1 | tail -40
   ```
   - Kullanıcı "release" dediyse `release`; cihazı bilinmiyorsa varsayılan `debug` + split-per-abi (arm64 gönderilir, ~30-45 MB).
   - Tek fat APK isteniyorsa `--all-abi` (büyük olur; Telegram 50 MB sınırını aşarsa gönderilemez — o zaman `release` dene).
   - Flavor'lu projede `--flavor <ad>`; flavor adlarını `android/app/build.gradle*`'dan oku.

3. **Sonuç** — script her çıktı için `APK: <yol> <bayt>` basar ve `--outbox` ile dosyayı `.agent/outbox/`'a koyar. Bot, tur sırasında/sonunda outbox'taki dosyaları Telegram'dan gönderir (≤ 50 MB dosya olarak, büyükler süreli download linki olarak) ve `.agent/sent/`'e taşır; senin ayrıca bir şey yapman gerekmez. Kullanıcıya kısa özet yaz: dal, commit, mod, ABI, boyut, "dosya birazdan geliyor".

4. **Hata varsa** — build çıktısının son 30 satırını oku; tipik sebepler: eksik `local.properties` (script `ANDROID_HOME`'u env'den alır, gerekmez), Gradle/AGP sürüm uyumsuzluğu (JDK 17 bağlı; `.agent/ENV.md`'ye bak), `flutter pub get` çözümleme hatası. Küçük ve kesin bir düzeltmeyse (ör. `gradle-wrapper.properties` sürümü) **plan onayı gerektirir**: `plan-and-approve` ile sor, sonra düzelt.

## Outbox kuralı (genel)

Kullanıcıya göndermek istediğin **her dosya** (APK, ekran görüntüsü, rapor, log) için `.agent/outbox/` altına kopyala; ≤ 50 MB olanlar tur sonunda otomatik gider, büyükler için yol ve boyut bildirilir. Dosya adı anlamlı olsun (`hanio-debug-arm64-3f2a1c.apk`, `login-screen.png`).
