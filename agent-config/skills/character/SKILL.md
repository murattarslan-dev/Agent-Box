---
name: character
description: Hedef repo için "sanal karakter" dosyası (repo kökünde CLAUDE.md) üretir ya da günceller — kimlik, değişmez mimari kuralları, katman haritası, reçeteler, komutlar (agent-tasks bloğu), SDK sürümleri (sdks bloğu) ve repoya özel token disiplini. Şablon /app/templates/CLAUDE.md. Tetikleyiciler: /karakter, "karakter dosyası", "CLAUDE.md yaz/güncelle", "mimari kuralları dosyaya yaz".
---

# character

Amaç: repoya tek bir dosya (`CLAUDE.md`) koyarak ajanın her görevde **keşif turu atmadan**, sabit mimariyle ve az token'la çalışmasını sağlamak. Bu dosya her turda modele yüklenir; o yüzden **kısa (≤ 120 satır) ve emir kipinde** olmalı — hikâye değil, "neyi nereden, hangi kalıpla".

## Adımlar

1. **Var mı?** `CLAUDE.md` repo kökünde varsa **güncelleme** modundasın: mevcut yapıyı koru, yalnızca yanlış/eksik satırları değiştir. Yoksa `/app/templates/CLAUDE.md` şablonunu temel al (`cat /app/templates/CLAUDE.md`).

2. **Kanıt topla (ucuz)** — kendin dolaşma; `Task` ile `subagent_type: "explorer"` alt-ajanına tek seferde sor:
   > Proje türü/framework; üst 2 seviye dizin ağacı ve her dizinin rolü; mimari kalıp (kanıt: dosya yolu); routing/DI/state/tema/network'ün tek kaynak dosyaları; yeni ekran/endpoint eklerken kopyalanacak en iyi örnek dosyalar (liste/form/cubit/repository vb.); build/test/lint komutları (Makefile, package.json scripts, CI dosyası, pubspec); .tool-versions/.sdks/.fvmrc/go.mod/gradle'daki sürümler; büyük/üretilmiş dizinler (okunmaması gerekenler). ≤ 60 satır.
   Ek olarak `.agent/ANALYSIS.md` varsa oku (cache). `README`/`ARCHITECTURE*`/`CONTRIBUTING*` varsa yalnız başlıklarını ve "kurallar" bölümlerini al.

3. **Taslağı yaz → `.agent/CLAUDE.proposed.md`** (kapı gerektirmez). Şablon bölümleri:
   - **Kimlik**: rol + stack + tek cümle proje + altın kural.
   - **Değişmezler**: 3-6 madde, her biri kanıtlı (dosya yolu). Repoda zaten uygulanan kuralları yaz; olmasını *istediğin* kuralları değil.
   - **Katman haritası**: ≤ 12 satır, yalnız "tek kaynak" dosyalar ve modül şablonu.
   - **Reçeteler**: en sık 3-4 iş (yeni ekran/modül/endpoint/tema) — adımlar + örnek alınacak dosya.
   - **Yapma**: repoda gördüğün gerçek hata kalıpları.
   - **Komutlar** ```` ```agent-tasks ```` bloğu: `run-task.sh --list`'in varsayılanları projeye uyuyorsa aynısını, uymuyorsa gerçek komutları yaz (bloğu boş bırakma).
   - **SDK sürümleri** ```` ```sdks ```` bloğu: repoda `.sdks`/`.tool-versions` varsa bloğu **koyma** (çift kaynak olmasın); yoksa `sdk-env --list`'te bağlı olan ve build'i geçen sürümleri yaz. Emin olmadığın sürümü `<…>` bırakma; bilmiyorsan bloğu çıkar ve kullanıcıya söyle.
   - **Ekran görüntüsü** ```` ```screenshot ```` bloğu (Flutter projelerinde): ana rotalar (`routes:`), hash routing kullanılıyorsa `hash: true` (`usePathUrlStrategy` yoksa hash'tir), giriş gerektiriyorsa `storage: <anahtar>=$APP_TEST_TOKEN` — anahtarı TokenStorage'dan bul.
   - **Token disiplini**: okunmayacak dizinler (build, generated, assets, lock), örnek kalıp dosyaları, tek-dosya test komutu, değişiklik ölçüsü.
   Doldurulmamış `<…>` kalmasın. Satır sayısını say: `wc -l .agent/CLAUDE.proposed.md` ≤ 120.

4. **Onay** — taslağı `.agent/outbox/CLAUDE.proposed.md`'ye kopyala (kullanıcı telefondan dosyayı görür), Telegram'a 5-8 satırlık özet (kaç değişmez, hangi komutlar, sdks var mı) ve `AskUserQuestion` (`header: "Onay"`, seçenekler `✅ Onayla`, `✏️ Değiştir`, `❌ İptal`). "Değiştir" gelirse notları uygula, 3'e dön.

5. **Uygula** — onaydan sonra `agent/character` dalında (`git switch -c agent/character origin/<varsayılan-dal>`; varsa üstüne) dosyayı repo köküne `CLAUDE.md` olarak yaz, `git add CLAUDE.md && git commit -m "docs: add agent character (CLAUDE.md)"`. `review` skill'i **atlanır** (kod değişikliği yok); doğrudan `open-pr` skill'i ile PR onayı iste ve PR aç. Kullanıcı "PR açma, dosyayı ver" derse commit'i atma; outbox'taki dosya yeterli.

## Kurallar

- Dosya, repoda **var olan** mimariyi anlatır; yeni mimari dayatmaz. Bir kuralı koyuyorsan repoda en az bir yerde uygulanmış olmalı.
- Tablo kullanma, uzun açıklama yazma; her madde tek satır, emir kipi. Örnek dosya yolları gerçek olmalı (`ls` ile doğrula).
- `agent-tasks` ve `sdks` blokları makine tarafından okunur: satır biçimi `ad: komut` ve `isim sürüm`; blok dilini (` ```agent-tasks `, ` ```sdks `) değiştirme.
- Bir sonraki görevde `analyze-architecture` bu dosyayı kaynak kabul edip haritalama adımını atlar; yanlış bilgi doğrudan yanlış koda döner — emin olmadığını yazma.
