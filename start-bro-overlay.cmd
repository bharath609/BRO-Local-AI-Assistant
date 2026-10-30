@echo off
setlocal
cd /d "%~dp0"
if not exist "vendor\whisper\Release\whisper-server.exe" (
  echo BRO's local voice engine is not installed yet.
  echo Downloading it once now...
  call npm.cmd run setup:voice
)
call npm.cmd run desktop
