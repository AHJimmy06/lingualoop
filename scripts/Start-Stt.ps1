$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $env:LOCALAPPDATA 'Programs\NeMoSpeech\bin\nemo-speech.exe'
$stateDir = Join-Path $env:LOCALAPPDATA 'LinguaLoop\runtime'
$logDir = Join-Path $env:LOCALAPPDATA 'LinguaLoop\logs'
$pidFile = Join-Path $stateDir 'stt.pid'
$stdout = Join-Path $logDir 'stt.stdout.log'
$stderr = Join-Path $logDir 'stt.stderr.log'
$model = 'nemotron-3.5'
$port = 8080
$envPath = Join-Path $repoRoot '.env'
if (Test-Path -LiteralPath $envPath -PathType Leaf) {
  foreach ($line in Get-Content -LiteralPath $envPath) {
    if ($line -match '^\s*LINGUALOOP_STT_MODEL=(?<value>[a-z0-9][a-z0-9._-]{0,63})\s*$') { $model = $Matches.value }
    if ($line -match '^\s*LINGUALOOP_STT_PORT=(?<value>[0-9]{1,5})\s*$') { $port = [int]$Matches.value }
  }
}
if ($port -lt 1024 -or $port -gt 65535) { throw 'LINGUALOOP_STT_PORT must be between 1024 and 65535.' }
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'NeMo-Speech.cpp is not installed.' }
New-Item -ItemType Directory -Force -Path $stateDir,$logDir | Out-Null
if (Test-Path -LiteralPath $pidFile) {
  $oldPid = [int](Get-Content -LiteralPath $pidFile -Raw)
  $old = Get-CimInstance Win32_Process -Filter "ProcessId=$oldPid" -ErrorAction SilentlyContinue
  if ($old -and $old.ExecutablePath -eq $exe -and $old.CommandLine -match '\bserve\b' -and $old.CommandLine -match '--host 127\.0\.0\.1') {
    try { Invoke-RestMethod -Uri "http://127.0.0.1:$port/ready" -TimeoutSec 2 | Out-Null; Write-Host 'Local STT is already ready.'; exit 0 } catch {}
    throw 'A LinguaLoop STT process is already running but is not ready; inspect the local STT logs.'
  }
  Remove-Item -LiteralPath $pidFile -Force
}
& $exe model pull $model
if ($LASTEXITCODE -ne 0) { throw 'The selected STT model is missing or failed verification. Run Install-SttModel.ps1.' }
$process = Start-Process -FilePath $exe -ArgumentList @('serve','--host','127.0.0.1','--port',"$port",'--asr-model',$model,'--device','cuda','--no-ui') -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
Set-Content -LiteralPath $pidFile -Value $process.Id -NoNewline -Encoding ascii
for ($i=0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 1
  $process.Refresh()
  if ($process.HasExited) { Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue; throw "Local STT exited during startup. Review logs in $logDir." }
  try {
    $ready = Invoke-RestMethod -Uri "http://127.0.0.1:$port/ready" -TimeoutSec 2
    if ($ready.ready -eq $true) { Write-Host "Local STT is ready at http://127.0.0.1:$port using $model (PID $($process.Id))."; exit 0 }
  } catch {}
}
throw "Local STT did not become ready within 60 seconds. Review logs in $logDir."
