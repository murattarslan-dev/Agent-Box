---
name: open-pr
description: Review geçtikten sonra AskUserQuestion (header "PR") ile Telegram butonuyla PR onayı alır, dalı push'lar ve GitHub'da gh pr create / GitLab'da glab mr create ile PR/MR açar, linki bildirir. PR onayı olmadan push teknik olarak reddedilir. Tetikleyiciler: review GEÇTİ, "PR aç", /pr komutu.
---

# open-pr

Ön koşul: `.agent/REVIEW.md` var ve `Karar: GEÇTİ`. Değilse önce `review`.

## Adımlar

1. **Son kontrol**
   ```bash
   git status --porcelain          # temiz olmalı (.agent hariç)
   git fetch origin && git log --oneline origin/<varsayılan-dal>..HEAD
   git rebase origin/<varsayılan-dal>   # çakışma varsa çöz, testleri tekrar koş
   ```

2. **PR metnini hazırla** — `.agent/PR.md`:
   ```md
   <type>(<scope>): <başlık, ≤ 70 karakter, İngilizce>

   ## Summary
   - <ne değişti, 2-5 madde>

   ## Why
   <1-3 cümle; görev/ihtiyaç>

   ## How to test
   1. `<komut>`
   2. ...

   ## Notes
   - <review'dan bilinen noktalar / kapsam dışı bırakılanlar>

   ---
   Opened by Claude Agent via Telegram. Plan: .agent/PLAN.md (not committed).
   ```
   Repo'da `.github/PULL_REQUEST_TEMPLATE*` ya da `.gitlab/merge_request_templates/` varsa o şablonu kullan.

3. **PR onayı iste — AskUserQuestion** (zorunlu biçim). Sorudan önce Telegram'a: commit sayısı, dosya sayısı, test sonucu, PR başlığı (≤ 8 satır).
   ```json
   {
     "questions": [{
       "header": "PR",
       "question": "Review geçti. agent/<slug> dalını push edip PR açayım mı?",
       "multiSelect": false,
       "options": [
         {"label": "✅ PR aç", "description": "Push + PR/MR oluştur"},
         {"label": "✏️ Değişiklik iste", "description": "Önce bir şey düzeltmemi iste"},
         {"label": "❌ İptal", "description": "PR açma, dal yerelde kalsın"}
       ]
     }]
   }
   ```
   Sistem promptunda `AUTO_PR` etkinse (kapı durumunda `prOnayı=VAR` görünüyorsa) bu adımı atla.

4. **Push + PR** (`✅ PR aç` ise)
   - GitHub:
     ```bash
     git push -u origin agent/<slug>
     gh pr create --base <varsayılan-dal> --head agent/<slug> \
       --title "$(head -1 .agent/PR.md)" --body-file <(tail -n +3 .agent/PR.md)
     ```
   - GitLab:
     ```bash
     git push -u origin agent/<slug>
     glab mr create --target-branch <varsayılan-dal> --source-branch agent/<slug> \
       --title "$(head -1 .agent/PR.md)" --description "$(tail -n +3 .agent/PR.md)" --remove-source-branch --yes
     ```
   - Draft istenmişse `--draft` ekle. Etiket/reviewer kuralı repo dokümanında varsa uygula.
   - Push reddedilirse (kapı) → PR onayı alınmamış demektir; 3. adıma dön.

5. **Bildir**: PR linki + tek satır özet. Ardından "Sonraki görev için `/new` yaz" de. Çalışma dalında kal (kullanıcı PR'a yorum yapıp "şunu düzelt" derse aynı dalda devam edilecek).

## PR'a yorum gelirse (aynı görevde devam)

Kullanıcı "PR'daki yorumları düzelt" derse: `gh pr view --comments` / `glab mr view --comments` ile yorumları oku, küçükse doğrudan düzelt-commit-push (plan onayı hâlâ geçerli; PR onayı yeniden sorulur), büyükse `plan-and-approve` ile kısa plan + onay.
