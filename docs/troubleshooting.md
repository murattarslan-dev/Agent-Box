# Sorun giderme

Her başlıkta önce belirti, sonra çözüm. Genel araç: `./up.sh logs` (son 200 satır, canlı), `./up.sh status`.

## Kurulum

**`The command 'docker' could not be found in this WSL 2 distro`**
Docker Desktop ya çalışmıyor ya da bu WSL dağıtımına bağlı değil.
1. Windows'ta Docker Desktop'ı başlat; görev çubuğunda balina "running" olana kadar bekle.
2. PowerShell'de `wsl -l -v`: kullandığın dağıtım **VERSION 2** olmalı (`wsl --set-version Ubuntu 2`).
3. Docker Desktop → Settings → Resources → **WSL integration** → *default distro* açık **ve** listedeki dağıtımının anahtarı açık → Apply & restart.
4. PowerShell'de `wsl --shutdown`, Ubuntu'yu yeniden aç, `docker ps`.

**`chmod: cannot access 'up.sh'`** — tar'ı açınca bir seviye fazla klasör oluşmuş. `ls` ile bak; `mv claude-telegram-agent/* claude-telegram-agent/.[!.]* . && rmdir claude-telegram-agent`.

**WSL sudo şifresini unuttum** — PowerShell'de `wsl -u root` (gerekirse `wsl -d Ubuntu -u root`), sonra `passwd <kullanıcı>`, `exit`.

**`.env: line N: Agent: command not found`** — eski `up.sh` `.env`'i `source` ediyordu; güncel sürüm satır satır okur. `git pull` ya da değeri tırnakla: `GIT_USER_NAME="Claude Agent"`.

**Windows'ta düzenlenen `.env` çalışmıyor** — CRLF satır sonları token'ların sonuna `\r` yapıştırır. `up.sh` bunu otomatik temizler; yine de `.env`'i WSL içinde `nano` ile ya da VS Code'da (sağ altta **LF**) düzenle.

**Proje `/mnt/c/...` altında** — çalışır ama yavaştır ve dosya izinleri (`chmod`, uid 1000) sorun çıkarır. `~/agent` gibi WSL diskine taşı.

## Token'lar

**Claude token `sk-ant-oat01-` ile başlamıyor** — `claude setup-token` akışında tarayıcının gösterdiği *yetkilendirme kodunu* yapıştırmışsın. O kod terminale girilir; terminalin ardından bastığı `sk-ant-oat01-…` satırı token'dır. Sihirbaz bunu yakalar; elle yazdıysan `grep -c 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-' .env` → `1` olmalı.

**Bot açılışta "🔴 Claude token sorunu" diyor** — token süresi dolmuş ya da reddedildi. Yeniden `claude setup-token`, `.env`'i güncelle, `./up.sh restart`.

**GitHub'da Developer settings görünmüyor** — telefondan / GitHub uygulamasından bakıyorsun. Tarayıcıda doğrudan: `https://github.com/settings/personal-access-tokens/new`. Gerekirse "masaüstü sitesi iste".

**Sihirbaz: "Token repoyu görüyor ama push yetkisi yok"** — fine-grained token'da *Contents* yalnızca Read seçilmiş; *Read and write* yap. **"Token bu repoya erişemiyor"** — *Only select repositories* listesinde repo seçili değil ya da repo bir organizasyonda ve org fine-grained token'lara izin vermiyor (classic token, `repo` scope kullan).

**`gh auth status başarısız` uyarısı (loglarda)** — token biçimi doğru ama kapsamı eksik ya da repo tokenda seçili değil. Klon çalışıyorsa PR açma aşamasında patlar; token'ı düzelt, `./up.sh restart`.

## SDK kurulumu

**`curl: (28) Operation timed out … bytes received`** — eski sürümde indirmelerde 20 sn sınırı vardı. Güncel `scripts/sdk-lib.sh`'ta `_download` süresizdir, koptuğu yerden devam eder (8 deneme). `git pull` sonra `./up.sh`.

