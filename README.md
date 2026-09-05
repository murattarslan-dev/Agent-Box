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
| 5 | **Repo token** | GitHub: [fine-grained token](https://github.com/settings/personal-access-tokens/new) → sadece bu repo, **Contents: RW**, **Pull requests: RW**. GitLab: Project Access Token, role Developer, `api, read_repository, write_repository` |

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
| `/review` · `/pr` | Review'ı / PR akışını elle tetikle |
| `/diff` · `/log` · `/sdk` | Çalışma ağacı diff'i (dosya) · son commit'ler · bağlı SDK'lar |
| `/limit` | Abonelik kullanımı (canlı, Claude Code'un `/usage` ekranıyla aynı kaynak): 5 saatlik ve 7 günlük pencerede kullanılan/kalan yüzde, sıfırlanma saati. %80'i geçince ve dolunca bot kendiliğinden uyarır |
| `/model [ad]` | Modeli seç: butonla varsayılan / sonnet / opus / haiku ya da tam ad (`/model claude-sonnet-4-5`); sonraki turdan itibaren |
| `/apk [debug\|release] [all] [flavor X]` | Flutter APK build eder; ≤ 50 MB ise Telegram'dan dosya olarak, büyükse **download linki** olarak gönderir (varsayılan: debug, yalnızca arm64). Ajan da görev içinde `build-apk` skill'iyle yapabilir |
| `/builds` | Son build'ler ve indirme linkleri |
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
- Tespit: `.fvmrc` / `.fvm/fvm_config.json` / `.tool-versions` / `pubspec.yaml`, `go.mod` (`toolchain`), `.nvmrc` /
  `engines.node`, `android/app/build.gradle*` (`compileSdk`, `jvmTarget`), `rust-toolchain*`. Sürüm yoksa güncel
  stable çözümlenir ve sabitlenir.
- Elle: `.env` → `SDKS=flutter:3.24.3,jdk:17,android:34` (tespiti ezer) · `SDKS=none` (kapat).
- Görüntüle: `./up.sh sdk` · Telegram `/sdk`. Sil: `docker volume rm sdk-flutter-3.24.3`.
- Ajan çalışırken ek bir SDK'ya ihtiyaç duyarsa `bootstrap-env` onu container'a özel `/data/sdks/…`'e kurar; bir
  sonraki `./up.sh` bunu indirmeden paylaşımlı volume'a terfi ettirir.
- Desteklenen: `jdk android flutter dart go node rust`. Yeni SDK = `scripts/sdk-install.sh`'a bir `case` +
  `scripts/sdk-detect.sh`'a bir kural.

## Büyük dosyalar: download linki

Telegram botları 50 MB'tan büyük dosya gönderemez; debug APK'lar kolayca 100-200 MB olur. Bot bunun için kendi
içinde küçük bir HTTP sunucusu (`:8787`, süreli ve tahmin edilemez token'lı `/d/<token>/<dosya>` linkleri) barındırır
ve varsayılan olarak **Cloudflare quick tunnel** ile dışarı açar: hesap, domain, port yönlendirme gerekmez;
container açılışında rastgele bir `https://…trycloudflare.com` adresi alınır, link telefondan mobil veride bile
çalışır. Linkler `LINK_TTL_HOURS` (24) saat geçerlidir; `/builds` yeni link üretir.

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

## Lisans

MIT — bkz. [LICENSE](LICENSE).
