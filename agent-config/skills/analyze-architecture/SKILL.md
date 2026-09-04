---
name: analyze-architecture
description: Bir görev için repo mimarisini ve ilgili modülleri analiz eder, mevcut kalıpları çıkarır ve .agent/ANALYSIS.md yazar. Her yeni görevin İLK adımı; plan yazmadan ve koda dokunmadan önce MUTLAKA uygulanır. Tetikleyiciler: yeni görev, "analiz et", "mimariyi çıkar", "nasıl yapılmış".
---

# analyze-architecture

Amaç: koda dokunmadan önce **neyi, nerede, hangi kalıpla** değiştireceğini bilmek. Çıktı `.agent/ANALYSIS.md` ve Telegram'a 5-10 satırlık özet.

## Adımlar

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
- Tüm repo'yu okuma; göreve yetecek kadar derine in. 20 dosyadan fazlasını okuyacaksan önce `Task` alt-ajanıyla "keşif" yaptır ve özet al.
- Kanıtsız iddia yok: "X kullanılıyor" diyorsan dosya yolunu yaz.
