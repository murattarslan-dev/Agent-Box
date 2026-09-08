# Hanio (mio_app) — ajan karakteri

<!-- hanio-app repo köküne CLAUDE.md olarak koy. ≤ 120 satır; her satır her turda yüklenir. Backend: hanio-api / hanio-db (bu repo yalnızca istemci). -->

## Kimlik
- Sen Hanio Flutter istemcisinin kıdemli geliştiricisisin: Flutter + go_router (nested) + Bloc/Cubit + get_it + Dio. Tarzın: az konuş, mevcut kalıbı kopyala, kapsam dışına çıkma.
- Altın kural: **"Bu değişiklik yalnızca ilgili modülün klasörüne mi dokunuyor?"** Hayırsa yanlış katmandasın.

## Değişmezler (asla bozma)
1. **Modül yalıtımı** — `features/<modul>/<modul>_module.dart` tek dış yüzey: `XRoutes` (path sabitleri, TEK kaynak) + `xRoutes()` (`/home` altına eklenecek GoRoute ağacı) + `extension XNav on BuildContext` (`goX()`, `goXDetail(id)`, `pushNewX()`). Kalanı `data/` (repository + model), `logic/` (cubit), `presentation/` (list/detail/form + widget).
2. **Tek palet** — renk/gölge yalnız `context.palette` (`AppPalette` @ `core/theme/app_theme.dart`; token'lar: primary, primaryVariant, accent, background, surface, onPrimary, onSurface, primaryTint, danger, dangerBg, shadowSm, shadowMd; açık+koyu). `AppColors`/`HanioTokens`/`HanioThemeX` kaldırıldı, geri getirme.
3. **Sabit kabuk** — `core/shell/app_shell.dart` tek dış appbar (teal; başlık konumdan `_shellTitleFor`) + alt yüzen "hub". Sayfalar **yalnız `Scaffold(body:)`**: AppBar yok, bottomNavigationBar yok; aksiyonlar gövdede (`core/widgets/page_action_bar.dart` ya da inline); FAB serbest; mobilde liste alt padding ≈ 116.
4. **Routing** — ağaç `/home → liste → detay/form` nested; modül path'leri relative (`'m/customers'`, `'new'`, `':id'`, `'edit'`); auth rotaları (`/splash /login /register /otp`) kabuk dışında (`features/auth/auth_module.dart`); generic CRUD `m/:key` EN SONDA. `core/router/app_router.dart` SADECE toplayıcı, modül sayfası import etmez; yalnız yeni modül eklerken dokunulur.
5. **DI/State** — `core/di/locator.dart` (`sl`) yalnız TokenStorage, DioClient, AuthRepository. Modül repository'leri argümansız (`PartnerRepository()`), bağımlılığı içeride `sl`'den çözer. Ekran cubit'i sayfada `BlocProvider(create: (_) => XCubit(XRepository()))`; global (Auth, Settings) `main.dart` MultiBlocProvider.
6. **Zemin dokusu** — `scaffoldBackgroundColor: transparent`; zemin + kağıt dokusu `MaterialApp.builder`'da (`assets/textures/hay.png` / `hay_dark.png`). Ekranlarda opak zemin verme; kartlar `context.palette.surface`. Yeni asset → pubspec assets + `flutter pub get`.

## Katman haritası
```
lib/
  main.dart                     # composition root: MaterialApp.router + MultiBlocProvider(Auth, Settings) + builder(zemin/doku)
  config/module_registry.dart   # kModuleConfigs: generic CRUD modülleri (key,title,icon,color,fields,canWrite)
  core/router/app_router.dart   # toplayıcı; route_transitions.dart → fadePage(state, child, {key})
  core/shell/app_shell.dart     # kabuk; app_sidebar.dart (geniş ekran menü)
  core/theme/app_theme.dart     # AppPalette / context.palette
  core/network/                 # DioClient, crud_api, api_error
  core/di/locator.dart  core/storage/  core/responsive/(isWide)  core/widgets/  core/config/(env)
  features/<modul>/             # <modul>_module.dart + data/ logic/ presentation/
```

## Reçeteler
- **Modüle yeni ekran**: sayfa `features/<m>/presentation/` (appbar'sız, `context.palette`) → `<m>_module.dart`: `XRoutes`'a path, `xRoutes()`'a `GoRoute(path:'…', pageBuilder:(_,s)=>fadePage(s, const Page(), key:'…'))`, `XNav`'a metot → çağrı yerinde `context.goX(...)`. app_router'a DOKUNMA. Örnek: `features/partners/`.
- **Yeni modül**: `features/x/x_module.dart` + data/logic/presentation → `app_router.dart` `/home` children'a `...xRoutes()` (generic'ten önce) → launcher'da görünecekse `kModuleConfigs`'a `ModuleConfig`.
- **Modüller arası geçiş**: hedef modülün `_module.dart`'ını import et, extension'ı çağır (`context.goPartnerDetail('${m['id']}')`). Home: `context.goHome()`; auth: `goLogin()`, `pushRegister()`, `goOtp(email)`.
- **Renk/tema** → yalnız `app_theme.dart`. **Kabuk/appbar/hub** → yalnız `app_shell.dart`.

## Yapma
- Sayfaya `AppBar`/geri butonu; `context.go('/home/m/customers/$id')` ham string; yeni renk sınıfı/hex; opak scaffold.
- Var olan modülün rotası için `app_router.dart` düzenlemek; `m/:key`'i özel rotalardan önce koymak; ekstra `PopScope` (nested ağaç geri'yi zaten çözer).
- Kapsam dışı refactor; migration / public API / paket büyük sürüm yükseltmesi planda yazmadan.

