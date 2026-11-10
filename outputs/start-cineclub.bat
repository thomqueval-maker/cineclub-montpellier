@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js n'est pas installe ou n'est pas dans le PATH.
  echo Installe-le depuis https://nodejs.org/ puis relance ce fichier.
  pause
  exit /b 1
)
node server.js
pause
