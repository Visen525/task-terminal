@echo off
rem task-terminal Windows launcher (M14-01)
rem Double-click to run. ASCII-only on purpose: cmd parses batch files in the
rem OEM codepage, so non-ASCII bytes in control flow break on Chinese systems.
setlocal
title task-terminal
cd /d "%~dp0"

set "PORT_NUM=4310"
set "APP_URL=http://127.0.0.1:%PORT_NUM%/"

where node >nul 2>nul
if errorlevel 1 (
  echo [task-terminal] Node.js not found. Install Node 24+ from https://nodejs.org/
  pause
  exit /b 1
)

rem Already running: just open the page.
rem NOTE: TcpClient.ConnectAsync's Task never completes under Windows PowerShell
rem 5.1 (stays WaitingForActivation), so use the classic BeginConnect pattern.
powershell -NoProfile -Command "$c = New-Object Net.Sockets.TcpClient; $ar = $c.BeginConnect('127.0.0.1',%PORT_NUM%,$null,$null); $ok = $ar.AsyncWaitHandle.WaitOne(400); if ($ok -and $c.Connected) { exit 0 } else { exit 1 }" >nul 2>nul
if not errorlevel 1 (
  echo [task-terminal] already running, opening %APP_URL%
  start "" "%APP_URL%"
  exit /b 0
)

if not exist "dist\index.html" (
  echo [task-terminal] first run: installing deps and building web ui...
  where pnpm >nul 2>nul
  if errorlevel 1 (
    echo [task-terminal] pnpm not found, enabling corepack...
    call corepack enable
    if errorlevel 1 (
      echo [task-terminal] corepack failed. Run: npm install -g pnpm
      pause
      exit /b 1
    )
  )
  call pnpm install
  if errorlevel 1 (
    echo [task-terminal] pnpm install failed. Check network and retry.
    pause
    exit /b 1
  )
  call pnpm build
  if errorlevel 1 (
    echo [task-terminal] build failed.
    pause
    exit /b 1
  )
)

echo [task-terminal] starting at %APP_URL%
rem Open the browser after the backend finishes listening (~2s).
start "" cmd /c "timeout /t 2 /nobreak >nul & start %APP_URL%"
node src\index.ts
if errorlevel 1 (
  echo.
  echo [task-terminal] exited with an error. Port busy? Change PORT in .env
  pause
)
endlocal
