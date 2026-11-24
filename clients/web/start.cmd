@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没有找到 Node.js。请安装 Node.js 24 或更高版本：https://nodejs.org
  echo 安装后重新双击 start.cmd。
  pause
  exit /b 1
)
node -e "if(+process.versions.node.split('.')[0]<24)process.exit(1)"
if errorlevel 1 (
  echo [错误] 需要 Node.js 24 或更高版本，当前版本不满足要求。
  echo 请从 https://nodejs.org 安装新版后重新双击 start.cmd。
  pause
  exit /b 1
)
node server\launch.mjs
if errorlevel 1 (
  echo.
  echo 启动失败，请查看上面的错误信息。
  pause
  exit /b 1
)
