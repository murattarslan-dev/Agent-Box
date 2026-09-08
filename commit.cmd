@echo off
:: Çift tıkla: değişiklikleri göster, commit mesajı sor, hepsini commit'le ve push et.
setlocal EnableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"
title git commit - %CD%

where git >nul 2>&1 || (echo git bulunamadi. https://git-scm.com/download/win & pause & exit /b 1)

echo.
echo === Degisiklikler ===
git status --short
git diff --quiet && git diff --cached --quiet && (
  echo.
  echo Commit'lenecek degisiklik yok.
  set /p PUSHONLY="Yine de push edeyim mi? [E/h]: "
  if /i "!PUSHONLY!"=="h" goto :end
  goto :push
)

echo.
set "MSG="
set /p MSG="Commit mesaji (bos: 'update'): "
if "!MSG!"=="" set "MSG=update"

git add -A
git commit -m "!MSG!" || (echo Commit basarisiz. & pause & exit /b 1)

:push
echo.
echo === Push ===
git push || (
  echo.
  echo Push basarisiz. Ilk kez ise: git push -u origin main  ^| kimlik penceresi ciktiysa GitHub ile giris yap.
  pause
  exit /b 1
)

echo.
echo Tamam:
git log --oneline -3
:end
echo.
pause
