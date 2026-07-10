param(
  [string]$SourceDir = 'D:\tecx\text\videos\sakuga-full\sources',
  [string]$Bucket = 'oss://catimation-sakuga-videos/sources',
  [string]$Ossutil = 'D:\tecx\text\videos\sakuga-full\tools\ossutil-2.3.0-windows-amd64\ossutil.exe',
  [string]$Config = "$env:USERPROFILE\.ossutilconfig",
  [int]$MaxAttempts = 200
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Continue'
$workDir = Split-Path -Parent $SourceDir
Set-Location $workDir
$log = Join-Path $workDir 'oss_sync.log'
$attempt = 0

while ($attempt -lt $MaxAttempts) {
  $attempt++
  "=== attempt $attempt $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" |
    Tee-Object $log -Append

  & $Ossutil sync $SourceDir $Bucket `
    -c $Config `
    --update `
    --parallel 16 `
    --checkers 32 `
    --bigfile-threshold 100Mi `
    --exclude '*.json' `
    --exclude '*.part' `
    2>&1 | Tee-Object -FilePath $log -Append

  if ($LASTEXITCODE -eq 0) {
    "=== OSS_SYNC_DONE after $attempt attempts $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" |
      Tee-Object $log -Append
    exit 0
  }

  "=== failed exit=$LASTEXITCODE, retry in 60s ===" | Tee-Object $log -Append
  Start-Sleep 60
}

throw "OSS sync failed after $MaxAttempts attempts. See $log"
