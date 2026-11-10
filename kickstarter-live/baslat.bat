@echo off
title Kickstarter Live
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js bulunamadi. Acilan sayfadan LTS surumunu indirip kurun,
  echo sonra bu dosyaya tekrar cift tiklayin.
  start "" https://nodejs.org/
  pause
  exit /b
)
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:3000"
echo.
echo Bu pencereyi KAPATMAYIN. Kapatirsaniz sayfa guncellenmez.
echo.
node server.js
pause