**Log uzun süre hiçbir şey basmıyor** — indirme sürüyor ama terminal yok diye ilerleme çubuğu gizli. İkinci terminalde `docker stats --no-stream` (NET I/O artıyor mu) ya da `docker ps` + `docker exec <id> ls -la /tmp/tmp.*/`. Güncel sürüm kurulum container'ına tty verir, çubuk görünür.

**Yarım kalan SDK** — volume var ama `.installed` yok; bir sonraki `./up.sh` kurulumu baştan tekrarlar. İstersen sil: `docker volume rm sdk-<isim>-<sürüm>`.

**Tespit yanlış sürüm buldu** — `.env`'e `SDKS=flutter:3.24.3,jdk:17,android:34` yaz; tespit tamamen atlanır. Repo'da `.fvmrc` ya da `.tool-versions` varsa tespit onları önceler.

**`Android SDK için JDK gerekli`** — `SDKS` listesinde `android` var ama `jdk` yok. `jdk:17` ekle (sıra önemli değil, script jdk'yı önce kurar).

**Disk doldu** — Flutter + Android ~4 GB, imaj ~3 GB. Docker Desktop → Settings → Resources → Disk; `docker system df` ile bak, `docker builder prune` ile build cache'i temizle.

## Bot

**Bot Telegram'da hiç yazmıyor** — Telegram'da botlar ilk mesajı atamaz; sen sohbeti açıp **Başlat**'a basmalısın (ya da `/status` yaz). Sonra açılış mesajları gelir.

**"⛔ Yetkisiz. Telegram kullanıcı id'n: 123…"** — bu sayıyı `.env`'de `TELEGRAM_ALLOWED_USER_IDS=`'e yaz, `./up.sh restart`. Birden fazla kişi: virgülle.

**`up.sh` "Bot henüz 'dinliyor' demedi" diyor** — loglara bak: `[entrypoint] HATA` satırı eksik env / yanlış URL; `git clone` hatası token; `[bot] ölümcül` Telegram token. Düzeltip `./up.sh`.

**Ajan "KAPI KAPALI" hatası alıp duruyor** — normal: plan onayı ya da PR onayı olmadan yazma/push reddedilir. Ajan bunu görüp onay ister. Akışı elle açmak istersen `/approve` (plan) ya da PR sorusuna ✅.

**Ajan çok konuşuyor / çok soruyor** — `agent-config/SYSTEM_PROMPT.md` ve skill'lerde iletişim kuralları var; düzenle, `./up.sh restart` (skill'ler her açılışta yeniden kopyalanır).

**Uzun görev ortasında mesaj attım, cevap yok** — kuyruğa girdi; ajanın turu bitince işlenir. Bekleyen bir soru varsa metnin ona cevap sayılır. Durdurmak: `/cancel`.

**Container restart oldu, ajan unuttu mu?** — Hayır; oturum id'si `/data/state.json`'da, geçmiş `/data/claude/`'da. Aynı görevde kaldığı yerden devam eder (`/status` gösterir). Sıfırlamak için `/new`.

## Kubernetes

**Job `install-sdk-…` timeout** — büyük indirme; `K8S_SDK_INSTALL_TIMEOUT=90m` ile tekrar `./up.sh --k8s`.
**Pod `Pending`** — PVC bağlanamıyor: storage class yok ya da `ReadWriteMany` desteklenmiyor. `K8S_STORAGE_CLASS`, `K8S_SDK_ACCESS_MODE` ayarla.
**`ImagePullBackOff`** — yerel imaj cluster'da yok. `--build` (kind/minikube'e yükler) ya da `--push` + `IMAGE=registry/…`.

## Hâlâ takılıysan

`./up.sh logs 2>&1 | tail -50` çıktısı ile birlikte issue aç; token'lar loglara yazılmaz ama yine de kontrol et.
