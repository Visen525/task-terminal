@echo off
rem 任务终端 · Windows 一键启动（M14-01）
rem 双击即用：已在跑则直接打开页面；dist 缺失时首次自动 install+build。
setlocal
chcp 65001 >nul
title 任务终端
cd /d "%~dp0"

set "PORT_NUM=4310"
set "APP_URL=http://127.0.0.1:%PORT_NUM%/"

where node >nul 2>nul
if errorlevel 1 (
  echo [任务终端] 未检测到 Node.js（需要 24+）。请先安装：https://nodejs.org/
  pause
  exit /b 1
)

rem 已在运行 → 直接打开页面，不重复起进程。
powershell -NoProfile -Command "try { (New-Object Net.Sockets.TcpClient).ConnectAsync('127.0.0.1',%PORT_NUM%).Wait(300) | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 (
  echo [任务终端] 已在运行，打开页面…
  start "" "%APP_URL%"
  exit /b 0
)

if not exist "dist\index.html" (
  echo [任务终端] 首次启动：安装依赖并构建前端（约 1-2 分钟）…
  where pnpm >nul 2>nul
  if errorlevel 1 (
    echo [任务终端] 未检测到 pnpm，先启用 corepack…
    call corepack enable
    if errorlevel 1 (
      echo [任务终端] corepack 启用失败，请手动执行：npm install -g pnpm
      pause
      exit /b 1
    )
  )
  call pnpm install
  if errorlevel 1 (
    echo [任务终端] 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
  call pnpm build
  if errorlevel 1 (
    echo [任务终端] 前端构建失败。
    pause
    exit /b 1
  )
)

echo [任务终端] 启动中：%APP_URL%
rem 延迟 2 秒再开浏览器，等后端完成监听。
start "" cmd /c "timeout /t 2 /nobreak >nul & start %APP_URL%"
node src\index.ts
if errorlevel 1 (
  echo.
  echo [任务终端] 异常退出。端口被占用时可改 .env 里的 PORT。
  pause
)
endlocal
