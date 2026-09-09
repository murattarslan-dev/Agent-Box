---
name: build-apk
description: Flutter projesinden kullanıcının telefonuna kurabileceği EN KÜÇÜK Android APK'yı üretir ve Telegram'dan gönderir (.agent/outbox/). Hedef 50 MB altı (Telegram dosya sınırı); release → profile → debug sırasıyla dener, yalnızca arm64, obfuscate + tree-shake. Kullanıcı "apk ver", "build al", "telefonda deneyeyim" dediğinde ya da bir özellik bitince kullanılır. Repo'ya yazmaz, kapı gerektirmez; küçültme için repo değişikliği gerekiyorsa plan-and-approve ile sorar.
---

# build-apk

Amaç: kullanıcının telefonuna kurup deneyebileceği paketi, **mümkünse 50 MB'ın altında** (Telegram'dan doğrudan dosya olarak gelir) ulaştırmak. Hazır script bunun için gereken her şeyi kendisi dener; sen çağırır, sonucu yorumlar, sığmadıysa bir sonraki adımı önerirsin.

## APK_BUILDER=actions ise (sistem promptunda yazar)

Build container'da değil GitHub Actions'ta yapılır; `build-apk.sh` aynı argümanlarla `apk-remote.sh`'a devreder (workflow'u tetikler, izler, artifact'i indirir, aynı `SIZE:`/`APK:` satırlarını basar). Farklar: (1) **dal push edilmiş olmalı** — henüz push edilmemiş bir agent dalı için önce PR akışını bitir ya da kullanıcıya "PR onayından sonra APK gelecek" de; (2) repoda `.github/workflows/agent-apk.yml` olmalı (yoksa kullanıcıya `/apk setup` de; sen ekleme); (3) `flutter build apk`'yi elle çalıştırma, container'da Gradle yok. Küçültme planı/analiz kısmı aynen geçerli.

## Script ne yapıyor (bilmen yeterli, tekrar yapma)

`/app/scripts/build-apk.sh small --outbox` sırayla **release → profile → debug** dener ve limitin altına inen ilkinde durur. Her denemede:
- yalnızca **arm64-v8a** (`--split-per-abi --target-platform android-arm64`; x86/armeabi yok, ≈ 1/3 boyut),
- release/profile'da `--obfuscate --split-debug-info` (Dart sembolleri APK'dan çıkar, `symbols/` dizininde saklanır) ve `--tree-shake-icons`,
- Flutter'ın varsayılan R8 küçültmesi (release'de açık),
- imza: release/profile, proje kendi anahtarını istemiyorsa Flutter'ın debug anahtarıyla imzalanır → telefona **kurulabilir** (mağazaya gitmez).
Hiçbiri sığmazsa en küçüğünü `APK:` ile verir ve `ANALYZE:` satırlarında paketin içindeki en büyük bileşenleri (lib/, assets/, res/, en büyük 8 dosya) basar.

## Adımlar

1. **Bağlam** — `git rev-parse --abbrev-ref HEAD`, `git status --porcelain | head`; commit'lenmemiş değişiklik varsa build'e gireceğini belirt.

2. **Build** — `run_in_background` ile başlat, `BashOutput` ile izle (ilk seferde gradle indirir, 10-20 dk; sonraki ~3-5 dk):
   ```bash
   /app/scripts/build-apk.sh small --outbox 2>&1 | tail -60
   ```
   Kullanıcı açıkça "debug apk" derse `debug`, "release" derse `release`. Flavor'lu projede `--flavor <ad>` (adları `android/app/build.gradle*`'dan oku). Farklı limit: `--limit 100`.

3. **Sonucu bildir** (≤ 8 satır): dal + commit, hangi mod sığdı, boyut, "dosya birazdan geliyor" (outbox'ı bot gönderir; > 50 MB ise link olarak gelir). `SIZE:` satırlarındaki denemeleri tek satırda özetle: "release 38 MB ✓ (profile/debug denenmedi)".

4. **Sığmadıysa** — `ANALYZE:` çıktısını oku ve kullanıcıya **neyin büyük olduğunu** söyle, sonra AskUserQuestion (header: "APK") ile seçenek sun:
   - `📦 Link ile gönder` — bot zaten link üretmiştir; ek iş yok.
   - `✂️ Küçültme planı` — repo'da değişiklik gerektirir → `plan-and-approve` ile onay al, sonra uygula. Tipik kazançlar (büyükten küçüğe):
     - `assets/`: PNG → WebP (`cwebp -q 80`), gereksiz çözünürlük/asset'ler, büyük JSON/lottie'ler; fontlarda yalnızca kullanılan ağırlıklar (`fonts:` listesi), Google Fonts'u runtime'a alma.
     - `lib/arm64-v8a/`: büyük native kütüphaneler (ör. `libflutter.so` normaldir; ML/DB/ffmpeg gibi eklentiler asıl ağırlıktır) — kullanılmayan eklentileri `pubspec.yaml`'dan çıkar; `flutter pub deps` ile kimin getirdiğine bak.
     - `res/`: Android tarafı drawable'lar, `android/app/src/main/res/` altında xxxhdpi fazlalıkları.
     - `android/app/build.gradle*`: release'de `minifyEnabled true` + `shrinkResources true` (R8) ve `ndk { debugSymbolLevel 'none' }`; `abiFilters` ile tek ABI (script zaten yapıyor).
     - Son çare: `flutter build apk --analyze-size --target-platform android-arm64` ile ayrıntılı rapor.
   - `🐛 Debug olsun` — mod ne olursa olsun `debug --limit 9999` (büyük, link ile).

5. **Hata varsa** — build çıktısının son 30 satırı. Gradle/AGP/Java sürüm hataları (`Minimum supported Gradle version`, `requires Java 17`, `Unsupported class file major version`) → Flutter sürümü projeninkiyle uyuşmuyor demektir: gradle-wrapper'ı yükseltmeye kalkma; `bootstrap-env`'deki "Sürüm uyumsuzluğu" adımını uygula (kullanıcının makinesindeki sürüm → repoya `.sdks` ya da `.env` `SDKS`). Diğerleri: `key.properties`/keystore isteyen release yapılandırması (script otomatik profile'a düşer; kalıcı çözüm için release'de debug imzasına izin veren değişiklik önerebilirsin — onay gerekir), Gradle/AGP–JDK uyumsuzluğu (JDK 17 bağlı), `pub get` çözümleme hatası. Küçük ve kesin bir düzeltme bile **plan onayı** gerektirir.

## Outbox kuralı (genel)

Kullanıcıya göndermek istediğin her dosya (APK, ekran görüntüsü, rapor, log) için `.agent/outbox/` altına kopyala; ≤ 50 MB olanlar tur sırasında dosya olarak, büyükler süreli download linki olarak gider. Dosya adı anlamlı olsun (`hanio-release-arm64-v8a-3f2a1c.apk`, `login-screen.png`).
