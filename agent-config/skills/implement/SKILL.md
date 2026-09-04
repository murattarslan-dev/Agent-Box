---
name: implement
description: Onaylanmış planı agent/<slug> dalında küçük commit'lerle uygular, testleri çalıştırır ve ilerlemeyi raporlar. Yalnızca plan onayından sonra kullanılır. Tetikleyiciler: "✅ Onayla" cevabı, "geliştir", "uygula", "devam et".
---

# implement

Ön koşul: `.agent/PLAN.md` var ve onaylı (sistem promptunda `planOnayı=VAR`). Değilse önce `plan-and-approve`.

## Adımlar

1. **Dalı hazırla**
   ```bash
   git fetch origin
   git switch -c agent/<slug> origin/<varsayılan-dal>   # dal varsa: git switch agent/<slug> && git rebase origin/<varsayılan-dal>
   ```
   Çalışma ağacı kirliyse (`git status --porcelain`) önce kullanıcıya AskUserQuestion ile sor: "stash'leyip devam" / "mevcut değişikliklerin üstüne devam" / "iptal".

2. **Plandaki adımları sırayla uygula.** Her adımda:
   - Örnek alınan mevcut kalıbı (ANALYSIS.md'deki) birebir takip et: adlandırma, dizin, hata yönetimi, loglama.
   - Adım bitince ilgili testi/derlemeyi çalıştır (`| tail -40`). Kırmızıysa düzelt, sonra ilerle.
   - Anlamlı bir birim tamamlanınca commit at:
     ```bash
     git add -A -- ':!.agent' && git commit -m "<type>(<scope>): <imperative summary>"
     ```
     `type` ∈ feat, fix, refactor, test, docs, chore, build. Gövdeye "neden"i yaz, "ne"yi değil.
   - `TodoWrite` ile adımların durumunu güncel tut (kullanıcı /status ile görmez, ama sen kaybolmazsın).

3. **Test ve kalite**
   - Yeni davranış için test ekle; mevcut test komutunu kullan (ANALYSIS.md).
   - Lint/format aracı varsa çalıştır (`dart format`, `gofmt`, `eslint --fix`, `ktlint` vb.) — yalnızca dokunduğun dosyalar.
   - Tüm test paketini en az bir kez tam çalıştır.

4. **Plan dışına çıkma**
   - Planda olmayan bir değişiklik gerekiyorsa ve küçükse (≤ 1 dosya, davranış değişmiyor) yap ve PLAN.md'ye "Ek:" olarak not düş.
   - Büyükse (yeni bağımlılık, migration, public API, > 3 dosya) dur, AskUserQuestion ile sor (header: "Kapsam").

5. **Bitiş**
   - `git log --oneline origin/<varsayılan-dal>..HEAD` ve `git diff --stat origin/<varsayılan-dal>` özetini Telegram'a gönder (≤ 15 satır).
   - **Hemen `review` skill'ine geç.** Kullanıcıya "review yapayım mı" diye sorma.

## Kurallar

- Sık ve küçük commit; tek dev commit yok.
- Bağımlılık eklerken lock dosyasını da commit'le.
- Üretilmiş/derlenmiş dosyaları (build/, .dart_tool/, node_modules/) asla ekleme; `.gitignore`'a bak.
- Sır (token, key) içeren hiçbir dosyayı commit etme; şüphede `git diff --cached | grep -i -E "token|secret|key"` ile kontrol et.
- 3 kez üst üste aynı hatayı çözemiyorsan durup AskUserQuestion ile yön sor (header: "Takıldım"); 30 dakikayı aşan tek bir adım da sorulur.
