---
name: bootstrap-env
description: Repo'nun ihtiyaç duyduğu SDK'ları (Flutter, Dart, Go, JDK, Android SDK, Node, Rust) kontrol eder; bağlı paylaşımlı volume'larda (/sdks/<isim>/<sürüm>) yoksa sdk-install ile container'a özel $SDK_HOME'a kurar, env.sh'ı yeniler ve build/test komutlarını doğrular. İmaj SDK içermez. Tetikleyiciler: /init, "ortamı kur", "command not found", build aracı eksik, flutter/go/java yok.
---

# bootstrap-env

Amaç: bu repo'nun build/test'inin çalıştığı bir ortam. SDK'lar iki yerden gelir:

1. **Paylaşımlı volume'lar** — `/sdks/<isim>/<sürüm>` (host'ta `sdk-<isim>-<sürüm>` docker volume'u / k8s PVC'si). `up.sh` bunları repo'yu tarayarak container açılmadan **önce** bağlar. Normalde burada her şey hazırdır.
2. **Container'a özel** — `$SDK_HOME/<isim>/<sürüm>` (`/data/sdks`). Tespit kaçırdıysa ya da ek bir araç gerekiyorsa buraya kurarsın; kalıcıdır ve bir sonraki `./up.sh`'ta otomatik olarak paylaşımlı volume'a **terfi** eder (yeniden indirilmez).

Hazır komutlar (PATH'te): `sdk-detect <repo>`, `sdk-install <isim> <sürüm> [hedef]`, `sdk-env [--list]`.

## Adımlar

1. **Ne bağlı?**
   ```bash
   sdk-env --list          # isim sürüm dizin
   sdk-detect /data/repo   # repo ne istiyor? ("isim sürüm" satırları)
   ```
   İkisini karşılaştır. Aynı isim farklı sürümse **repo'nun istediği** geçerlidir.

2. **Doğrula** — her SDK için sürüm komutu (`flutter --version`, `go version`, `java -version`, `sdkmanager --list_installed`, `node -v`, `rustc --version`). `command not found` alırsan önce `source $SDK_HOME/env.sh` deneyip tekrar dene.

3. **Eksik varsa kur** (container'a özel):
   ```bash
   sdk-install jdk 17                      # hedef otomatik: $SDK_HOME/jdk/17 (volume bağlı değilse)
   sdk-install flutter 3.24.3
   sdk-env                                 # env.sh'ı yenile
   ```
   - Sıra: `jdk` → `android` → diğerleri (android, jdk'ya bağımlı).
   - Kurulum uzun sürebilir (Flutter ~5 dk, Android SDK ~5 dk): `Bash` aracını `run_in_background` ile çalıştır, `BashOutput` ile izle; Telegram'a "kuruluyor" de.
   - Desteklenmeyen bir araçsa (`sdk-install` bilmiyorsa) `$SDK_HOME/<isim>/<sürüm>/` altına elle kur ve aynı dizine `env.sh` + `.installed` (sürüm) yaz; `sdk-env` onu da toplar. `env.sh` içinde mutlak yol yerine `$SDK_DIR` kullan (`SDK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"`).
   - apt paketi gerekiyorsa: `sudo apt-get update && sudo apt-get install -y --no-install-recommends <paket>` (imaj katmanı; restart'ta gider — `.agent/ENV.md`'ye not düş).

4. **Repo'nun gerçek build/test komutunu çalıştır** (`bash -lc` ile yeni kabukta): `flutter pub get && flutter test | tail -30`, `go build ./... && go test ./... | tail -30`, `./gradlew assembleDebug | tail -20` vb.

5. **Sürümleri pinle (build başarılıysa)** — repo kökünde `.sdks` yoksa, çalışan sürümleri oraya yazmayı **öner** (repo değişikliği → `plan-and-approve` ile onay). Biçim, satır başına `isim sürüm`:
   ```
   # SDK sürümleri — claude-telegram-agent bu dosyadan kurar
   flutter 3.24.5
   jdk 17
   android 34
   ```
   `.sdks` varsa `up.sh` tahmin yapmaz, doğrudan bu volume'ları bağlar; her makine/container aynı sürümü kullanır. Flutter için ayrıca `.fvmrc` de eklenebilir (fvm kullananlar için).

6. **`.agent-tasks` öner** — repo kökünde yoksa ve varsayılan komutlar (`/app/scripts/run-task.sh --list`) projeye uymuyorsa (ör. `flutter test` yerine `make test`, flavor'lı build), `plan-and-approve` ile onay alıp ekle: satır başına `ad: komut` (test, lint, format, build, deps, doctor + özel adlar). Bot `/test`, `/lint`, `/build` komutlarını ve sen `run-task.sh`'ı bundan okur.

7. **Raporla**: `.agent/ENV.md` (bağlı SDK'lar + sürümler, build/test komutları, eksik kalanlar) ve Telegram'a ≤ 10 satır. Container'a özel kurulum yaptıysan ekle: *"`sdk-<isim>-<sürüm>` bir sonraki `./up.sh`'ta paylaşımlı volume'a alınacak."*

## Sürüm uyumsuzluğu belirtileri (önce bunu kontrol et)

`Gradle … requires`, `Minimum supported Gradle version is …`, `AGP … requires Java …`, `Unsupported class file major version`, `Your project's Gradle version is incompatible with the Java version`: neredeyse her zaman **Flutter sürümü projeninkinden daha yeni/eski** demektir, Gradle'ı yükseltmek değil. Çözüm sırası: (a) `sdk-env --list` ile bağlı Flutter'a bak, `.agent/ENV.md`'ye not düş; (b) kullanıcıya AskUserQuestion ile bilgisayarındaki sürümü sor (`flutter --version`) ve repoya `.sdks` yazmayı öner (onaylı) ya da `.env`'e `SDKS=flutter:<sürüm>,jdk:17,android:34` yazıp `./up.sh` demesini iste — doğru sürüm bağlanınca gradle-wrapper/AGP'ye dokunmadan build olur; (c) ancak kullanıcı "projeyi yeni Flutter'a taşı" derse gradle-wrapper/AGP/JDK yükseltmesini plan olarak sun.

## Kurallar

- Paylaşımlı `/sdks/...` dizinlerine **yazma** (salt okunur kabul et); pub/go/npm cache'leri zaten `$SDK_HOME` altında.
- Sürümü repo söylüyorsa onu kur (`.fvmrc`, `go.mod`, `.tool-versions`, `build.gradle` compileSdk); söylemiyorsa `sdk-detect`'in verdiğini.
- Disk: büyük kurulum öncesi `df -h $SDK_HOME | tail -1`; 3 GB altındaysa önce sor.
- Bu skill repo dosyalarına dokunmaz; kapı gerektirmez.
