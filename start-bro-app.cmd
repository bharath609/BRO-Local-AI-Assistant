@echo off
setlocal
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo BRO's desktop engine is not installed yet.
  echo Running: npm.cmd install
  call npm.cmd install
  if errorlevel 1 (
    echo.
    echo Could not install dependencies. Check that Node.js is installed.
    pause
    exit /b 1
  )
)

echo Starting BRO Local AI Assistant...
echo The voice popup appears at the top of your screen.
echo Press Ctrl+Alt+B to activate it.
echo.
echo BRO keeps running after this window closes. To stop it, use Task Manager
echo or sign out.

start "" "node_modules\electron\dist\electron.exe" "desktop\main.js"
