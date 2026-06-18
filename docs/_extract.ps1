param(
  [string]$File = "d:\tecx\text\temp-ai-image-master-source\docs\_Dmnzwia4.js",
  [string]$Pattern,
  [int]$Before = 300,
  [int]$After = 600,
  [int]$Max = 6
)
$txt = [System.IO.File]::ReadAllText($File)
$rx = [regex]::new($Pattern)
$ms = $rx.Matches($txt)
"=== '$Pattern' -> $($ms.Count) matches in $(Split-Path $File -Leaf) ==="
$n = 0
foreach ($m in $ms) {
  if ($n -ge $Max) { break }
  $start = [Math]::Max(0, $m.Index - $Before)
  $len = [Math]::Min($txt.Length - $start, $Before + $After)
  $snip = $txt.Substring($start, $len)
  "----- @$($m.Index) -----"
  $snip
  ""
  $n++
}
