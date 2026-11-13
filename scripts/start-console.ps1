param(
  [string]$Distribution = 'Ubuntu',
  [string]$LinuxUser = 'edy',
  [ValidateRange(1024, 65535)][int]$FrontendPort = 5193,
  [switch]$NoBrowser,
  [switch]$NoClipboard
)

function Test-Hub([string]$Url, [string]$Owner) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri ($Url.TrimEnd('/') + '/v1/state') -Headers @{ Authorization = "Bearer $Owner" } -TimeoutSec 3 -ErrorAction Stop
    $state = $response.Content | ConvertFrom-Json
    return $response.StatusCode -eq 200 -and $null -ne $state.runs -and $null -ne $state.cards -and $null -ne $state.totals
  } catch { return $false }
}

function Test-Console([string]$Url) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 3 -ErrorAction Stop
    $html = [System.Text.Encoding]::UTF8.GetString($response.RawContentStream.ToArray())
    return $response.StatusCode -eq 200 -and $html -match '<title>流程运行台 · Autoloop</title>'
  } catch { return $false }
}

function Test-Port([int]$Port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try { return $client.ConnectAsync('127.0.0.1', $Port).Wait(500) -and $client.Connected }
  catch { return $false }
  finally { $client.Dispose() }
}

function Start-Console {
  $ErrorActionPreference = 'Stop'
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $repoPath = Split-Path $PSScriptRoot -Parent
  if ($repoPath -notmatch '^[A-Za-z]:\\') { throw '请从 Windows 盘符下的项目目录启动此脚本。' }
  $linuxScript = '/mnt/' + $repoPath.Substring(0, 1).ToLowerInvariant() + $repoPath.Substring(2).Replace('\', '/') + '/scripts/start-wsl.sh'
  Write-Host '正在检查 WSL 与运行环境…'
  $infoLines = & wsl.exe -d $Distribution -u $LinuxUser -- bash $linuxScript info
  if ($LASTEXITCODE -ne 0) { throw 'WSL 环境检查失败，请查看上面的提示。' }
  $info = ($infoLines | Where-Object { $_ -match '^\{' } | Select-Object -Last 1) | ConvertFrom-Json
  if (-not $info.home -or -not $info.url) { throw '没有读到中台配置。' }
  $configPath = '\\wsl.localhost\' + $Distribution + $info.home.Replace('/', '\') + '\config.json'
  $config = [System.IO.File]::ReadAllText($configPath) | ConvertFrom-Json
  if (-not $config.owner) { throw '中台配置缺少本人密钥。' }
  $backendUri = [uri]$info.url
  if ($backendUri.Host -notin @('127.0.0.1', 'localhost')) { throw '一键入口用于当前 WSL 中的本机中台，请检查 config.json 的 url。' }
  $frontendUrl = "http://127.0.0.1:$FrontendPort"
  $logDir = Join-Path $env:LOCALAPPDATA 'AgentAutoloop\logs'
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null

  foreach ($service in @('backend', 'frontend')) {
    if ($service -eq 'backend') {
      $ready = Test-Hub $info.url $config.owner
      $port = $backendUri.Port
    } else {
      $ready = Test-Console $frontendUrl
      $port = $FrontendPort
    }
    if ($ready) { Write-Host "复用已运行的 $service。"; continue }
    if (Test-Port $port) { throw "端口 $port 已被其他服务占用，或当前服务验证失败；没有停止任何已有进程。" }
    Write-Host "正在启动 $service…"
    $arguments = @('-d', $Distribution, '-u', $LinuxUser, '--', 'bash', ('"' + $linuxScript + '"'), $service, $FrontendPort)
    $process = Start-Process -FilePath 'wsl.exe' -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDir "$service.log") -RedirectStandardError (Join-Path $logDir "$service.error.log")
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    do {
      $process.Refresh()
      if ($process.HasExited) { throw "$service 已退出，请查看日志：$logDir" }
      Start-Sleep -Milliseconds 500
      $ready = if ($service -eq 'backend') { Test-Hub $info.url $config.owner } else { Test-Console $frontendUrl }
    } until ($ready -or [DateTime]::UtcNow -ge $deadline)
    if (-not $ready) { throw "$service 在限定时间内没有就绪，请查看日志：$logDir" }
  }

  if (-not (Test-Hub $frontendUrl $config.owner)) { throw "前端已打开，但代理未连到当前中台。请重启前端并核对 AGENT_AUTOLOOP_URL。日志：$logDir" }
  if (-not $NoClipboard) { Set-Clipboard -Value ([string]$config.owner) }
  Write-Host "前后端已就绪：$frontendUrl"
  if (-not $NoClipboard) { Write-Host '本人密钥已复制到剪贴板；在页面输入框按 Ctrl+V，再点击“连接中台”。' }
  Write-Host "日志：$logDir"
  if (-not $NoBrowser) { Start-Process $frontendUrl }
}

if ($MyInvocation.InvocationName -ne '.') {
  try { Start-Console }
  catch { Write-Host ("启动失败：" + $_.Exception.Message) -ForegroundColor Red; exit 1 }
}
