$targetPath = (Resolve-Path 'release\win-unpacked\resources\app.asar').Path
Write-Host "Looking for processes holding: $targetPath"
$found = $false
Get-Process | ForEach-Object {
  try {
    foreach ($mod in $_.Modules) {
      if ($mod.FileName -like '*win-unpacked*') {
        Write-Host ("HOLD: pid={0} name={1} module={2}" -f $_.Id, $_.ProcessName, $mod.FileName)
        $found = $true
      }
    }
  } catch {}
}
if (-not $found) {
  Write-Host "No processes hold any win-unpacked module. Trying brute delete..."
  Remove-Item 'release\win-unpacked\resources\app.asar' -Force -ErrorAction Continue
  Remove-Item 'release' -Recurse -Force -ErrorAction Continue
}
