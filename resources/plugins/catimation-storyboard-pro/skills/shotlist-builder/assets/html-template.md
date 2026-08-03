# 单文件 HTML 分镜表模板

输出是一个**自包含**的 HTML 文件:不引外部 CSS、不引外部 JS、不引字体 CDN。用户
双击就能开,断网也能用,能打印成 PDF。

替换 `{占位符}` 后整份写盘到:

- 在制片包里 → `<project>/06_delivery/shotlist_<scope>.html`
- 独立任务 → `<workspace>/assets/shotlist/shotlist_<scope>.html`

写完把**绝对路径**回给用户。不要把整份 HTML 贴进聊天。

## 骨架

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>分镜表 — {SCOPE}</title>
<style>
:root{--bg:#0b0b0d;--panel:#151518;--line:#2a2a30;--fg:#e7e7ea;--dim:#9a9aa4;--accent:#22c55e;--warn:#f59e0b}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.container{max-width:1600px;margin:0 auto;padding:24px}
.top h1{margin:0 0 4px;font-size:22px;font-weight:650}
.top .sub{color:var(--dim);font-size:13px}
.stats{display:flex;gap:14px;margin-top:14px;flex-wrap:wrap}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px 16px;min-width:88px}
.stat .v{font-size:20px;font-weight:650}
.stat .l{color:var(--dim);font-size:12px}
.toolbar{display:flex;gap:10px;margin:20px 0;flex-wrap:wrap;position:sticky;top:0;background:var(--bg);padding:10px 0;z-index:5}
.toolbar input,.toolbar select,.toolbar button{background:var(--panel);border:1px solid var(--line);color:var(--fg);border-radius:6px;padding:8px 12px;font-size:13px}
.toolbar input{flex:1;min-width:220px}
.toolbar button{cursor:pointer}
.toolbar button:hover{border-color:var(--accent)}
.toc{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px 14px;margin-bottom:20px}
.toc a{color:var(--dim);text-decoration:none;margin-right:14px}
.toc a:hover{color:var(--accent)}
.scene{margin-bottom:36px;border:1px solid var(--line);border-radius:10px;overflow:hidden}
.scene-head{background:var(--panel);padding:14px 16px;border-bottom:1px solid var(--line)}
.scene-num{display:inline-block;background:#3f1d1d;color:#fca5a5;border-radius:4px;padding:2px 8px;font-size:12px;font-weight:650}
.scene-title{margin:8px 0 6px;font-size:16px}
.scene-meta{color:var(--dim);font-size:12px;display:flex;gap:18px;flex-wrap:wrap}
table.shotlist{width:100%;border-collapse:collapse;table-layout:fixed}
table.shotlist th{background:#101014;text-align:left;padding:10px;font-size:12px;color:var(--dim);border-bottom:1px solid var(--line)}
table.shotlist td{padding:10px;border-bottom:1px solid var(--line);vertical-align:top;font-size:13px}
.c-num{color:var(--dim);font-variant-numeric:tabular-nums}
.badge{display:inline-block;border-radius:4px;padding:2px 8px;font-size:11px;white-space:nowrap}
.p-ws{background:#132e1a;color:#86efac}.p-ms{background:#132434;color:#93c5fd}
.p-cu{background:#2e1330;color:#f0abfc}.p-ecu{background:#331a13;color:#fdba74}
.p-macro{background:#2b2b13;color:#fde047}.p-pan{background:#13302e;color:#5eead4}
.p-os{background:#232326;color:#c4c4cc}.p-vo{background:#1c1633;color:#c4b5fd}
.p-dis{background:#2a2a30;color:#9a9aa4}
.script-inner{color:var(--dim);white-space:pre-wrap;font-size:12px}
.prompt-head{border-top:1px solid var(--line);margin:12px 0 8px;padding-top:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.prompt-head b{color:var(--accent)}
.prompt-head .tag{color:var(--dim);font-size:11px}
.prompt-head button{background:#232326;border:1px solid var(--line);border-radius:4px;color:var(--dim);font-size:11px;padding:2px 8px;cursor:pointer}
.prompt-head button:hover{color:var(--accent);border-color:var(--accent)}
.prompt-block{background:#0f0f12;border:1px solid var(--line);border-radius:6px;padding:10px;white-space:pre-wrap;font-size:12px;line-height:1.7}
.empty-state{text-align:center;color:var(--dim);padding:40px}
@media print{
  body{background:#fff;color:#000}
  .toolbar,.toc{display:none}
  .scene,.prompt-block,table.shotlist td,table.shotlist th{border-color:#ccc}
  .prompt-block{background:#f6f6f6}
}
</style>
</head>
<body>
<div class="container">
  <header class="top">
    <h1>分镜表 — {SCOPE}</h1>
    <div class="sub">{N_SHOTS} 个镜头 · {N_SCENES} 场 · 逐镜 Seedance 提示词</div>
    <div class="stats">
      <div class="stat"><div class="v">{N_SCENES}</div><div class="l">场</div></div>
      <div class="stat"><div class="v">{N_SHOTS}</div><div class="l">镜头</div></div>
      <div class="stat"><div class="v">{N_PROMPTS}</div><div class="l">提示词</div></div>
    </div>
  </header>

  <div class="toolbar">
    <input type="text" id="search" placeholder="搜索台词、地点、动作、提示词…">
    <select id="planFilter">
      <option value="">全部景别</option>
      {PLAN_OPTIONS}
    </select>
    <button onclick="window.print()">打印 / PDF</button>
    <button onclick="resetFilters()">重置</button>
  </div>

  <div class="toc">{TOC_LINKS}</div>

  {SCENE_BLOCKS}

  <div class="empty-state" id="emptyState" style="display:none;">没有匹配项。试试重置筛选。</div>
</div>
<script>
function rows(){return Array.from(document.querySelectorAll('tr[data-scene]'))}
function apply(){
  var q=document.getElementById('search').value.trim().toLowerCase();
  var plan=document.getElementById('planFilter').value;
  var shown=0;
  rows().forEach(function(tr){
    var okPlan=!plan||tr.dataset.plan===plan;
    var okText=!q||tr.textContent.toLowerCase().indexOf(q)>-1;
    var ok=okPlan&&okText;
    tr.style.display=ok?'':'none';
    if(ok)shown++;
  });
  document.querySelectorAll('section.scene').forEach(function(sec){
    var any=Array.from(sec.querySelectorAll('tr[data-scene]')).some(function(tr){return tr.style.display!=='none'});
    sec.style.display=any?'':'none';
  });
  document.getElementById('emptyState').style.display=shown?'none':'';
}
function resetFilters(){
  document.getElementById('search').value='';
  document.getElementById('planFilter').value='';
  apply();
}
function copyPrompt(btn){
  var el=btn.closest('.prompt-head').nextElementSibling;
  navigator.clipboard.writeText(el.textContent).then(function(){
    var t=btn.textContent;btn.textContent='已复制';setTimeout(function(){btn.textContent=t},1200);
  });
}
document.getElementById('search').addEventListener('input',apply);
document.getElementById('planFilter').addEventListener('change',apply);
</script>
</body>
</html>
```

## 每场的块

```html
<section class="scene" id="sc{N}">
  <div class="scene-head">
    <span class="scene-num">SCENE {N}</span>
    <h2 class="scene-title">{INT_EXT_HEADER}</h2>
    <div class="scene-meta">
      <span><b>地点:</b> {LOCATION}</span>
      <span><b>基调:</b> <i>{MOOD}</i></span>
      <span>{N_SHOTS} 个镜头</span>
    </div>
  </div>
  <table class="shotlist">
    <colgroup>
      <col style="width:56px"><col style="width:130px"><col style="width:130px">
      <col style="width:auto"><col style="width:26%"><col style="width:34%">
    </colgroup>
    <thead>
      <tr><th>#</th><th>景别</th><th>运镜</th><th>动作</th><th>剧本原文</th><th>Seedance 提示词</th></tr>
    </thead>
    <tbody>
      {SHOT_ROWS}
    </tbody>
  </table>
</section>
```

## 镜头行 + 提示词单元格

一个提示词组的**第一行**用 `rowspan` 扛起右侧两栏,同组后续行只有前四栏。

```html
<tr data-scene="{N}" data-plan="{PLAN_CODE}">
  <td class="c-num">{SHOT_NUM}</td>
  <td class="c-plan"><span class="badge p-{PLAN_CLASS}">{PLAN_LABEL}</span></td>
  <td class="c-cam">{CAMERA_NOTE}</td>
  <td class="c-act">{ACTION_BEAT}</td>
  <td class="c-script" rowspan="{GROUP_SIZE}"><div class="script-inner">{SCENE_TEXT}</div></td>
  <td class="c-prompt" rowspan="{GROUP_SIZE}">{PROMPT_BLOCKS}</td>
</tr>
<!-- 同组后续行:只有前四个 td -->
```

## 提示词块(每条一个)

```html
<div class="prompt-head">
  <b>提示词 {I}</b>
  <span class="tag">[{TAG}]</span>
  <span class="tag">{DURATION}s · {RATIO}</span>
  <button onclick="copyPrompt(this)">复制</button>
</div>
<div class="prompt-block">{CHINESE_PROMPT}</div>
```

`{TAG}` 是一眼能看懂的短标签(`[ECU · 冰箱照片 + 取照片]`),写法见
`../references/prompt-density.md`。`{DURATION}` 和 `{RATIO}` 取自本次已确认的规格,
不要写死。

## 语言

表格的 UI 标签、场次头、动作栏、剧本原文栏——按用户的工作语言。提示词块内部按
Seedance 的提交语言(通常中文);提示词里的台词保留原文,不翻译。

## 转义

写盘前对所有插入内容做 HTML 转义:`&` → `&amp;`、`<` → `&lt;`、`>` → `&gt;`、
`"` → `&quot;`。提示词里常见的 `⚠️`、`【】`、`@图片1` 直接写没问题;但 `<主体1>`
这种尖括号**必须转义成** `&lt;主体1&gt;`,否则浏览器会把它当标签吞掉——复制出来的
提示词就少了主体标签。这是这份模板最容易翻车的一处。
