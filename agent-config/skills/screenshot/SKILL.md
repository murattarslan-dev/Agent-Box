---
name: screenshot
description: Flutter uygulamasının ekran görüntülerini emülatörsüz alır — web build'i headless Chromium'da telefon boyutunda açar, rota rota PNG üretir ve Telegram'a fotoğraf olarak gönderir. UI değişikliği yaptığında (review/PR öncesi), kullanıcı "ekran görüntüsü", "nasıl görünüyor", "ss at" dediğinde ya da /ss komutunda kullanılır. Repo'ya yazmaz, kapı gerektirmez.
---

# screenshot

Amaç: kullanıcı telefondan bakıyor; "nasıl görünüyor?" sorusunun cevabı metin değil **fotoğraf**. Container'da emülatör yok (KVM gerekmez): uygulama `flutter build web` ile derlenir, headless Chromium'da 390×844 @2x mobil viewport'ta açılır, her rota için PNG alınır.

## Tek komut

```bash
/app/scripts/screenshot.sh --outbox /home /home/m/customers      # rotalar; --outbox → Telegram'a fotoğraf
/app/scripts/screenshot.sh --outbox                              # rotalar CLAUDE.md ```screenshot bloğundan
/app/scripts/screenshot.sh --outbox --hash /home                 # uygulama hash routing kullanıyorsa (#/home)
/app/scripts/screenshot.sh --outbox --build /home                # web build'i zorla (normalde lib/web/pubspec değişmediyse atlanır)
/app/scripts/screenshot.sh --outbox --desktop --width 1280 --height 800 /home   # geniş ekran (isWide) düzeni
```

Çıktı: `SHOT: <png> <rota>` satırları, `SHOTERR: <rota> <mesaj>`, sonda `SHOTS: <dizin> <adet>`; PNG'ler `/data/builds/shots-<ts>-<sha>/`. `--outbox` ile bot fotoğraf olarak gönderir; ayrıca "gönderiyorum" deme.

## Kullanıcı kendisi bakmak isterse: önizleme linki (token gerekmez)

Kullanıcı "link ver", "ben bakayım", "telefondan açayım" derse ya da ekranlar giriş gerektiriyorsa ve test token'ı yoksa **ekran görüntüsü yerine link ver**:
```bash
/app/scripts/web-build.sh && echo "partners arama kutusu" > .agent/preview.request
```
Bot `preview.request`'i görünce web build'ini kendi sunucusunda `/app/` altında yayınlar ve kullanıcıya tek kullanımlık anahtarlı bir link gönderir (`https://….trycloudflare.com/app/?k=…`); kullanıcı telefonda tarayıcıdan açar, giriş yapar, gezer. Sen linki üretmezsin, "link geliyor" demen yeterli. Kullanıcı `/preview` ile de aynı şeyi sensiz yapar.

## Giriş gerektiren ekranlar (ekran görüntüsü için)

Flutter web canvas'a çizer; forma yazı yazarak login olunamaz. Yol: token'ı **localStorage'a enjekte** etmek. `CLAUDE.md` ```screenshot bloğunda `storage: <anahtar>=$APP_TEST_TOKEN` tanımlıysa script `.env`'deki değeri kullanır. Anahtar adı uygulamanın TokenStorage/shared_preferences anahtarıdır (`Grep -n "setString\|localStorage" lib/core/storage`). Token yoksa: API'den test kullanıcısıyla al (`curl -s -X POST $API/auth/login -d …`) ve `--storage auth_token=<değer>` ver; token'ı Telegram'a yazma. Bunların hiçbiri yoksa yalnızca auth-dışı rotaları (`/login`, `/splash`) çek ve kullanıcıya `APP_TEST_TOKEN` eklemesini öner.

## Ne zaman

- `implement` bitip `review`'a geçmeden önce UI'ye dokunan görevlerde **değişen ekranların** görüntüsünü al (yalnızca ilgili 1-3 rota; tüm uygulamayı çekme).
- Review özetine ve PR açıklamasına ekran görüntüsü aldığını yaz (PR'a dosya yüklenmez; kullanıcı Telegram'da görür).
- Kullanıcı `/ss` dediğinde bot bunu **sensiz** yapar; senin işin ajan akışında çağırmak ve sonucu yorumlamak.

## Sınırlar (bil, sorma)

- Platform-özel görünümler (native dialog, kamera, izinler, push) web'de yok; bunlar için kullanıcı `/apk` ile telefonda dener.
- `web/` dizini yoksa script durur; `flutter create --platforms=web .` repo değişikliğidir → `plan-and-approve`.
- Web build 1-3 dk; ilk seferde Chromium/CanvasKit fontları ağdan gelir. Build hatası `dart:io` gibi web'de olmayan import'tan geliyorsa bu bir UI görüntüleme sorunu değil, projenin web hedefi olmadığıdır; kullanıcıya söyle, düzeltmeyi kapsam dışı tut.
- Render farkı: web'de CanvasKit; Android'le piksel piksel aynı değil ama layout/renk/tipografi için yeterli.
