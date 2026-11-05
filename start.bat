@echo off
setlocal
cd /d "%~dp0"
if "%PORT%"=="" set PORT=8787
set "OPEN=1"
if /i "%~1"=="nobrowser" set "OPEN="

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node.js 22 or later.
  if defined OPEN pause
  exit /b 1
)

curl -s -m 2 "http://127.0.0.1:%PORT%/health" >nul 2>&1
if not errorlevel 1 (
  echo Already running on port %PORT%. Config: http://127.0.0.1:%PORT%/
  if defined OPEN start "" "http://127.0.0.1:%PORT%/"
  exit /b 0
)

echo Starting workbuddy-model-hub ...
echo Keep this window open; closing it disables every channel.
echo Config page: http://127.0.0.1:%PORT%/
if defined OPEN start "" "http://127.0.0.1:%PORT%/"
node --disable-warning=ExperimentalWarning server.js
echo Service stopped.
if defined OPEN pause
