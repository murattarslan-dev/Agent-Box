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

2. **Bağımsız review — `Task` alt-ajanı** (subagent_type: general-purpose). Prompt şablonu:

   > Sen kıdemli bir reviewer'sın. `.agent/PLAN.md` hedefi ve `.agent/review.diff` diff'ini oku; gerekirse repo'daki ilgili dosyalara bak. Kodu YAZMA, sadece değerlendir. Şu başlıklarda bulgu ver, her bulguya `[kritik|yüksek|orta|düşük]` etiketi ve `dosya:satır` ekle:
   > 1. Doğruluk: mantık hataları, edge case, null/empty, eşzamanlılık, hata yönetimi
   > 2. Plan uyumu: plandaki her adım yapıldı mı, kapsam dışına çıkıldı mı
   > 3. Mimari uyum: repo'nun mevcut kalıplarına aykırılık (ANALYSIS.md'deki örnekle kıyasla)
   > 4. Güvenlik: injection, sır sızıntısı, yetki, girdi doğrulama
   > 5. Test: yeni davranış test edildi mi, testler anlamlı mı
   > 6. Okunabilirlik/bakım: adlandırma, tekrar, gereksiz karmaşıklık
   > Sonunda `KARAR: GEÇTİ` ya da `KARAR: DÜZELTME GEREKLİ` yaz. Kritik/yüksek bulgu varsa karar GEÇTİ olamaz. Bulgu yoksa uydurma.

3. **Bulguları işle**
   - `kritik` ve `yüksek`: düzelt, commit at (`fix(review): ...`).
   - `orta`: düzeltmesi ≤ 10 dk ise düzelt; değilse PR notlarına "Bilinen noktalar" olarak yaz.
   - `düşük`: PR notlarına.
   - Katılmadığın bulguyu gerekçesiyle REVIEW.md'ye "Reddedildi" olarak yaz (sessizce yutma).

4. **Doğrula**
   - Tüm testler + lint + build (varsa). Çıktıyı `| tail -40` ile kısalt.
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

- Review'ı kendin yapıp "geçti" deme; alt-ajan zorunlu. Alt-ajan çalışmazsa (araç hatası) bunu söyle ve kendin yap ama REVIEW.md'ye "bağımsız review yapılamadı" yaz.
- Testleri geçirmek için testi zayıflatma/silme; gerçekten yanlış bir testse gerekçesini REVIEW.md'ye yaz.
- Review sırasında kapsam genişletme yok.