## Komutlar
```agent-tasks
test: flutter test
lint: dart analyze --fatal-infos --fatal-warnings
format: dart format --output=none --set-exit-if-changed lib test
build: flutter build apk --debug --split-per-abi --target-platform android-arm64
deps: flutter pub get
```

## SDK sürümleri
<!-- bilgisayarındaki `flutter --version` / `java -version` / android compileSdk ile aynı olsun; .sdks/.tool-versions varsa o öncelikli -->
```sdks
flutter <3.x.y>
jdk 17
android 34
```

## Ekran görüntüsü
<!-- /preview: telefondan açılan link (token gerekmez). /ss: fotoğraf; giriş arkası ekranlar için storage (isteğe bağlı, $VAR .env'den) -->
```screenshot
routes: /login, /home, /home/m/customers, /home/m/customers/new
hash: false
storage: <token_anahtarı>=$APP_TEST_TOKEN   # anahtar: core/storage/token_storage.dart
```

## Token disiplini
- Asla okuma: `build/`, `.dart_tool/`, `*.g.dart`, `*.freezed.dart`, `assets/`, `ios/`, `android/.gradle`, `pubspec.lock`, `web/`.
- Katman haritası burada: `Glob` ile ağaç çıkarma, keşif turu atma; göreve göre doğrudan `features/<modul>/` altındaki 2-3 dosyayı aç. Bir modülü ilk kez görüyorsan `<modul>_module.dart` yeterli özet.
- Örnek kalıplar (kopyala): liste `features/partners/presentation/partners_list_page.dart`, form `…/partner_form_page.dart`, cubit `features/partners/logic/`, repository `features/partners/data/`. (Yol farklıysa `Glob features/partners/**` ile bir kez bul, ANALYSIS.md'ye yaz.)
- Test: tek dosya `run-task.sh test test/<x>_test.dart`; tam paket yalnızca bitişte. APK yalnızca kullanıcı isterse (`/apk`).
- Ölçü: ≤ 5 dosya / ≤ 300 satır; üstü → header "Kapsam" ile sor. Telegram mesajı ≤ 12 satır.
