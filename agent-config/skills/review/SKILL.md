---
name: review
description: Dalın değişikliklerini bağımsız bir alt-ajanla (Task) review ettirir, bulguları önem sırasına göre düzeltir, testleri yeşile getirir ve .agent/REVIEW.md yazar. PR'dan önce ZORUNLU. Tetikleyiciler: geliştirme bitti, "review", "kontrol et", /review komutu.
---

# review

Amaç: PR'ı açacak kişi sen olduğun için, kodu yazan "sen"den ayrı bir göz. Review'ı **alt-ajan** yapar; sen düzeltirsin; döngü testler yeşil ve kritik bulgu kalmayana kadar sürer (en fazla 3 tur).

## Adımlar

1. **Diff'i hazırla**
   ```bash
   git fetch origin
   git diff origin/<varsayılan-dal>...HEAD --stat
   git diff origin/<varsayılan-dal>...HEAD > .agent/review.diff
   ```
   Diff boşsa: "Review edilecek değişiklik yok" de ve dur.

2. **Bağımsız review — `Task` alt-ajanı, `subagent_type: "reviewer"`** (ucuz modelde, salt-okunur; tanımı botta). Prompt şablonu (kısa tut; reviewer zaten PLAN.md ve review.diff'i okur):

   > Görev: <1 cümle>. `.agent/PLAN.md` ve `.agent/review.diff`'i değerlendir; özellikle <varsa riskli nokta>. Bulguları önem etiketiyle ve KARAR satırıyla ver.

3. **Bulguları işle**
   - `kritik` ve `yüksek`: düzelt, commit at (`fix(review): ...`).
   - `orta`: düzeltmesi ≤ 10 dk ise düzelt; değilse PR notlarına "Bilinen noktalar" olarak yaz.
   - `düşük`: PR notlarına.
   - Katılmadığın bulguyu gerekçesiyle REVIEW.md'ye "Reddedildi" olarak yaz (sessizce yutma).

4. **Doğrula**
   - `/app/scripts/run-task.sh test` ve `run-task.sh lint` (kırpılmış çıktı, tam log `/data/logs`); build gerekiyorsa `run-task.sh build`.
   - Düzeltme yaptıysan 2. adıma dön (en fazla 3 tur). 3 tur sonunda hâlâ kritik varsa dur ve AskUserQuestion ile kullanıcıya bildir (header: "Review").

5. **`.agent/REVIEW.md` yaz**
   ```md
   # Review — <görev>  (tur N, <tarih>)
   ## Karar: GEÇTİ | DÜZELTME GEREKLİ
   ## Düzeltilenler
   - [yüksek] dosya:satır — ne, nasıl
   ## Bilinen noktalar (PR'a not)
   - ...
   ## Reddedilen bulgular
   - ... — gerekçe
   ## Doğrulama
   - Test: `komut` → ✅ N geçti
   - Lint/build: ✅
   ```

6. Telegram'a ≤ 12 satırlık özet: karar, düzeltilen sayısı (önem dağılımı), test sonucu. Karar GEÇTİ ise **hemen `open-pr` skill'ine geç**.

## Kurallar

- Review'ı kendin yapıp "geçti" deme; `reviewer` alt-ajanı zorunlu (⚡ hızlı modda atlanır, sistem promptu söyler). Alt-ajan çalışmazsa (araç hatası) bunu söyle ve kendin yap ama REVIEW.md'ye "bağımsız review yapılamadı" yaz.
- Diff büyükse (> 800 satır) reviewer'a tamamını değil, `git diff --stat` + en riskli 3 dosyanın diff'ini ver.
- Testleri geçirmek için testi zayıflatma/silme; gerçekten yanlış bir testse gerekçesini REVIEW.md'ye yaz.
- Review sırasında kapsam genişletme yok.
