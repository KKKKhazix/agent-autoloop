@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没有找到 Node.js，无法停止控制台。
  pause
  exit /b 1
)
node server\stop.mjs
if errorlevel 1 (
  pause
  exit /b 1
)
echo.
echo 按任意键关闭这个窗口。
pause >nul
