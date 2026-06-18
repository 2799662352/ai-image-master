$ErrorActionPreference = 'Stop'
$dir = 'd:\tecx\text\temp-ai-image-master-source'
# preset name -> unicode-escaped JS literal (pure ASCII, avoids console encoding issues)
$presets = [ordered]@{
  'biaozhun'   = '\u6807\u51c6'           # 标准
  'guangjiao'  = '\u5e7f\u89d2'           # 广角
  'chaoguang'  = '\u8d85\u5e7f\u89d2'     # 超广角
  'renxiang'   = '\u4eba\u50cf'           # 人像
  'changjiao'  = '\u957f\u7126'           # 长焦
  'chaochang'  = '\u8d85\u957f\u7126'     # 超长焦
  'yuyan'      = '\u9c7c\u773c'           # 鱼眼
}
$allEsc = "['\u6807\u51c6','\u5e7f\u89d2','\u8d85\u5e7f\u89d2','\u4eba\u50cf','\u957f\u7126','\u8d85\u957f\u7126','\u9c7c\u773c']"
$results = [ordered]@{}
foreach ($k in $presets.Keys) {
  $esc = $presets[$k]
  # 1) open the lens dropdown (button whose text is one of the 7 presets)
  $openJs = "(()=>{const P=$allEsc;const b=[...document.querySelectorAll('button')].find(x=>P.includes((x.innerText||'').trim()));if(b){b.click();return 'ok';}return 'no';})()"
  agent-browser eval $openJs | Out-Null
  Start-Sleep -Milliseconds 350
  # 2) click the option matching this preset (leaf element with exact text)
  $clickJs = "(()=>{const t='$esc';const els=[...document.querySelectorAll('li,div,span,button,[role=option],[role=menuitem]')].filter(e=>e.children.length===0 && (e.textContent||'').trim()===t);if(els.length){els[els.length-1].click();return 'ok';}return 'no';})()"
  $r = agent-browser eval $clickJs
  Start-Sleep -Milliseconds 350
  # 3) read the FOV slider value (the range with min=10 max=150)
  $fovJs = "(()=>{const r=[...document.querySelectorAll('input[type=range]')].find(x=>x.min==='10'&&x.max==='150');return r?r.value:'?';})()"
  $fov = agent-browser eval $fovJs
  $results[$k] = ($fov -replace '"','').Trim()
}
$results | ConvertTo-Json | Set-Content -Path "$dir\docs\_lens.json" -Encoding UTF8
Get-Content "$dir\docs\_lens.json"
