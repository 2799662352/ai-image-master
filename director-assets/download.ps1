$ErrorActionPreference = "Continue"
$base = "d:\tecx\text\temp-ai-image-master-source\director-assets"
$catalog = [IO.File]::ReadAllText("d:\tecx\text\temp-ai-image-master-source\docs\director-model-catalog.json", [Text.Encoding]::UTF8) | ConvertFrom-Json
$hdr = @{ "Referer" = "https://rhtv.runninghub.ai/"; "User-Agent" = "Mozilla/5.0" }
$rows = @()
$n = 0
$total = ($catalog | ForEach-Object { $_.models.Count } | Measure-Object -Sum).Sum
foreach ($cat in $catalog) {
  foreach ($m in $cat.models) {
    $n++
    $mPath = "$base\models\$($m.id).gltf"
    $tPath = "$base\thumbnails\$($m.id).png"
    # model
    if (-not (Test-Path $mPath) -or (Get-Item $mPath).Length -lt 1000) {
      try { Invoke-WebRequest -Uri $m.url -Headers $hdr -OutFile $mPath -UseBasicParsing -TimeoutSec 120 } catch { Write-Host "MODEL-FAIL $($m.id): $($_.Exception.Message)" }
    }
    # thumbnail
    if ($m.previewImage -and (-not (Test-Path $tPath) -or (Get-Item $tPath).Length -lt 200)) {
      try { Invoke-WebRequest -Uri $m.previewImage -Headers $hdr -OutFile $tPath -UseBasicParsing -TimeoutSec 60 } catch { Write-Host "THUMB-FAIL $($m.id): $($_.Exception.Message)" }
    }
    $mb = if (Test-Path $mPath) { [Math]::Round((Get-Item $mPath).Length/1MB,2) } else { 0 }
    $rows += [pscustomobject]@{ category=$cat.label; categoryKey=$cat.key; id=$m.id; name=$m.name; modelFile="models/$($m.id).gltf"; thumbFile="thumbnails/$($m.id).png"; sizeMB=$mb; sourceUrl=$m.url; sourceThumb=$m.previewImage }
    Write-Host "[$n/$total] $($cat.label) / $($m.name)  ${mb}MB"
  }
}
# rig
$rigPath = "$base\rig\x_bot.fbx"
if (-not (Test-Path $rigPath)) {
  try { Invoke-WebRequest -Uri "https://rhtv.runninghub.ai/dummy/x_bot.fbx" -Headers $hdr -OutFile $rigPath -UseBasicParsing -TimeoutSec 120; Write-Host "RIG ok" } catch { Write-Host "RIG-FAIL: $($_.Exception.Message)" }
}
$rows | Export-Csv -Path "$base\manifest.csv" -NoTypeInformation -Encoding UTF8
$rows | ConvertTo-Json -Depth 5 | Out-File "$base\manifest.json" -Encoding UTF8
$okModels = ($rows | Where-Object { $_.sizeMB -gt 0 }).Count
$totalMB = [Math]::Round((($rows | Measure-Object sizeMB -Sum).Sum),2)
Write-Host "=== DONE models_ok=$okModels/$total totalMB=$totalMB rig=$(Test-Path $rigPath) ==="
