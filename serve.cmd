@echo off
rem ---------------------------------------------------------------------------
rem  VR OI room - one-click local server
rem  Double-click this file, or run it from cmd. Close the window to stop.
rem  ASCII only on purpose: cmd.exe uses the OEM codepage, and any non-ASCII
rem  text here would show up as garbage on a machine set to GBK/936.
rem ---------------------------------------------------------------------------
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH.
  echo         Install the LTS build from https://nodejs.org/ and try again.
  pause
  exit /b 1
)

echo Starting local server on http://127.0.0.1:8848/ ...
echo Close this window (or press Ctrl+C) to stop it.
echo.
start "" http://127.0.0.1:8848/
node tools/serve.mjs
echo.
echo Server stopped.
pause
