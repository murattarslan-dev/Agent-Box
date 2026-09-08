---
name: analyze-architecture
description: Bir görev için repo mimarisini ve ilgili modülleri analiz eder, mevcut kalıpları çıkarır ve .agent/ANALYSIS.md yazar. Her yeni görevin İLK adımı; plan yazmadan ve koda dokunmadan önce MUTLAKA uygulanır. Tetikleyiciler: yeni görev, "analiz et", "mimariyi çıkar", "nasıl yapılmış".
---

# analyze-architecture

Amaç: koda dokunmadan önce **neyi, nerede, hangi kalıpla** değiştireceğini bilmek. Çıktı `.agent/ANALYSIS.md` ve Telegram'a 5-10 satırlık özet.

## Adımlar

0. **Önce cache'e bak (token tasarrufu)** — `.agent/ANALYSIS.md` varsa: tarihi 7 günden yeni **ve** `git log --since="<o tarih>" --oneline | wc -l` < 20 ise yeniden analiz **yapma**; dosyayı oku, göreve özel bölümü (etkilenecek dosyalar, örnek kalıp) `Grep` ile 2-3 aramada güncelle, `## Görevle ilgili alan` başlığını yeniden yaz ve doğrudan `plan-and-approve`'a geç. Aksi halde devam.

0b. **Repo'da karakter dosyası varsa (`CLAUDE.md`, "Katman haritası"/"Değişmezler" başlıklı)** — zaten context'inde yüklü; 2. adımı (yapıyı haritala) **atla**, mimari kalıbı/tek-kaynak dosyaları oradan al, "Örnek alınacak kalıp" için CLAUDE.md'deki örnek dosyaları kullan. Yalnızca 3. adımı (göreve odaklan) yap; ANALYSIS.md'nin "Proje" bölümüne "bkz. CLAUDE.md" yaz, tekrar etme. CLAUDE.md ile repo çelişiyorsa (dosya yok, kalıp değişmiş) bunu ANALYSIS.md'ye ve Telegram özetine yaz — kullanıcı `/karakter` ile güncelletebilir.

1. **Bağlamı oku (2 dk)**
   - `git status`, `git branch --show-current`, `git log --oneline -15`.
   - Kök dizindeki `README*`, `CLAUDE.md`, `ARCHITECTURE*`, `CONTRIBUTING*`, `docs/` başlıkları.
   - Proje türü ve araç zinciri: `pubspec.yaml` / `go.mod` / `package.json` / `build.gradle*` / `Cargo.toml` / `pyproject.toml` / `Makefile` / `Taskfile*` / CI dosyaları (`.github/workflows`, `.gitlab-ci.yml`).
   - Önceki oturum notları: `.agent/*.md`.

2. **Yapıyı haritala**
   - `Glob` ile üst 2-3 seviye dizin ağacı; katmanları / modülleri adlandır (ör. `features/`, `core/`, `internal/`, `cmd/`).
   - Kullanılan mimari kalıbı tespit et: clean architecture, MVVM, feature-first, hexagonal, monorepo vb. **Kanıtla** (dosya yolu göster), tahmin etme.
   - Bağımlılık akışı: kim kimi import ediyor; DI/servis kayıt noktası; routing/navigation kaydı; state management; hata yönetimi; loglama; i18n.

3. **Göreve odaklan**
   - Görevle ilgili anahtar kelimelerle `Grep`; etkilenecek dosyaları listele.
   - Aynı türden **mevcut bir örnek** bul (ör. benzer bir ekran/endpoint/komut) — yeni kod bu örneğin kalıbını kopyalayacak.
   - Test altyapısı: test dizini, çalıştırma komutu, mock/fixture yaklaşımı.
   - Riskler: migration, public API, kırılgan modüller, platform-özel kod.

4. **Ortam kontrolü**
   - Build/test komutlarını bir kez çalıştırmayı dene (`--version`, `pub get`, `go build ./...`, `npm ci` vb., çıktıyı `| tail -30` ile kısalt).
   - Araç eksikse durma; `.agent/ANALYSIS.md`'ye "Ortam: X eksik" yaz ve planda `bootstrap-env` adımı öngör.

5. **`.agent/ANALYSIS.md` yaz** (şablon aşağıda) ve Telegram'a kısa özet ver. Sonra **hemen `plan-and-approve` skill'ine geç**; kullanıcıdan ayrıca "devam edeyim mi" diye sorma.

## `.agent/ANALYSIS.md` şablonu

```md
# Analiz — <görev başlığı>  (<tarih>)

## Proje
- Tür / dil / framework:
- Mimari kalıp (kanıt):
- Build: `...`   Test: `...`   Lint: `...`

## Görevle ilgili alan
- Etkilenecek dosyalar:
- Örnek alınacak mevcut kalıp: `<yol>` — neden
- Bağlantı noktaları (DI, routing, state, config):

## Riskler / bilinmeyenler
- ...

## Ortam
- Eksik araçlar: (yok | flutter 3.x | ...)
```

## Kurallar

- Bu fazda **repo dosyasına yazma yok** (kapı zaten kapalı). Sadece `.agent/`.
- Tüm repo'yu okuma; göreve yetecek kadar derine in. **5'ten fazla dosya** okuman gerekecekse kendin okuma: `Task` aracıyla `subagent_type: "explorer"` alt-ajanına (ucuz model) sor — "X özelliği hangi katmanlarda, hangi dosyalar, örnek alınacak benzer kalıp hangisi, test nasıl koşuyor" — ve dönen ≤40 satırlık özeti kullan; ana context'e yalnızca 2-3 anahtar dosyayı kendin al. Explorer'a soruyu tek seferde ve somut ver (birden fazla küçük Task açma).
- Kanıtsız iddia yok: "X kullanılıyor" diyorsan dosya yolunu yaz.
