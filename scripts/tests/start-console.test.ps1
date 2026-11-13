# Failure cases: a different application occupying a port is reused, or an unrelated backend is accepted as this console.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../start-console.ps1')
function Invoke-WebRequest {
  param($Uri, $Headers, $TimeoutSec, [switch]$UseBasicParsing, $ErrorAction)
  if ($script:Reply -eq 'error') { throw 'unreachable' }
  $stream = New-Object System.IO.MemoryStream -ArgumentList (, [System.Text.Encoding]::UTF8.GetBytes($script:Reply))
  return [pscustomobject]@{ StatusCode = 200; Content = $script:Reply; RawContentStream = $stream }
}
$script:Reply = '{"runs":[],"cards":[],"totals":{}}'
if (-not (Test-Hub 'http://localhost' 'fake-owner')) { throw 'A conforming authenticated hub was rejected.' }
$script:Reply = '<html>Other app</html>'
if (Test-Hub 'http://localhost' 'fake-owner') { throw 'An unrelated server was accepted as the hub.' }
$script:Reply = '<title>AI 运维工作台</title>'
if (Test-Console 'http://localhost') { throw 'The AI-OPS application was accepted as Autoloop.' }
$script:Reply = '<title>流程运行台 · Autoloop</title>'
if (-not (Test-Console 'http://localhost')) { throw 'The Autoloop console was rejected.' }
$script:Reply = 'error'
if (Test-Hub 'http://localhost' 'fake-owner') { throw 'An unreachable hub was accepted.' }
Write-Host '启动器检查通过：中台身份、错误应用占用端口、不可达服务。'