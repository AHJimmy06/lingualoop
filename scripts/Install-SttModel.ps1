$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $env:LOCALAPPDATA 'Programs\NeMoSpeech\bin\nemo-speech.exe'
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
  throw 'NeMo-Speech.cpp is not installed. Install it with the reviewed NVIDIA Windows installer first.'
}
$model = 'nemotron-3.5'
$envPath = Join-Path $repoRoot '.env'
if (Test-Path -LiteralPath $envPath -PathType Leaf) {
  foreach ($line in Get-Content -LiteralPath $envPath) {
    if ($line -match '^\s*LINGUALOOP_STT_MODEL=(?<value>[a-z0-9][a-z0-9._-]{0,63})\s*$') { $model = $Matches.value }
  }
}
& $exe model pull $model
if ($LASTEXITCODE -ne 0) { throw "Local STT model download/verification failed (exit $LASTEXITCODE)." }
& $exe model list --json | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'NeMo-Speech.cpp could not verify its local model index.' }
Write-Host "Verified local STT model: $model"
