# Batch-upload named Sakuga clips to the Bailian AV knowledge base (tajgw3h4fh)
# via agent-browser console automation. 50 files per import (console limit).
#
# Usage: pwsh -File upload_batches.ps1 [-StartBatch 0] [-BatchSize 50]
param(
    [int]$StartBatch = 0,
    [int]$BatchSize = 50
)

$ErrorActionPreference = 'Continue'
# agent-browser emits UTF-8; without this, PS 5.1 decodes as GBK and Chinese
# button-text comparisons silently fail.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$NAMED_DIR = 'D:\tecx\text\temp-ai-image-master-source\videos\Sakuga-42M\pilot\clips_named'
$SCRIPT_DIR = 'D:\tecx\text\temp-ai-image-master-source\scripts\sakuga'
$DETAIL_URL = 'https://bailian.console.aliyun.com/cn-beijing#/knowledge-base/detail/tajgw3h4fh'
$LOG = Join-Path $SCRIPT_DIR 'upload_batches.log'
$DONE_FILE = Join-Path $SCRIPT_DIR 'upload_batches_done.txt'

function Log($msg) {
    $line = "$(Get-Date -Format 'HH:mm:ss') $msg"
    Write-Output $line
    Add-Content -Path $LOG -Value $line
}

# Build the remaining list: all named clips minus the 70 already uploaded.
$uploadedNames = @()
foreach ($f in @('named_batch.txt', 'named_batch50.txt')) {
    $p = Join-Path $SCRIPT_DIR $f
    if (Test-Path $p) { $uploadedNames += (Get-Content $p | ForEach-Object { Split-Path $_ -Leaf }) }
}
if (Test-Path $DONE_FILE) {
    $uploadedNames += (Get-Content $DONE_FILE | ForEach-Object { Split-Path $_ -Leaf })
}
$uploadedSet = @{}
foreach ($n in $uploadedNames) { $uploadedSet[$n] = $true }

$remaining = Get-ChildItem "$NAMED_DIR\*.mp4" | Sort-Object Name |
    Where-Object { -not $uploadedSet.ContainsKey($_.Name) } |
    ForEach-Object { $_.FullName }

$totalBatches = [math]::Ceiling($remaining.Count / $BatchSize)
Log "remaining=$($remaining.Count) batches=$totalBatches startBatch=$StartBatch"

function Eval-JS($js) {
    $out = (& agent-browser eval $js 2>&1 | Out-String).Trim()
    # agent-browser eval prints the result JSON-encoded; strip surrounding quotes.
    return $out.Trim('"')
}

