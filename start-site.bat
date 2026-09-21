@echo off
title HSC Papers Mirror - local preview
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install it from https://nodejs.org, then double-click this file again.
  pause
  exit /b 1
)
echo Starting local preview server...
node serve.js
pause
