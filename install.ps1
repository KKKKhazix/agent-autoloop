# Installs Agent Autoloop on Windows: a clone in %USERPROFILE%\.agent-autoloop\app, a shim named agent-autoloop on a
# folder that's on PATH, and a logon task that keeps it running. The Windows counterpart of install.sh.
# Needs Node 22.18 or newer and git. Nothing to build.
param(
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest
)

$ErrorActionPreference = 'Stop'

$Root = if ($env:AGENT_AUTOLOOP_HOME) { $env:AGENT_AUTOLOOP_HOME } else { Join-Path $env:USERPROFILE '.agent-autoloop' }
$App = Join-Path $Root 'app'
$Program = Join-Path $App 'bin\agent-autoloop.ts'
$Repo = if ($env:AGENT_AUTOLOOP_REPO) { $env:AGENT_AUTOLOOP_REPO } else { 'https://github.com/KKKKhazix/agent-autoloop.git' }

function Stop-Install([string]$message) {
  Write-Host $message -ForegroundColor Red
  exit 1
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Stop-Install '需要 Node.js 22.18 或更新，这台电脑上没找到。装好后再运行一遍这个脚本。'
}
$version = (& node -p 'process.versions.node').Trim()
$parts = $version.Split('.') | ForEach-Object { [int]$_ }
# The project declares Node 24 (package.json engines, CI, doctor). On Windows 22.18 has been enough in practice: TypeScript
# runs from source without a flag from 22.18, and node:sqlite is there from 22.5. So this installs on 22.18 but says so
# plainly rather than letting doctor surprise the user afterwards. Whether Windows should be allowed to run older than the
# declared contract is the maintainer's call, not something this script should decide quietly.
if ($parts[0] -lt 22 -or ($parts[0] -eq 22 -and $parts[1] -lt 18)) {
  Stop-Install "需要 Node.js 22.18 或更新，现在是 $version。"
}
if ($parts[0] -lt 24) {
  Write-Host "提示：项目声明需要 Node.js 24，你这台是 $version —— 装完 doctor 里 Node 那一项会显示不通过。Windows 上实测 22.18 起能跑通，先照常装。" -ForegroundColor Yellow
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Stop-Install '需要 git。'
}

if (-not (Test-Path $Root)) { New-Item -ItemType Directory -Force -Path $Root | Out-Null }

if (Test-Path (Join-Path $App '.git')) {
  & git -C $App pull --ff-only --quiet
  if ($LASTEXITCODE -ne 0) { Stop-Install '更新失败。' }
} else {
  if (Test-Path $App) { Stop-Install "$App 已经存在但不是这个项目的副本：先挪走它。" }
  & git clone --quiet --depth 1 -- $Repo $App
  if ($LASTEXITCODE -ne 0) { Stop-Install '下载失败。' }
}

# Only a folder that's on PATH makes `agent-autoloop` work. The shim's own text holds a path that may be Chinese, so it
# is written in the console's own code page: cmd.exe reads a .cmd in that code page, not UTF-8.
$shimDir = Join-Path $env:USERPROFILE '.local\bin'
if (-not (Test-Path $shimDir)) { New-Item -ItemType Directory -Force -Path $shimDir | Out-Null }
$shim = Join-Path $shimDir 'agent-autoloop.cmd'
$body = "@echo off`r`nnode --disable-warning=ExperimentalWarning `"$Program`" %*`r`n"
[System.IO.File]::WriteAllText($shim, $body, [System.Text.Encoding]::Default)

$userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
$known = @($userPath -split ';' | Where-Object { $_.TrimEnd('\') -ieq $shimDir.TrimEnd('\') })
if (-not $known.Count) {
  $joined = if ([string]::IsNullOrWhiteSpace($userPath)) { $shimDir } else { "$userPath;$shimDir" }
  [Environment]::SetEnvironmentVariable('PATH', $joined, 'User')
  $env:PATH = "$env:PATH;$shimDir"
  Write-Host "已把 $shimDir 加进你的 PATH。新开的终端里才看得到，这个窗口里已经生效。"
}

$env:AGENT_AUTOLOOP_HOME = $Root

if (Test-Path (Join-Path $Root 'config.json')) {
  Write-Host '更新好了。'
  if ($Rest -notcontains '--no-service') {
    & node --disable-warning=ExperimentalWarning $Program service install
  }
} else {
  & node --disable-warning=ExperimentalWarning $Program init @Rest
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host ''
Write-Host "程序在 $App"
Write-Host '要跑一遍完整流程，开一个新终端运行：agent-autoloop try'
