$ErrorActionPreference = 'Stop'
$stateDir = Join-Path $env:LOCALAPPDATA 'LinguaLoop\runtime'
$pidFile = Join-Path $stateDir 'stt.pid'
$exe = Join-Path $env:LOCALAPPDATA 'Programs\NeMoSpeech\bin\nemo-speech.exe'
if (-not (Test-Path -LiteralPath $pidFile -PathType Leaf)) { Write-Host 'Local STT is not running.'; exit 0 }
$serverPid = [int](Get-Content -LiteralPath $pidFile -Raw)
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$serverPid" -ErrorAction SilentlyContinue
if ($process -and $process.ExecutablePath -eq $exe -and $process.CommandLine -match '\bserve\b' -and $process.CommandLine -match '--host 127\.0\.0\.1') {
  Stop-Process -Id $serverPid -Force
  Wait-Process -Id $serverPid -Timeout 10 -ErrorAction SilentlyContinue
}
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
Write-Host 'Local STT is stopped.'
