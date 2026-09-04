---
name: plan-and-approve
description: Analizden somut bir uygulama planı çıkarır, .agent/PLAN.md yazar ve AskUserQuestion (header "Onay") ile kullanıcıdan Telegram butonuyla onay alır. Koda dokunmadan önce ZORUNLU; onay gelmeden Write/Edit/commit teknik olarak reddedilir. Tetikleyiciler: analiz bitti, "plan", "onay", "KAPI KAPALI" reddi.
---

# plan-and-approve

Amaç: kullanıcı telefonda 30 saniyede okuyup **tek tuşla** onaylayabileceği bir plan. Onay gelmeden kod yazılmaz.

## Adımlar

1. `.agent/ANALYSIS.md`'yi oku (yoksa önce `analyze-architecture`).

2. **Planı yaz** — `.agent/PLAN.md`, şablon:

```md
# Plan — <görev başlığı>

## Hedef
<1-2 cümle: kullanıcı ne istedi, "bitti" ne demek>

## Yaklaşım
<2-4 cümle: hangi kalıbı takip edeceğim, neden>

## Adımlar
1. `<dosya>` — ne değişecek (yeni/düzenle)
2. ...
N. Test: `<komut>` — eklenecek/güncellenecek testler

## Kapsam dışı
- ...

## Riskler ve varsayımlar
- Varsayım: ...
- Risk: ... → önlem: ...

## Tahmin
- Dosya: ~N  · Süre: ~N dk  · Migration/breaking: yok|var(<açıkla>)
```

3. **Dal adı belirle**: `agent/<kısa-slug>` (küçük harf, tire, ≤ 40 karakter). Henüz oluşturma; `implement` fazında oluşturulacak.

4. **Telegram'a plan özetini gönder**: başlık, 3-7 adım maddesi, riskler (varsa) — toplam ≤ 1500 karakter. Tam plan `.agent/PLAN.md`'de; kullanıcı isterse `/diff`... değil, "planı tam gönder" diyebilir.

5. **Onay iste — AskUserQuestion** (zorunlu biçim):

```json
{
  "questions": [{
    "header": "Onay",
    "question": "Plan uygun mu? Onaylarsan agent/<slug> dalında geliştirmeye başlayacağım.",
    "multiSelect": false,
    "options": [
      {"label": "✅ Onayla", "description": "Plandaki adımlarla geliştirmeye başla"},
      {"label": "✏️ Değiştir", "description": "Planı düzeltmemi iste (sonraki mesajda ne değişsin yaz)"},
      {"label": "❌ İptal", "description": "Bu görevi bırak"}
    ]
  }]
}
```

   Plan gerçekten belirsiz bir tercih içeriyorsa (ör. iki mimari seçenek), onay sorusundan **önce** aynı çağrıda en fazla 2 ek soru ekleyebilirsin; ama onay sorusunun header'ı her zaman tam olarak `Onay` olmalı.

6. **Cevaba göre**
   - `✅ Onayla` → `.agent/PLAN.md` başına `Onay: <tarih>` ekle, kısa "başlıyorum" mesajı, `implement` skill'ine geç.
   - `✏️ Değiştir` → kullanıcının serbest metnini bekle (o mesaj sana gelir), planı güncelle, **tekrar onay iste**.
   - `❌ İptal` → `.agent/PLAN.md`'yi `İptal` olarak işaretle, kısa kapanış mesajı, dur.
   - Kullanıcı butona basmayıp metin yazdıysa: metin "onay/evet/tamam" anlamındaysa onay say; değilse değişiklik isteği say.

## Kurallar

- Onay sorusunu **serbest metinle değil, AskUserQuestion ile** sor; aksi halde kapı açılmaz ve yazma denemelerin reddedilir.
- Küçük görevlerde (tek dosya, typo, config) plan 3 satır olabilir ama onay yine zorunlu.
- Kullanıcı görevi zaten çok net ve küçük yazdıysa ek soru sorma; varsayımlarını planda yaz.
