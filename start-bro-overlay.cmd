@echo off
setlocal
cd /d "%~dp0"

if not exist "vendor\whisper\Release\whisper-server.exe" (
  echo BRO's local voice engine is not installed yet.
  echo Downloading it once now...
  call npm.cmd run setup:voice
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo Installing BRO's desktop engine once...
  call npm.cmd install
)

start "" "node_modules\electron\dist\electron.exe" "desktop\main.js"
