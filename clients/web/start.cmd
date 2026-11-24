@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1 || goto :failed
call npm ci --no-audit --no-fund
if errorlevel 1 goto :failed
call npm run build
if errorlevel 1 goto :failed
node server/main.mjs --open
if errorlevel 1 goto :failed
exit /b 0
:failed
echo Install Node.js 24+ and check the error above.
pause
exit /b 1
