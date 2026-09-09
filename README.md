# claude-telegram-agent

Telefonundan Telegram'la yönettiğin, bir git deposunda **Claude Code** ile çalışan otonom geliştirme ajanı.
Görevi yazarsın; ajan mimariyi analiz eder, plan sunar, **onayını alır**, geliştirir, kendi işini review eder,
**PR onayını alır** ve PR'ı açar. Tek Docker container'ı, tek script; WSL2, Linux, macOS ya da Kubernetes.

```
  sen (Telegram) ──▶ bot ──▶ Claude Code (Agent SDK) ──▶ /data/repo ──▶ PR
        ▲              │  ✅ Onayla / ✏️ Değiştir / ❌ İptal   │
        └──────────────┴──── ilerleme · sorular · özet ◀────┘
```

## Hızlı başlangıç

```bash
git clone https://github.com/<sen>/claude-telegram-agent.git
cd claude-telegram-agent
./up.sh
```

İlk çalıştırmada bir sihirbaz beş değeri sorar ve her birini anında doğrular; sonra imajı build eder, repo'nun
ihtiyaç duyduğu SDK'ları kurar ve botu başlatır. Sihirbaz sana şunları soracak, önceden hazırlayabilirsin:

| # | Değer | Nereden |
|---|-------|---------|
| 1 | **Claude token** | Kendi makinende `npm i -g @anthropic-ai/claude-code && claude setup-token` → `sk-ant-oat01-…` (Pro/Max abonelik) |
| 2 | **Telegram bot token** | Telegram'da **@BotFather** → `/newbot` → `123456789:AAF…` |
| 3 | **Telegram id'n** | Sihirbaz bulur: bota bir mesaj atarsın, o okur. (Elle: **@userinfobot**) |
| 4 | **Repo adresi** | GitHub/GitLab → Code → HTTPS: `https://github.com/sen/repo.git` |
| 5 | **Repo token** | GitHub: [fine-grained token](https://github.com/settings/personal-access-tokens/new) → sadece bu repo, **Contents: RW**, **Pull requests: RW** (APK'yı Actions'ta üretecekseniz ayrıca **Workflows: RW** + **Actions: RW**). GitLab: Project Access Token, role Developer, `api, read_repository, write_repository` |

Bittiğinde terminal "Ajan ayakta: Telegram'da @botun sohbetine /status yaz" der. İlk çalıştırma internet hızına
göre 15 dk – 2 saat sürer (imaj + SDK'lar, tek seferlik); sonraki açılışlar saniyeler.

> **Windows:** komutları WSL2 Ubuntu terminalinden çalıştır ve projeyi WSL diskine (`~/agent` gibi) koy, `/mnt/c/…` altına değil.
> Docker Desktop → Settings → Resources → **WSL integration** → Ubuntu açık olmalı. Ayrıntı: [docs/troubleshooting.md](docs/troubleshooting.md).

## Kullanım

Telegram'da bota düz cümle yaz:

> Profil ekranına karanlık tema desteği ekle

Ajan şu akışı izler; senin parmağın yalnızca iki butona değer:

| Faz | Ne olur | Sen |
|-----|---------|-----|
| 1 · Analiz | Repo'yu okur, mevcut kalıpları çıkarır (`.agent/ANALYSIS.md`) | — |
| 2 · Plan | 5-7 maddelik plan gönderir | **✅ Onayla** / ✏️ Değiştir / ❌ İptal |
| 3 · Geliştirme | `agent/<slug>` dalında küçük commit'ler, testler | — |
| 4 · Review | Bağımsız bir alt-ajan review yapar, bulgular düzeltilir, testler yeşil | — |
| 5 · PR | Özet gönderir | **✅ PR aç** / ✏️ Değişiklik iste / ❌ İptal |

Kapılar yalnızca prompt değil, **teknik** olarak da kapalıdır: onay yokken `Write/Edit/git commit`, PR onayı
yokken `git push` / `gh pr create` bir `PreToolUse` hook'u tarafından reddedilir. Varsayılan dala push ve
force-push her koşulda yasaktır.

Ajan çalışırken tek bir "⏳" mesajı yerinde güncellenir (hangi dosyayı okuduğu, hangi komutu çalıştırdığı).
Ajanın `.agent/outbox/` altına koyduğu dosyalar (APK, ekran görüntüsü, rapor) sana Telegram'dan gelir.
Sorular her zaman buton olarak gelir; serbest cevap için "✍️ Kendi cevabımı yazacağım". Ajan meşgulken
yazdıkların kuyruğa girer.

**Komutlar**

| Komut | |
|-------|-|
| `/new [görev]` | Yeni oturum; kapılar sıfırlanır. Aynı PR'da devam etmek için `/new` demeden yaz |
| `/status` | Faz, dal, kapı durumu, kullanım. Gösterilen `≈$` değeri gerçek fatura değil, aboneliğinle yaptığın işin API liste fiyatıyla eşdeğeri |
| `/cancel` | Çalışan işi durdur |
| `/init` | Ortamı doğrula (SDK'lar, `flutter doctor` vb.), eksik varsa kur |
| `/preview [build\|stop]` | Uygulamayı web olarak yayınla ve **telefondan açacağın link** gönder: giriş dahil her şeyi kendin denersin, token gerekmez; link 24 sa, anahtar ilk açılışta çereze yazılır |
| `/ss [rota…] [build] [hash] [desktop]` | Flutter web build'ini headless Chromium'da telefon boyutunda açıp ekran görüntülerini fotoğraf olarak gönder (emülatörsüz, KVM gerekmez); rotalar `CLAUDE.md` ```screenshot bloğundan |
| `/karakter [not]` | Repo için "sanal karakter" dosyası `CLAUDE.md` üret/güncelle (mimari kuralları, komutlar, SDK'lar); onaylı PR — bkz. [Token tasarrufu](#token-tasarrufu) |
| `/review` · `/pr` | Review'ı / PR akışını elle tetikle |
| `/diff` · `/log` · `/sdk` | Çalışma ağacı diff'i (dosya) · son commit'ler · bağlı SDK'lar |
| `/limit` | Abonelik kullanımı (canlı, Claude Code'un `/usage` ekranıyla aynı kaynak): 5 saatlik ve 7 günlük pencerede kullanılan/kalan yüzde, sıfırlanma saati. %80'i geçince ve dolunca bot kendiliğinden uyarır |
| `/model [ad]` | Modeli seç: butonla varsayılan / sonnet / opus / haiku ya da tam ad (`/model claude-sonnet-4-5`); sonraki turdan itibaren |
| `/quick [görev]` | Hızlı mod: analiz ve alt-ajan review atlanır, plan onayı kalır — typo/config/tek dosya işleri için 5-10 kat ucuz |
| `/test` · `/lint` · `/build` · `/format` · `/doctor` · `/deps` | Repo görevini **Claude çalıştırmadan** koşar (`.agent-tasks` ya da proje türüne göre varsayılan); yeşilse özet, kırmızıysa son satırlar + "🤖 Ajana düzelttir" butonu |
| `/task [ad]` | Görev listesi / `.agent-tasks`'taki özel görev |
| `/apk [small\|release\|profile\|debug] [all] [flavor X] [limit MB]` | Flutter APK build eder. Varsayılan `small`: release → profile → debug sırasıyla dener, yalnızca arm64, obfuscate + tree-shake; 50 MB altına inen ilkini Telegram'dan dosya olarak gönderir, sığmazsa en küçüğünü **download linki** ile verir ve paketi büyüten bileşenleri listeler. Ajan da görev içinde `build-apk` skill'iyle yapar ve küçültme planı önerir |
| `/apk setup` | Hedef repoya GitHub Actions workflow'u (PR) ekler; `APK_BUILDER=actions` ile APK orada üretilir, container'da JDK/Android/Gradle gerekmez — bkz. [Railway](docs/railway.md) |
| `/builds` | Son build'ler ve indirme linkleri |
| `/tunnel [check\|restart]` | Download linki tünelinin durumu (adres, dışarıdan doğrulama, son hata), test linki; `restart` ile yeniden kur |
| `/approve` | Plan kapısını buton olmadan aç |
| `/free` | Kapıları tamamen kaldır — yalnızca deneme reposunda |

## Nasıl çalışır

**Container** — `node:22-bookworm` üstüne git, gh, glab, build araçları. Ajan `agent` kullanıcısıdır (root değil;
Claude Code root'ta izin bypass'ını reddeder) ve SDK kurabilmek için passwordless sudo'su vardır. Claude Code'un
kendisi `@anthropic-ai/claude-agent-sdk` paketiyle gömülü gelir; ayrı kurulum yoktur.

**Kalıcı veri** — hepsi volume'da, container atılabilir:

```
/data/repo/          klonlanmış repo  (+ .agent/ ajan notları — git'e girmez)
/data/claude/        ~/.claude → oturum geçmişi; restart sonrası kaldığı yerden devam
/data/sdks/          üretilmiş env.sh, pub-cache/gopath/npm-global, container'a özel ek SDK'lar
/data/state.json     faz, kapı bayrakları, dal, maliyet
/sdks/<isim>/<sürüm> paylaşımlı SDK volume'ları (aşağıda)
```

**Git kimliği** — açılışta `Claude Agent <claude-agent@noreply.local>` (env ile değişir). Token 0600 bir dosyada
durur, salt-okunur bir credential helper üzerinden verilir; remote URL'e gömülmez, loglara düşmez.

**Ajan konfigürasyonu** — `agent-config/SYSTEM_PROMPT.md` (system prompt eki), `agent-config/CLAUDE.md` ve
`agent-config/skills/*` (analyze-architecture, plan-and-approve, implement, review, open-pr, bootstrap-env).
Her açılışta container'ın `~/.claude/` dizinine kopyalanır; repo'nun kendi `CLAUDE.md`/skill'leri de yüklenir
ve önceliklidir. Daha fazlası: [docs/architecture.md](docs/architecture.md).

## SDK volume'ları (isim + sürüm, paylaşımlı)

SDK'lar imaja gömülmez, container'a da her seferinde kurulmaz. `up.sh` her açılışta:

```
repo tara (scripts/sdk-detect.sh)  →  jdk 17 · android 35 · flutter 3.x.y …
  └─ her biri için docker volume  sdk-<isim>-<sürüm>  var mı?
        var  → /sdks/<isim>/<sürüm> olarak bağla            (saniyeler)
        yok  → volume oluştur + one-shot kurulum container'ı  (bir kere)
container açılışı: scripts/sdk-env.sh → /data/sdks/env.sh  (BASH_ENV; ajanın her bash komutu bunu yükler)
```

- Aynı host'taki tüm ajan container'ları (farklı repolar) aynı volume'u paylaşır.
- **Sürümler bilgisayarında projeyi build edenlerle aynı olmalı.** En sade yol: hedef repoya sürümleri yazan
  bir dosya koymak; container tahmin yapmadan doğrudan o volume'ları bağlar. İki biçim tanınır:

  `.tool-versions` (asdf/mise standardı — tavsiye edilen):
  ```
  flutter 3.24.5-stable
  java temurin-17.0.12+7
  golang 1.22.5
  nodejs 20.11.1
  ```
  `.sdks` (bu projenin kendi biçimi; Android compileSdk gibi asdf'te olmayanlar için):
  ```
  flutter 3.24.5
  jdk 17
  android 34
  ```
  Kaynak sırası: `.sdks` → `.env SDKS=flutter:3.24.5,jdk:17,android:34` (sihirbaz repoyu tarayıp bulduğu her SDK
  için sürümü önerir, sen onaylarsın; `.sdks`'i push etmeyi de teklif eder) → `.tool-versions` / `.fvmrc` →
  tahmin (`pubspec.yaml`'daki Dart sürümünden Flutter, Gradle/AGP'den JDK, `compileSdk`, `go.mod`, `.nvmrc`,
  `rust-toolchain`). Tahmin yalnızca öncekiler yoksa devreye girer; `/init` başarılı build'den sonra pin
  dosyası eklemeyi önerir. Android compileSdk her durumda `build.gradle`'dan okunur (ya da `.sdks` / `ANDROID_API`).
- `SDKS=none` provizyonu kapatır; `./up.sh sdk` hangi kaynağın kullanıldığını ve bağlı volume'ları gösterir.
- Görüntüle: `./up.sh sdk` · Telegram `/sdk`. Sil: `docker volume rm sdk-flutter-3.24.3`.
- Ajan çalışırken ek bir SDK'ya ihtiyaç duyarsa `bootstrap-env` onu container'a özel `/data/sdks/…`'e kurar; bir
  sonraki `./up.sh` bunu indirmeden paylaşımlı volume'a terfi ettirir.
- Desteklenen: `jdk android flutter dart go node rust`. Yeni SDK = `scripts/sdk-install.sh`'a bir `case` +
  `scripts/sdk-detect.sh`'a bir kural.

## Token tasarrufu

Abonelik limitini en çok tüketen dört şey ve botun karşılığı:

- **Keşif okumaları** → analiz sonuçları `.agent/ANALYSIS.md`'de cache'lenir (7 gün / 20 commit); 5+ dosya
  gerektiğinde ana ajan kendisi okumaz, ucuz modelde koşan `explorer` alt-ajanından ≤ 40 satırlık özet alır.
- **Uzun komut çıktıları** → build/test/paket yöneticisi komutları bir `PreToolUse` hook'uyla otomatik kırpılır:
  tam çıktı `/data/logs/…`, modele son `BASH_TAIL_LINES` (80) satır. `/test`, `/lint`, `/build` gibi rutinler ise
  Claude hiç çalışmadan koşar; yalnızca kırmızıysa ve sen istersen ajan devreye girer.
- **İkinci tam ajan olarak review** → `reviewer` alt-ajanı `MODEL_REVIEW` (sonnet) ile, salt-okunur.
- **Model** → `/model` ile ana model; `MODEL_EXPLORE` (haiku) / `MODEL_REVIEW` (sonnet) alt-ajanlar; Opus yalnızca
  sen istersen. `/quick` küçük işlerde analiz + review'ı atlar. Her görevin bitiş satırı token sayısını ve cache
  oranını gösterir; `/status` oturum toplamını.

### Repo tarafı: tek dosyalık "sanal karakter" (`CLAUDE.md`)

Tokenin büyük kısmı ajanın her görevde repoyu **yeniden keşfetmesine** gider. Bunu kesmenin yolu, repo köküne
ajanın karakterini anlatan **tek bir `CLAUDE.md`** koymaktır: kimlik (rol + stack), değişmez mimari kuralları,
katman haritası, "yeni ekran/modül nasıl eklenir" reçeteleri, yapma listesi, komutlar ve SDK sürümleri. Claude Code
bu dosyayı her turda otomatik yükler; ajan haritalama adımını atlar, doğrudan görevle ilgili 2-3 dosyayı açar ve
sabit kalıbı kopyalar.

- Şablon: [`templates/CLAUDE.md`](templates/CLAUDE.md) · dolu örnek (Flutter, feature-first):
  [`templates/examples/hanio-flutter.CLAUDE.md`](templates/examples/hanio-flutter.CLAUDE.md).
- Bot üretsin: Telegram'da `/karakter` → repoyu ucuz alt-ajanla tarar, taslağı telefona gönderir, onayınla
  `agent/character` dalında commit'ler ve PR açar. Var olan dosyayı da günceller.
- Dosyanın içindeki iki blok makine tarafından okunur, böylece ek dosya gerekmez:
  ```agent-tasks``` bloğu → `/test /lint /build` ve ajanın `run-task.sh`'ı (satır: `ad: komut`);
  ```sdks``` bloğu → `up.sh`/sihirbaz SDK volume'ları (satır: `isim sürüm`). Ayrı `.agent-tasks` / `.sdks` /
  `.tool-versions` varsa onlar önceliklidir.
- **Kısa tut (≤ 120 satır)**: her satır her turda token harcar. Uzun mimari dökümü `docs/`'a koy, CLAUDE.md'den
  "gerekince oku" diye işaret et.

Repo tarafında dikkat edilecek diğer şeyler (hepsi ajanın okuyacağı metni küçültür):

- Üretilmiş/derlenmiş şeyler (`build/`, `.dart_tool/`, `*.g.dart`, `node_modules/`, coverage, lock dosyaları)
  `.gitignore`'da olsun **ve** CLAUDE.md'nin "asla okuma" listesinde geçsin. Assets, fixture JSON'ları, snapshot'lar
  gibi büyük veri dosyaları için de aynısı.
- Küçük, tek-sorumluluklu dosyalar (≤ 300 satır): ajan büyük dosyayı parça parça okumak zorunda kalır ve
  düzenlerken bağlamı kaybeder. 1500 satırlık `utils.dart`'ı bölmek somut tasarruftur.
- Her modülün **tek dış yüzey dosyası** olsun (Hanio'daki `<modul>_module.dart` gibi): ajan modülü tanımak için
  bir dosya okur, hepsini değil.
- Testler dosya başına çalıştırılabilir olsun (`flutter test test/x_test.dart`, `go test ./pkg/x`); tam paket yalnız
  bitişte koşar. Test çıktısı gürültülüyse sessiz bayrakları CLAUDE.md'deki komuta yaz.
- Komut/sürüm bilgisi tek yerde: `agent-tasks` + `sdks` blokları (ya da `.tool-versions`). Ajan "test nasıl
  koşuyor?" diye README'yi ya da CI dosyasını okumasın.
- Lint/format aracı repoda tanımlı olsun (`analysis_options.yaml`, `.golangci.yml`, eslint): reviewer'ın üslup
  bulguları yerine araç yakalar, ajan "düzelt" turu atmaz.
- Görevleri Telegram'dan **küçük ve somut** ver ("partners listesine arama kutusu; mevcut filtre kalıbını kullan")
  — belirsiz görev = uzun analiz + uzun plan + değişiklik istekleri. Tek dosyalık işler için `/quick`.

## Uygulamayı telefondan açmak ve ekran görüntüsü (emülatörsüz)

Container'da Android emülatörü yok (KVM ister; Mac'te Docker içinde hiç yok). Bunun yerine uygulama **web** olarak
derlenir (`flutter build web --base-href /app/`) ve iki şekilde sana ulaşır:

**`/preview` — telefondan aç.** Bot build'i kendi HTTP sunucusunda `/app/` altında yayınlar ve download linkleriyle
aynı Cloudflare tüneli üzerinden `https://….trycloudflare.com/app/?k=<anahtar>` gönderir. Linki telefonda açarsın;
anahtar çereze yazılır, uygulama telefon boyutunda tarayıcıda çalışır, giriş dahil her şeyi kendin yaparsın — test
token'ı, emülatör, APK yükleme yok. Link 24 saat geçerli, `/preview stop` kapatır; yeni build sonrası aynı link
çalışmaya devam eder. Ajan da UI işi bitince "link ver" dediğinde bunu üretir. Not: uygulama API'ye tarayıcıdan
gittiği için backend'in CORS'u tünel origin'ine izin vermeli (kendi API'nde `Access-Control-Allow-Origin` genişse sorun yok).

**`/ss` — fotoğraf.** Aynı build bot'un statik sunucusunda açılır ve imajdaki headless Chromium 390×844 @2x
mobil viewport'ta her rota için PNG alır; Telegram'a fotoğraf/albüm olarak gelir. `/ss /home /home/m/customers`
ya da rotasız `/ss` (rotalar `CLAUDE.md` ```screenshot bloğundan). Web build yalnızca `lib/`, `web/`, `pubspec.yaml`
değiştiyse yenilenir; `build` argümanı zorlar. Ajan da UI değişikliklerinde review'dan önce değişen rotaları çeker ve
görüntüye kendisi bakar (`screenshot` skill'i).

Giriş gerektiren ekranlar için `.env`'e test kullanıcısının token'ını `APP_TEST_TOKEN` olarak koy ve CLAUDE.md
bloğuna `storage: <localStorage anahtarı>=$APP_TEST_TOKEN` yaz; script token'ı tarayıcıya sayfa açılmadan enjekte
eder (Flutter web canvas'a çizdiği için forma yazarak login olunamaz). Hash routing kullanan uygulamalarda
`hash: true`. Sınır: native görünümler (izin diyaloğu, kamera) web'de yok — onlar için `/apk`.

## APK'yı GitHub Actions'ta üretmek (ucuz sunucular için)

Container'daki APK build'i (Gradle + JDK) 4-6 GB RAM ister ve SDK volume'unu 6-8 GB'a çıkarır; Railway gibi kullanım
başına ücretlendiren yerlerde faturanın büyük kısmı budur. `APK_BUILDER=actions` ile build hedef repodaki bir GitHub
Actions workflow'unda yapılır: bot `gh workflow run` ile tetikler, koşuyu izler, artifact'i indirip Telegram'a gönderir
(aynı `/apk` komutu, aynı küçültme stratejisi; ajan da `build-apk` skill'inde aynı yolu kullanır). Container'da yalnızca
Flutter SDK kalır (`SDKS=flutter:<sürüm>`; test/analyze/web önizleme için). Kurulum: Telegram'da `/apk setup` workflow
PR'ını açar, merge edersin. PAT izinleri: **Workflows: Read and write** (workflow dosyasını push edebilmek için; GitHub bunu
Contents'ten ayrı ister) ve **Actions: Read and write** (tetikleme + artifact indirme). İsteğe bağlı webhook (`BUILD_WEBHOOK_SECRET` + repo secrets)
beklemeyi kısaltır ve `agent/**` dallarına her push'ta üretilen APK'yı kendiliğinden gönderir. Private repoda ayda 2000
Actions dakikası ücretsiz; cache'li koşu 4-8 dk. Railway kurulumu adım adım: [docs/railway.md](docs/railway.md).

## Büyük dosyalar: download linki

Telegram botları 50 MB'tan büyük dosya gönderemez; debug APK'lar kolayca 100-200 MB olur. Bot bunun için kendi
içinde küçük bir HTTP sunucusu (`:8787`, süreli ve tahmin edilemez token'lı `/d/<token>/<dosya>` linkleri) barındırır
ve varsayılan olarak **Cloudflare quick tunnel** ile dışarı açar: hesap, domain, port yönlendirme gerekmez;
container açılışında rastgele bir `https://…trycloudflare.com` adresi alınır, link telefondan mobil veride bile
çalışır. Linkler `LINK_TTL_HOURS` (24) saat geçerlidir; `/builds` yeni link üretir. Bot, tünel adresini kendisi dışarıdan
(`/_health`) doğrulamadan link vermez, 5 dakikada bir kontrol eder ve kopmuşsa cloudflared'i yeniden başlatır;
`/tunnel` durumu gösterir.

Alternatifler (`.env`): `FILE_LINKS=lan` + `PUBLIC_BASE_URL=http://<PC-LAN-IP>:8787` (aynı Wi-Fi; Windows'ta
`ipconfig` → IPv4), kendi domain'in / tünelin (`PUBLIC_BASE_URL=https://apk.senin.dev`), ya da `FILE_LINKS=off`.
Quick tunnel Cloudflare'ın test amaçlı hizmetidir, garanti vermez; sürekli kullanım için ücretsiz bir Cloudflare
hesabıyla kalıcı tünel ya da `lan` modu daha sağlıklıdır. Küçük tutmak için: `/apk release` (~20-40 MB, debug
anahtarıyla imzalı) çoğu zaman Telegram sınırına sığar.

## Kubernetes

```bash
./up.sh --k8s --build                                    # yerel cluster: docker-desktop, k3s, kind, minikube
IMAGE=ghcr.io/sen/claude-agent:1 ./up.sh --k8s --push    # uzak cluster
./up.sh logs --k8s  ·  ./up.sh sdk --k8s  ·  ./up.sh down --k8s
```

Namespace, `.env`'den Secret, `/data` için PVC, her SDK için PVC (`sdk-flutter-3-24-3`) + tek seferlik kurulum Job'ı
(PVC `claude-agent/installed` annotasyonuyla işaretlenir) ve `Recreate` stratejili tek replika Deployment.
Çok node'lu cluster'da SDK paylaşımı için `K8S_SDK_ACCESS_MODE=ReadWriteMany` destekleyen bir storage class ver.

## Ayarlar (`.env`)

Sihirbaz zorunlu beşini yazar; gerisi `.env.example`'daki varsayılanlarla gelir.

| Değişken | Açıklama |
|----------|----------|
| `CLAUDE_CODE_OAUTH_TOKEN` · `TELEGRAM_BOT_TOKEN` · `TELEGRAM_ALLOWED_USER_IDS` · `REPO_URL` · `REPO_TOKEN` | Zorunlu (sihirbaz) |
| `GIT_PROVIDER` | `github` / `gitlab`; self-hosted için gerekli, aksi halde host'tan anlaşılır |
| `GIT_USER_NAME` · `GIT_USER_EMAIL` | Ajanın commit kimliği |
| `CLAUDE_MODEL` | Model override (boş = Claude Code varsayılanı) |
| `TZ` | Saat dilimi; limit sıfırlanma saatleri bu dilimde (`Europe/Istanbul`) |
| `MAX_TURNS` | Görev başına tur limiti (400) |
| `AUTO_PR` | `true`: review geçince sormadan PR aç |
| `FREE_MODE` | `true`: onay kapıları kapalı — yalnızca deneme reposu |
| `SDKS` | SDK listesi override / `none` |
| `DATA_PATH` | Host'ta kalıcı dizin (`./data`) |
| `K8S_*` · `IMAGE` | Kubernetes ve imaj adı |

`./up.sh setup` sihirbazı yeniden çalıştırır (eski `.env` yedeklenir).

## Sorun giderme

Sık karşılaşılanlar [docs/troubleshooting.md](docs/troubleshooting.md)'de: WSL'de `docker` bulunamıyor, sudo
şifresi, "token" yerine tarayıcı kodunu yapıştırmak, Windows editöründen gelen CRLF, mobilde GitHub token sayfası,
yavaş bağlantıda sessiz indirmeler, bot cevap vermiyor. Genel kural: `./up.sh logs` son 30 satır her şeyi söyler.

## Güvenlik

- Repo token'ını **tek repo** ile sınırla. Ajan hook'la yalnızca `agent/*` dallarına push edebilir; token kapsamı da dar olsun.
- Container tek amaçlı ve izole tutulmalı: ajanın sudo'su var, `/data/repo`'ya ve SDK volume'larına yazabilir.
- `FREE_MODE` / `/free` ile kapılar kalkar; "gözü kapalı" güvendiğin küçük repolar dışında kullanma.
- Token'lar yalnızca `.env` (600), container env'i ve `~/.git-token` (600) içinde; hiçbir loga ya da Telegram mesajına yazılmaz.

## Geliştirme

```bash
npm install && npm run build            # TypeScript (src/ → dist/)
docker build -t claude-telegram-agent . # imaj
./up.sh                                 # değişikliği canlı dene
```

Kod: `src/bot.ts` (Telegram, komutlar, buton akışı) · `src/agent.ts` (Agent SDK sarmalayıcısı, hook'lar) ·
`src/gate.ts` (faz kapısı) · `scripts/sdk-*.sh` (SDK tespit/kurulum/volume) · `docker/entrypoint.sh` (git kimliği,
repo, env). Skill ve prompt'lar `agent-config/` altında; değişiklik container restart'ıyla yüklenir.

## Repo'ya commit + push (kısayol)

`commit.cmd` (Windows, çift tıkla) ya da `./commit.sh` (Mac/Linux/WSL): değişiklikleri gösterir, commit mesajı
sorar, hepsini commit'ler ve push eder. Bu proje deposunu güncellemek için; ajanın çalıştığı hedef repo ile ilgisi yok.

## Lisans

MIT — bkz. [LICENSE](LICENSE).