for ($b = $StartBatch; $b -lt $totalBatches; $b++) {
    $files = $remaining[($b * $BatchSize)..([math]::Min(($b + 1) * $BatchSize - 1, $remaining.Count - 1))]
    Log "=== batch $($b + 1)/$totalBatches : $($files.Count) files ==="

    # 1. Reset navigation: go to detail page first (forces hash change), then import
    & agent-browser open $DETAIL_URL 2>&1 | Out-Null
    & agent-browser wait 3000 2>&1 | Out-Null
    & agent-browser open "$DETAIL_URL/import" 2>&1 | Out-Null
    & agent-browser wait --load networkidle 2>&1 | Out-Null
    & agent-browser wait 4000 2>&1 | Out-Null
    $ready = 'nf'
    for ($try = 0; $try -lt 5 -and $ready -ne 'ready'; $try++) {
        $ready = Eval-JS "(() => { const btn=[...document.querySelectorAll('button')].find(b=>b.textContent.replace(/\s/g,'')==='下一步'); return btn ? 'ready' : 'nf' })()"
        if ($ready -ne 'ready') { & agent-browser wait 3000 2>&1 | Out-Null }
    }
    if ($ready -ne 'ready') { Log "batch $b ABORT: import page did not load"; break }

    # 2. Pick category 默认类目 (antd tree-select) and VERIFY the selection took
    $catOk = $false
    for ($try = 0; $try -lt 3 -and -not $catOk; $try++) {
        $sel = Eval-JS "(() => { const s=document.querySelector('.efm_ant-select-selection-item'); return s ? s.textContent.trim() : '' })()"
        if ($sel -eq '默认类目') { $catOk = $true; break }
        Eval-JS "(() => { const inp=document.querySelector('input[role=combobox]'); if(!inp) return 'no-cb'; ['mousedown','mouseup','click'].forEach(t=>inp.dispatchEvent(new MouseEvent(t,{bubbles:true}))); return 'opened' })()" | Out-Null
        & agent-browser wait 1500 2>&1 | Out-Null
        Eval-JS "(() => { const t=[...document.querySelectorAll('.efm_ant-select-tree-title')].find(e=>e.textContent.trim()==='默认类目'); if(!t) return 'nf'; t.click(); return 'clicked' })()" | Out-Null
        & agent-browser wait 1200 2>&1 | Out-Null
        $sel = Eval-JS "(() => { const s=document.querySelector('.efm_ant-select-selection-item'); return s ? s.textContent.trim() : '' })()"
        if ($sel -eq '默认类目') { $catOk = $true }
    }
    if (-not $catOk) { Log "batch $b ABORT: category not selected"; break }

    # 3. Attach files -- run in a job with a hard timeout: the CLI upload call
    # has been observed to hang indefinitely, which stalls the whole runner.
    $attached = '0'
    for ($try = 0; $try -lt 2; $try++) {
        $job = Start-Job -ScriptBlock { param($f) & agent-browser upload "input[type=file]" @f 2>&1 } -ArgumentList (, $files)
        $finished = Wait-Job $job -Timeout 240
        if (-not $finished) { Stop-Job $job }
        Remove-Job $job -Force
        & agent-browser wait 5000 2>&1 | Out-Null
        $attached = Eval-JS "(() => (document.body.innerText.match(/\.mp4/g)||[]).length)()"
        if ([int]$attached -ge $files.Count) { break }
        # Retry only from a clean state; a partial attach + re-attach would
        # create duplicate documents.
        if ([int]$attached -gt 0) { break }
        Log "batch $b attach retry $try (mentions=$attached, timeout=$(-not $finished))"
    }
    Log "batch $b attached-mp4-mentions: $attached (expect >= $($files.Count))"
    if ([int]$attached -lt $files.Count) { Log "batch $b ABORT: attach failed"; break }

    # 4. Wait for uploads to finish (下一步 enabled)

    $nextOk = $false
    for ($w = 0; $w -lt 120; $w++) {
        $state = Eval-JS "(() => { const btn=[...document.querySelectorAll('button')].find(b=>b.textContent.replace(/\s/g,'')==='下一步'); if(!btn) return 'nf'; return btn.disabled ? 'disabled' : 'enabled' })()"
        if ($state -eq 'enabled') { $nextOk = $true; break }
        & agent-browser wait 5000 2>&1 | Out-Null
    }
    if (-not $nextOk) { Log "batch $b ABORT: next button never enabled"; break }

    $r1 = Eval-JS "(() => { const btn=[...document.querySelectorAll('button')].find(b=>b.textContent.replace(/\s/g,'')==='下一步'); if(btn && !btn.disabled){btn.click(); return 'next'} return 'nf' })()"
    & agent-browser wait 4000 2>&1 | Out-Null

    # 5. Submit (完成), then verify by URL leaving /import (real success signal)
    $r2 = 'nf'
    for ($try = 0; $try -lt 5 -and $r2 -ne 'submitted'; $try++) {
        $r2 = Eval-JS "(() => { const btn=[...document.querySelectorAll('button')].find(b=>b.textContent.replace(/\s/g,'')==='完成'); if(btn && !btn.disabled){btn.click(); return 'submitted'} return 'nf' })()"
        if ($r2 -ne 'submitted') { & agent-browser wait 3000 2>&1 | Out-Null }
    }
    $confirmed = $false
    for ($w = 0; $w -lt 12; $w++) {
        & agent-browser wait 5000 2>&1 | Out-Null
        $url = (& agent-browser get url 2>&1 | Out-String).Trim()
        if ($url -notmatch '/import') { $confirmed = $true; break }
    }
    Log "batch $b next=$r1 submit=$r2 confirmed=$confirmed url=$url"

    if ($confirmed) {
        $files | Add-Content -Path $DONE_FILE
        Log "batch $b DONE ($($files.Count) files recorded)"
    } else {
        & agent-browser screenshot "D:\tecx\text\bl-batch-fail-$b.png" 2>&1 | Out-Null
        Log "batch $b FAILED: still on /import after submit; stopping"
        break
    }
    Start-Sleep -Seconds 5
}
Log "runner exit"
