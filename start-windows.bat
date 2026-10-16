@echo off
rem Double-click to start Card Fair Booth on Windows.
cd /d "%~dp0"
where node >nul 2>nul || (echo Install Node from https://nodejs.org first, then double-click this again. & pause & exit /b 1)
findstr /b "BOOTH_PASSWORD=" .env >nul 2>nul || (
  echo First run: choose a password for your booth (6+ characters^).
  set /p P=Password: 
  call echo BOOTH_PASSWORD=%%P%%>> .env
)
node server.js
pause
