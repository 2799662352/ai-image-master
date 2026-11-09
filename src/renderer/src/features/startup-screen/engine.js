// @ts-nocheck
/* ============================================================================
 * CATIMATION 启动动画引擎
 * ----------------------------------------------------------------------------
 * 移植自 dsh-startup-screen（MIT，Copyright (c) 2026 沈宏宏），许可全文见同目录
 * THIRD_PARTY_NOTICE.md。与上游的区别：
 *   - 导出 createStartupScreen()，不再依赖 window.__DSH_* 全局与宿主路由；
 *   - 标识换成 CATIMATION 猫头（内联 SVG，轮廓见 catMark.js；终幕和第二幕标识有「一笔画成」动画），
 *     品牌文案换成本应用的；
 *   - 真声素材走 HTMLAudio（file:// 下 fetch 会被 Chromium 拦截），缺素材 = 静音；
 *   - 身份与登录态由宿主注入（setIdentity / setAuthenticated）；界面里没有任何密码输入，
 *     第 1 步在未登录时的点击只会经 onAction 通知宿主去走网页登录；
 *   - 去掉标题栏同步、重播、跳过模式、9 秒兜底等 DeepSeek Harness 宿主层。
 *
 * 序列 / 交互 / 时间线与上游一致：
 *   第一幕  黑幕 + 标识 + 字距收紧 + 扫光
 *   过场    过曝洗白（黑 → 灰 → 暖白底板）
 *   第二幕  暖白“技术档案”底板：品牌块、页脚、进度条
 *   序列    需要访问许可 → 身份资料确认 → 接收访问需求 → 读取权限 → 验证通过
 *   交互    第 1、2 步等待用户确认（按钮 / Enter / 空格 / 点击），Esc 或右上角可跳过
 *   终幕    WELCOME TO / [品牌] / 标识，色散故障后揭幕
 * ========================================================================== */
import { CAT_MARK_VIEWBOX, CAT_MARK_CONTOURS } from './catMark.js'

export function createStartupScreen(options) {
  try {
    return build(options || {})
  } catch (err) {
    cleanupAfterFailure()
    throw err
  }
}

var ROOT_ID = 'cat-startup-root'

/** build() 中途抛错时，别把黑幕和滚动锁留在应用上。 */
function cleanupAfterFailure() {
  try {
    var r = document.getElementById(ROOT_ID)
    if (r && r.parentNode) r.parentNode.removeChild(r)
    document.documentElement.classList.remove('dsu-lock')
    document.documentElement.style.overflow = ''
    if (document.body) document.body.style.overflow = ''
  } catch (e) { /* 兜底本身不许再抛 */ }
}

function build(options) {

  /* ── 默认配置 ──────────────────────────────────────────────────────────── */
  var DEFAULTS = {
    theme: 'light',             // light | dark
    speed: 1,
    requireInteraction: true,   // 第 1、2 步等待用户确认（改成 false = 整段自动播）
    allowSkip: true,
    sound: true,                // 界面音效（真素材优先，缺了回落 WebAudio 合成）
    soundVolume: 0.5,
    voice: true,                // 播报真声素材（缺素材 = 静音）
    voiceSource: 'asset',       // asset=真声素材 / tts=全部浏览器合成
    voiceVolume: 0.9,
    voiceCue: true,             // 念台词前的一声轻提示
    voiceLead: 240,             // 提示音之后留一小段空白再开口
    ttsFallback: false,         // 素材缺失时是否退到浏览器 TTS（默认不退：静音）
    voiceLang: 'en',            // 仅 TTS 兜底用：en | zh | both
    voiceName: '',
    voiceRate: 0.88,
    voicePitch: 0.85,
    sfx: 'audio',               // audio=优先用真素材「哒」(sfx-tick / sfx-ticks-run),缺了回落合成;synth=一律现场合成
    identity: '创作者',          // 由宿主 setIdentity() 换成登录用户的名字
    identityId: '',
    accessLevel: '3',
    authenticated: null,        // null=还不知道 / true=已登录 / false=访客
    requireLogin: true,         // true=没登录就不放行（只能登录或显式「跳过」）；宿主没有登录能力时关掉
    revision: 'DESKTOP',
    brand1: 'CATIMATION',
    brand2: 'AI IMAGE · VIDEO STUDIO',
    brand3a: 'CYBERPUNK',
    brand3b: 'MASTER',
    orgEn: 'CATIMATION',
    orgSub: 'CYBERPUNK MASTER',
    welcomeBox: 'CATIMATION',
    footer: 'POWERED BY CATIMATION',
    accent: '#ff7500',
    glitchA: '#ff3b30',
    glitchB: '#2971b8'
  }

  /* ── 序列脚本：中文主字 + 英文等宽字幕 + 底部日志 ───────────────────────
     `say` 是专门给语音播报用的自然语句（照着参考片里女声念状态行的节奏，
     正好卡在各自文字出现的时间点上）。 */
  /* ── 序列脚本 ──────────────────────────────────────────────────────────
     文字与真声素材一一对应（来自你给的音频）：
       line-1.mp3 = V1 需要访问许可
       line-2.mp3 = V2 身份资料确认
       line-3.mp3 = V4 接收访问需求
       line-4.mp3 = V5 开始读取权限
       line-5.mp3 = V6 读取完毕 · 核验通过
     V3 是用户名字独白，按你的要求不用。
     `say` 是素材拿不到时的 TTS 兜底文本；`audio` 是素材文件名（不含扩展名）。 */
  var STEPS = [
    {
      zh: '需要访问许可',
      en: 'ACCESS PERMISSION REQUIRED',
      say: 'Access permission required.',
      audio: 'line-1',
      log: '等待用户授权…',
      logEn: 'AWAITING OPERATOR CONSENT',
      badge: 'AUTHORIZATION',
      action: 'grant',
      btnZh: '授予访问权限',
      btnEn: 'GRANT ACCESS',
      hold: 900,
      progress: 0.34
    },
    {
      zh: '身份资料确认',
      en: 'IDENTITY VERIFICATION',
      say: 'Identity verification.',
      audio: 'line-2',
      log: '核对身份资料…',
      logEn: 'MATCHING OPERATOR RECORD',
      badge: 'IDENTITY',
      action: 'confirm',
      btnZh: '确认身份',
      btnEn: 'CONFIRM IDENTITY',
      hold: 700,
      progress: 0.5
    },
    {
      zh: '接收访问需求',
      en: 'ACCESS REQUEST RECEIVED',
      say: 'Access request received.',
      audio: 'line-3',
      log: '接收访问需求，建立会话通道…',
      logEn: 'HANDSHAKE ESTABLISHED',
      badge: 'REQUEST',
      action: 'auto',
      hold: 1200,
      progress: 0.66,
      assembleLogo: true
    },
    {
      zh: '开始读取权限',
      en: 'PERMISSION READ STARTED',
      say: 'Beginning permission read.',
      audio: 'line-4',
      log: '开始读取权限，索引工作区与会话…',
      logEn: 'READING PERMISSION SET',
      badge: 'READ',
      action: 'auto',
      hold: 1200,
      progress: 0.8,
      hex: true
    },
    {
      zh: '读取完毕 · 核验通过',
      en: 'READ COMPLETE · VERIFIED',
      say: 'Read complete. Verification passed.',
      audio: 'line-5',
      log: '读取完毕，核验通过，权限已授予',
      logEn: 'PERMISSION AUTHORIZED',
      badge: 'VERIFY',
      action: 'auto',
      hold: 1600,
      progress: 0.93,
      reticle: true
    }
  ]

  /** 一行文本：去控制字符、折叠空白、截到 max 字；空串当没有。 */
  function cleanText(v, max) {
    return String(v == null ? '' : v)
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max)
  }

  /** 名字只留一行、去控制字符、≤48 字；空串当没有。 */
  function cleanName(v) { return cleanText(v, 48) }

  /** 代号取名字里的字母数字；纯中文名字取不到时退回 OPERATOR。 */
  function deriveId(name) {
    var id = String(name).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12)
    return id || 'OPERATOR'
  }

  function cfg() {
    var raw = (options.config && typeof options.config === 'object') ? options.config : {}
    var out = {}
    for (var k in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) out[k] = DEFAULTS[k]
    for (var k2 in raw) {
      if (Object.prototype.hasOwnProperty.call(raw, k2) && raw[k2] !== undefined && raw[k2] !== null) {
        out[k2] = raw[k2]
      }
    }
    out.speed = Math.min(3, Math.max(0.35, Number(out.speed) || 1))
    out.identity = cleanName(out.identity) || DEFAULTS.identity
    out.identityId = String(out.identityId || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || deriveId(out.identity)
    out.authenticated = out.authenticated === true ? true : (out.authenticated === false ? false : null)
    out.requireLogin = out.requireLogin !== false
    return out
  }

  var C = cfg()

  /** 路径 = 素材目录 + 相对名；assetBase 为空时没有素材。 */
  var assetBase = typeof options.assetBase === 'string' ? options.assetBase : ''
  if (assetBase && assetBase.charAt(assetBase.length - 1) !== '/') assetBase += '/'
  /** 上游靠全局代际号让“重播”后的旧时间线失效；这里每个实例独立，永远不会过期。 */
  function stale() { return false }
  function noop() {}

  /* 停滞看门狗：任意一幕卡住（音频不 resolve / 音频设备切换 / 音频上下文被挂起）都要放行。
     每推进一幕重新上弦；等用户操作时 disarm，不把正在犹豫的人踢出去。 */
  var STALL_MS = 15000
  var stallTimer = null
  function disarmStall() {
    if (stallTimer) { clearTimeout(stallTimer); stallTimer = null }
  }
  function armStall() {
    disarmStall()
    stallTimer = setTimeout(function () {
      if (finished || stale()) return
      try { console.warn('[startup-screen] 时间线停滞超过 ' + STALL_MS + 'ms，强制揭幕') } catch (e) { /* noop */ }
      finish()
    }, STALL_MS)
  }

  /** 全局监听（Esc、首次手势解锁音频）统一登记，结束 / 拆除时一并摘掉。 */
  var detachers = []
  function onGlobal(target, type, fn, opts) {
    target.addEventListener(type, fn, opts)
    detachers.push(function () { target.removeEventListener(type, fn, opts) })
  }
  function detachGlobalListeners() {
    var list = detachers
    detachers = []
    for (var i = 0; i < list.length; i++) {
      try { list[i]() } catch (e) { /* noop */ }
    }
  }

  function unlockScroll() {
    try {
      document.documentElement.classList.remove('dsu-lock')
      document.documentElement.style.overflow = ''
      if (document.body) document.body.style.overflow = ''
    } catch (e) { /* noop */ }
  }

  /** 拆掉当前实例：停时间线、清定时器、停语音、摘监听、解滚动锁、摘根节点。不触发 onFinish。 */
  var disposed = false
  function dispose() {
    disposed = true
    finished = true
    disarmStall()
    try { restoreAppBackdrop() } catch (e) { /* noop */ }
    try { releaseAll() } catch (e) { /* noop */ }
    try { stopHex() } catch (e) { /* noop */ }
    if (clockTimer) { clearInterval(clockTimer); clockTimer = null }
    try { voice.stop() } catch (e) { /* noop */ }
    try { detachGlobalListeners() } catch (e) { /* noop */ }
    unlockScroll()
    try {
      var r = document.getElementById(ROOT_ID)
      if (r && r.parentNode) r.parentNode.removeChild(r)
    } catch (e) { /* noop */ }
  }

  /* ── 小工具 ───────────────────────────────────────────────────────────── */
  function el(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }

  var SVG_NS = 'http://www.w3.org/2000/svg'

  function svgEl(tag, attrs) {
    var n = document.createElementNS(SVG_NS, tag)
    for (var k in attrs) n.setAttribute(k, attrs[k])
    return n
  }

  /** CATIMATION 猫头：内联 SVG（不发任何请求，file:// 下也没有 mask / fetch 被拦的问题）。
      两层：实心面（evenodd 挖出耳内与双眼）+ 同一组轮廓的描边。描边平时不可见，
      drawMark() 给它跑「一笔画成」；每条轮廓 pathLength=1，所以长短不同的轮廓会同时走完。 */
  function markEl(cls) {
    var svg = svgEl('svg', {
      class: cls || '',
      viewBox: CAT_MARK_VIEWBOX,
      'aria-hidden': 'true',
      focusable: 'false'
    })
    svg.appendChild(svgEl('path', { class: 'dsu-mark-fill', d: CAT_MARK_CONTOURS.join(' ') }))
    for (var i = 0; i < CAT_MARK_CONTOURS.length; i++) {
      svg.appendChild(svgEl('path', { class: 'dsu-mark-line', d: CAT_MARK_CONTOURS[i], pathLength: '1' }))
    }
    return svg
  }

  /** 猫头「一笔画成」：沿轮廓描边走完 → 落墨成面 → 描边收掉。
      动画本身是 CSS（见 .dsu-mark.dsu-draw），这里只按当前速度把时间写成变量再触发；
      不支持动画（jsdom / 老内核）时猫头就是静止的实心面，不挡任何流程。 */
  function drawMark(mark, traceMs) {
    if (!mark) return
    var s = mark.style
    s.setProperty('--dsu-draw-ms', ms(traceMs) + 'ms')
    s.setProperty('--dsu-ink-delay', ms(Math.round(traceMs * 0.78)) + 'ms')
    s.setProperty('--dsu-ink-ms', ms(Math.round(traceMs * 0.42)) + 'ms')
    s.setProperty('--dsu-fade-delay', ms(traceMs) + 'ms')
    s.setProperty('--dsu-fade-ms', ms(Math.round(traceMs * 0.4)) + 'ms')
    mark.classList.remove('dsu-draw')
    void mark.getBoundingClientRect()   /* 重播时让动画从头开始 */
    mark.classList.add('dsu-draw')
  }

  /** 逐字渐显：比逐字截断更稳（居中排版不会因为字宽变化而抖动） */
  function typeIn(host, text, stagger) {
    host.textContent = ''
    var frag = document.createDocumentFragment()
    var n = 0
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i)
      if (ch === ' ') {
        frag.appendChild(document.createTextNode('\u00a0'))
        continue
      }
      var s = el('span', 'dsu-ch', ch)
      s.style.transitionDelay = Math.round(n * stagger) + 'ms'
      frag.appendChild(s)
      n++
    }
    host.appendChild(frag)
  }

  function setIn(node, on, cls) {
    if (!node) return
    node.classList.toggle(cls || 'dsu-in', !!on)
  }

  /* ── DOM 搭建 ─────────────────────────────────────────────────────────── */
  /* 上一个实例没清干净（异常中断）时，别在它的残骸上叠第二层 */
  var stray = document.getElementById(ROOT_ID)
  if (stray && stray.parentNode) stray.parentNode.removeChild(stray)
  var root = el('div')
  root.id = ROOT_ID
  root.className = 'dsu-root'
  document.body.appendChild(root)
  root.classList.toggle('dsu-dark', C.theme === 'dark')
  var backdropOn = false
  root.style.setProperty('--dsu-speed', String(C.speed))
  root.style.setProperty('--dsu-accent', C.accent)
  root.style.setProperty('--dsu-glitch-a', C.glitchA)
  root.style.setProperty('--dsu-glitch-b', C.glitchB)

  /* 液态玻璃：只让「背景层」（底板 / 黑幕）半透明 + 磨砂，
     文字、线条、品牌标识、读数这些主体素材保持实心 —— 所以稿面还在，只是透出了背后的界面。 */
  var blurredNodes = []
  /** 兜底：backdrop-filter 不可用时，直接模糊应用本体（除自己的根节点）。 */
  function blurAppBackdrop(px) {
    try {
      if (!document.body || !document.body.children) return
      for (var i = 0; i < document.body.children.length; i++) {
        var node = document.body.children[i]
        if (!node || !node.style || node.id === ROOT_ID) continue
        blurredNodes.push({ node: node, filter: node.style.filter || '' })
        node.style.transition = 'filter 420ms ease'
        node.style.filter = px > 0 ? 'blur(' + px + 'px)' : ''
      }
    } catch (e) { /* 兜底不抛 */ }
  }
  function restoreAppBackdrop() {
    for (var i = 0; i < blurredNodes.length; i++) {
      var it = blurredNodes[i]
      try {
        it.node.style.filter = it.filter
        it.node.style.transition = ''
      } catch (e) { /* noop */ }
    }
    blurredNodes.length = 0
  }

  if (C.glass) {
    var gAlpha = clamp01(C.glassOpacity, 0.15, 0.95)
    var gBlur = clamp01(C.glassBlur, 0, 60)
    var gSat = clamp01(C.glassSaturate, 100, 200)
    root.classList.add('dsu-glass')
    root.style.setProperty('--dsu-glass-alpha', String(gAlpha))
    root.style.setProperty('--dsu-glass-blur', gBlur + 'px')
    root.style.setProperty('--dsu-glass-sat', gSat + '%')
    /* 这里刻意不置 transparent：启动期 body 是白底，
       一上来透明就会在首帧露出白色，看起来就是「闪一下」。
       等底板铺满（下方 plate opacity=1 之后）再放开。 */
    /* 背景模糊：独立一层，专门糊「玻璃背后的东西」，和玻璃自身的磨砂是两个参数 */
    backdropOn = true
    var backdropBlur = clamp01(C.glassBackdropBlur, 0, 80)
    root.style.setProperty('--dsu-backdrop-blur', backdropBlur + 'px')
    /* 直接模糊应用本体：backdrop-filter 在跨层级/跨堆叠上下文时会被静默忽略
       （实测表现是「底板透明了但背后不糊」），所以背景模糊不再依赖它 ——
       给 body 里除自己以外的根节点加 filter，效果确定、可在 finish/dispose 还原。 */
    /* 上限 60：再高就只剩一片纯色，看不出「背景变糊」而像「背景没了」 */
    if (backdropBlur > 0) blurAppBackdrop(Math.min(60, backdropBlur))
  } else {
    root.classList.remove('dsu-glass')
  }

  var ui = {}
  var clockTimer = null
  var html =
    '<div class="dsu-plate"></div>' +
    '<div class="dsu-vignette"></div>' +
    '<div class="dsu-watermark"></div>' +
    '<div class="dsu-grain"></div>' +
    '<div class="dsu-black">' +
      '<div class="dsu-black-inner"></div>' +
      '<div class="dsu-sweep"></div>' +
    '</div>' +
    '<div class="dsu-wash"></div>' +
    '<header class="dsu-brand">' +
      '<div class="dsu-brand-1"></div><div class="dsu-brand-2"></div>' +
      '<div class="dsu-brand-3"><b></b><span></span></div>' +
    '</header>' +
    '<div class="dsu-stepcount">[ 00 / 06 ] INIT</div>' +
    '<div class="dsu-center">' +
      '<div class="dsu-status"><span class="dsu-status-zh"></span><i class="dsu-caret"></i></div>' +
      '<div class="dsu-sub-en"></div>' +
      '<div class="dsu-rule"></div>' +
      '<div class="dsu-logo"></div>' +
      '<div class="dsu-dots" hidden></div>' +
    '</div>' +
    '<div class="dsu-idline"></div>' +
    '<div class="dsu-reticle"></div>' +
    '<div class="dsu-hex"></div>' +
    '<div class="dsu-welcome">' +
      '<div class="dsu-w1">WELCOME TO</div>' +
      '<div class="dsu-w2"></div>' +
      '<div class="dsu-w3"></div>' +
      '<div class="dsu-w4"></div>' +
    '</div>' +
    '<div class="dsu-action">' +
      '<div class="dsu-card" hidden></div>' +
      '<button class="dsu-btn" type="button">' +
        '<span class="dsu-btn-zh"></span><span class="dsu-btn-en"></span>' +
      '</button>' +
      '<div class="dsu-hint"></div>' +
      '<div class="dsu-subact">' +
        '<button class="dsu-link dsu-logout" type="button" hidden></button>' +
        '<button class="dsu-link dsu-skiplogin" type="button" hidden></button>' +
      '</div>' +
    '</div>' +
    '<div class="dsu-frame">' +
      '<i class="dsu-corner dsu-c-tl"></i><i class="dsu-corner dsu-c-tr"></i>' +
      '<i class="dsu-corner dsu-c-bl"></i><i class="dsu-corner dsu-c-br"></i>' +
      '<div class="dsu-scanline"></div>' +
    '</div>' +
    '<div class="dsu-slats"></div>' +
    '<div class="dsu-voice"><i></i><i></i><i></i><i></i><i></i></div>' +
    '<div class="dsu-meta"><span class="dsu-meta-1"></span><span class="dsu-meta-2"></span></div>' +
    '<div class="dsu-skip">SKIP ▸</div>' +
    '<footer class="dsu-foot"><span></span><i></i></footer>' +
    '<div class="dsu-subtitle">' +
      '<span class="dsu-sub-zh"></span><span class="dsu-sub-en2"></span>' +
    '</div>' +
    '<div class="dsu-progress"><i></i></div>' +
    '<div class="dsu-bloom"></div>' +
    '<div class="dsu-streak"></div>' +
    '<div class="dsu-flash"></div>'

  root.innerHTML = html

  /* 背景层：只在液态玻璃开启时插入，专门做「背景模糊」——
     它自己透明、只带 backdrop-filter，所以和底板/黑幕的磨砂互不影响。 */
  if (backdropOn) {
    var backdropEl = el('div', 'dsu-backdrop')
    root.insertBefore(backdropEl, root.firstChild)
  }

  function q(sel) { return root.querySelector(sel) }
  ui.plate = q('.dsu-plate')
  ui.watermark = q('.dsu-watermark')
  ui.black = q('.dsu-black')
  ui.blackInner = q('.dsu-black-inner')
  ui.sweep = q('.dsu-sweep')
  ui.wash = q('.dsu-wash')
  ui.flash = q('.dsu-flash')
  ui.bloom = q('.dsu-bloom')
  ui.streak = q('.dsu-streak')
  ui.vignette = q('.dsu-vignette')
  ui.brand = q('.dsu-brand')
  ui.center = q('.dsu-center')
  ui.brand1 = q('.dsu-brand-1')
  ui.brand2 = q('.dsu-brand-2')
  ui.brand3b = q('.dsu-brand-3 b')
  ui.brand3s = q('.dsu-brand-3 span')
  ui.stepcount = q('.dsu-stepcount')
  ui.status = q('.dsu-status')
  ui.statusZh = q('.dsu-status-zh')
  ui.caret = q('.dsu-caret')
  ui.subEn = q('.dsu-sub-en')
  ui.rule = q('.dsu-rule')
  ui.logo = q('.dsu-logo')
  ui.dots = q('.dsu-dots')
  ui.idline = q('.dsu-idline')
  ui.reticle = q('.dsu-reticle')
  ui.hex = q('.dsu-hex')
  ui.welcome = q('.dsu-welcome')
  ui.w1 = q('.dsu-w1')
  ui.w2 = q('.dsu-w2')
  ui.w3 = q('.dsu-w3')
  ui.w4 = q('.dsu-w4')
  ui.action = q('.dsu-action')
  ui.card = q('.dsu-card')
  ui.btn = q('.dsu-btn')
  ui.btnZh = q('.dsu-btn-zh')
  ui.btnEn = q('.dsu-btn-en')
  ui.hint = q('.dsu-hint')
  ui.logout = q('.dsu-logout')
  ui.skipLogin = q('.dsu-skiplogin')
  ui.skip = q('.dsu-skip')
  ui.foot = q('.dsu-foot')
  ui.footText = q('.dsu-foot span')
  ui.subZh = q('.dsu-sub-zh')
  ui.subEn2 = q('.dsu-sub-en2')
  ui.progress = q('.dsu-progress')
  ui.bar = q('.dsu-progress i')
  ui.frame = q('.dsu-frame')
  ui.scanline = q('.dsu-scanline')
  ui.slats = q('.dsu-slats')
  ui.voice = q('.dsu-voice')
  ui.meta = q('.dsu-meta')
  ui.meta1 = q('.dsu-meta-1')
  ui.meta2 = q('.dsu-meta-2')

  /* 内容填充 */
  ui.brand1.textContent = C.brand1
  ui.brand2.textContent = C.brand2
  ui.brand3b.textContent = C.brand3a
  ui.brand3s.textContent = C.brand3b
  ui.footText.textContent = C.footer
  ui.w2.textContent = C.welcomeBox

  /** 身份名称 / 代号出现在三处（终幕问候、右下读数、第 2 步身份卡），换人时一起重画。 */
  function paintIdentity() {
    ui.w4.textContent = '欢迎 ' + C.identity + ' 访问'
    ui.idline.textContent = '· ID CONFIRMED : ' + C.identityId
    if (ui.card && !ui.card.hidden) paintCard()
  }
  paintIdentity()

  ;(function blackStage() {
    /* 第一幕：猫头 + CATIMATION（字距收紧）+ CYBERPUNK MASTER（黄，宽字距），与导航栏品牌一致 */
    var inner = ui.blackInner
    inner.appendChild(markEl('dsu-mark'))
    var en = el('div', 'dsu-black-en', C.orgEn)
    inner.appendChild(en)
    inner.appendChild(el('div', 'dsu-black-sub', C.orgSub))
    ui.blackEn = en
  })()

  ;(function logoStage() {
    ui.logo.appendChild(markEl('dsu-mark'))
    ui.logo.appendChild(el('div', 'dsu-logolabel', 'C A T I M A T I O N'))
  })()

  ;(function welcomeLogo() {
    ui.w3.appendChild(markEl('dsu-mark'))
    ui.w3.appendChild(el('span', 'dsu-w3label', 'C Y B E R P U N K   M A S T E R'))
  })()

  ;(function watermark() {
    var boxes = [
      [0.60, 0.02, 0.16, 0.96], [0.78, 0.02, 0.16, 0.96], [0.96, 0.02, 0.16, 0.96],
      [0.05, 0.02, 0.10, 0.5]
    ]
    for (var i = 0; i < boxes.length; i++) {
      var b = boxes[i]
      var n = el('div', 'dsu-wm')
      n.style.left = (b[0] * 100) + '%'
      n.style.top = (b[1] * 100) + '%'
      n.style.width = (b[2] * 100) + '%'
      n.style.height = (b[3] * 100) + '%'
      ui.watermark.appendChild(n)
    }
  })()

  /* 左侧六格阶段柱 + 品牌块下方的小字数据行 + 实时时钟 */
  ;(function slatsAndMeta() {
    for (var i = 0; i < STEPS.length + 1; i++) ui.slats.appendChild(el('i', 'dsu-slat'))
    ui.meta1.textContent = 'REV ' + String(C.revision || 'DESKTOP').slice(0, 24)
    paintClock()
    clockTimer = setInterval(paintClock, 1000)
  })()

  ;(function reticle() {
    var ns = 'http://www.w3.org/2000/svg'
    var svg = document.createElementNS(ns, 'svg')
    svg.setAttribute('viewBox', '0 0 400 400')
    function arc(cx, cy, r, a0, a1, cls, cap) {
      var rad = function (d) { return (d - 90) * Math.PI / 180 }
      var x0 = cx + r * Math.cos(rad(a0)), y0 = cy + r * Math.sin(rad(a0))
      var x1 = cx + r * Math.cos(rad(a1)), y1 = cy + r * Math.sin(rad(a1))
      var large = (a1 - a0) > 180 ? 1 : 0
      var p = document.createElementNS(ns, 'path')
      p.setAttribute('d', 'M' + x0.toFixed(2) + ' ' + y0.toFixed(2) +
        ' A' + r + ' ' + r + ' 0 ' + large + ' 1 ' + x1.toFixed(2) + ' ' + y1.toFixed(2))
      p.setAttribute('class', cls)
      if (cap) p.setAttribute('stroke-linecap', cap)
      return { node: p, x: x1, y: y1, x0: x0, y0: y0 }
    }
    var gA = document.createElementNS(ns, 'g')
    gA.setAttribute('class', 'dsu-ret-rot-a')
    /* 300° 弧，缺口留在正下方 6 点钟方向：底部字幕永远不会被压到，
       弧末端圆点落在 5 点钟位置，和原片一致。 */
    var a = arc(200, 200, 150, 215, 505, 'dsu-ring-a', 'round')
    gA.appendChild(a.node)
    var da = document.createElementNS(ns, 'circle')
    da.setAttribute('class', 'dsu-dot-a')
    da.setAttribute('cx', a.x.toFixed(2)); da.setAttribute('cy', a.y.toFixed(2)); da.setAttribute('r', '7')
    gA.appendChild(da)
    svg.appendChild(gA)

    var gB = document.createElementNS(ns, 'g')
    gB.setAttribute('class', 'dsu-ret-rot-b')
    var b = arc(200, 200, 104, 200, 490, 'dsu-ring-b', 'round')
    gB.appendChild(b.node)
    var db = document.createElementNS(ns, 'circle')
    db.setAttribute('class', 'dsu-dot-b')
    db.setAttribute('cx', b.x0.toFixed(2)); db.setAttribute('cy', b.y0.toFixed(2)); db.setAttribute('r', '4')
    gB.appendChild(db)
    svg.appendChild(gB)

    var gC = document.createElementNS(ns, 'g')
    var bl = arc(200, 200, 62, 118, 242, 'dsu-bracket', 'round')
    var br = arc(200, 200, 62, 298, 62, 'dsu-bracket', 'round')
    gC.appendChild(bl.node); gC.appendChild(br.node)
    svg.appendChild(gC)

    var pts = [[152, 132], [252, 268], [278, 150]]
    for (var i = 0; i < pts.length; i++) {
      var c = document.createElementNS(ns, 'circle')
      c.setAttribute('class', 'dsu-dot-o')
      c.setAttribute('cx', pts[i][0]); c.setAttribute('cy', pts[i][1]); c.setAttribute('r', '2.8')
      svg.appendChild(c)
    }
    ui.reticle.appendChild(svg)
  })()

  /* ── 时间线引擎 ───────────────────────────────────────────────────────── */
  var timers = []
  var waiters = []
  var skipped = false
  var finished = false
  var hexTimer = null

  function ms(base) { return Math.round(base / C.speed) }

  function wait(base) {
    return new Promise(function (resolve) {
      if (skipped || finished) return resolve()
      var done = false
      function fin() {
        if (done) return
        done = true
        var i = waiters.indexOf(fin)
        if (i >= 0) waiters.splice(i, 1)
        resolve()
      }
      var t = setTimeout(fin, Math.max(0, ms(base)))
      timers.push(t)
      waiters.push(fin)
    })
  }

  /** 把「用户点了第 1 / 2 步的按钮 / 退出登录」交给宿主（游客点按钮 = 立刻拉起网页登录）。跳过 / 自动放行不走这里。 */
  function emitAction(kind) {
    if (typeof options.onAction !== 'function') return
    try { options.onAction({ action: kind, authenticated: C.authenticated }) } catch (err) { /* 宿主出错不许拖垮时间线 */ }
  }

  /* 登录闸门（第 1、2 步）：没登录就不放行，只能登录成功或显式「跳过」。
       idle     还没人点 / 回到可点状态
       checking 用户点了，宿主在确认登录状态
       waiting  浏览器登录已拉起，等授权结果
       error    这一轮没成（loginMessage 是给人看的原因），再点一次重试
       leaving  第 2 步点了「退出登录」，等宿主收尾
     状态全由宿主经 setLoginState 推进；引擎自己只在用户点击时进 checking。 */
  var loginState = 'idle'
  var loginMessage = ''
  /** 这一步里用户点过「继续」没有。登录成功只放行点过的人，没点过的还得自己点一下确认。 */
  var gateAttempted = false
  var gateRelease = null

  function inSubAction(e) {
    var t = e && e.target
    return !!(t && typeof t.closest === 'function' && t.closest('.dsu-subact'))
  }

  function waitAction(step) {
    return new Promise(function (resolve) {
      if (skipped || finished || !C.requireInteraction) return resolve()
      /* 等用户操作期间不上弦：正在犹豫的人不该被看门狗踢出去 */
      disarmStall()
      var done = false
      /* user === true 才是人点的、且已登录的放行；releaseAll（跳过 / 揭幕）和登录成功的放行没有参数 */
      function fin(user) {
        if (done) return
        done = true
        cleanup()
        armStall()
        if (user === true) emitAction(step.action)
        resolve()
      }
      function attempt() {
        if (done) return
        /* 正在退出登录：此刻点「继续」会拿着即将失效的身份往下走，一律先等宿主收尾 */
        if (loginState === 'leaving') return
        /* 已登录（或宿主根本没有登录能力）：照旧一点就走 */
        if (C.authenticated === true || C.requireLogin === false) return fin(true)
        /* 没登录：不放行。通知宿主立刻拉起网页登录，停在这一步等结果；
           等待中重复点击 / 回车不再重复发起 */
        if (loginState === 'checking' || loginState === 'waiting') return
        gateAttempted = true
        setLoginState('checking')
        emitAction(step.action)
      }
      function onKey(e) {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
          /* 焦点在「退出登录 / 跳过登录」上：让按钮自己处理，别被当成主按钮 */
          if (inSubAction(e)) return
          e.preventDefault()
          attempt()
        }
      }
      function onClick(e) {
        if (inSubAction(e)) return
        e.preventDefault()
        attempt()
      }
      function cleanup() {
        ui.action.removeEventListener('click', onClick)
        document.removeEventListener('keydown', onKey)
        gateRelease = null
        gateAttempted = false
        var i = waiters.indexOf(fin)
        if (i >= 0) waiters.splice(i, 1)
      }
      /* 登录成功 / 宿主确认无需登录：只放行点过按钮的人 */
      gateRelease = function () { if (gateAttempted) fin() }
      /* 按钮在 .dsu-action 里，点击会冒泡上来：只挂外层一处，别让一次点击触发两遍 */
      ui.action.addEventListener('click', onClick)
      document.addEventListener('keydown', onKey)
      waiters.push(fin)
    })
  }

  function releaseAll() {
    for (var i = 0; i < timers.length; i++) clearTimeout(timers[i])
    timers.length = 0
    var list = waiters.slice()
    waiters.length = 0
    for (var j = 0; j < list.length; j++) { try { list[j]() } catch (err) { /* noop */ } }
  }

  function setProgress(p) {
    var pct = Math.max(0, Math.min(1, p))
    ui.bar.style.width = Math.round(pct * 100) + '%'
  }

  /** 六格阶段柱：走过的压暗、当前的拉满并点亮主题橙 */
  function setSlats(active) {
    var items = ui.slats.children
    for (var i = 0; i < items.length; i++) {
      var idx = i + 1
      items[i].classList.toggle('dsu-on', idx === active)
      items[i].classList.toggle('dsu-past', idx < active)
    }
  }

  /** 扫描线自上而下扫一遍（底板洗白后一次，验准时再一次） */
  function sweep() {
    if (!ui.scanline) return
    ui.scanline.classList.remove('dsu-go')
    void ui.scanline.offsetWidth
    ui.scanline.classList.add('dsu-go')
  }

  function paintClock() {
    var d = new Date()
    var pad = function (n) { return (n < 10 ? '0' : '') + n }
    ui.meta2.textContent = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
  }

  function setSubtitle(zh, en) {
    ui.subZh.classList.remove('dsu-in')
    ui.subEn2.classList.remove('dsu-in')
    setTimeout(function () {
      ui.subZh.textContent = zh || ''
      ui.subEn2.textContent = en || ''
      ui.subZh.classList.add('dsu-in')
      if (en) ui.subEn2.classList.add('dsu-in')
    }, ms(140))
  }

  function setStepCount(i, code) {
    var totalSteps = STEPS.length + 1
    ui.stepcount.textContent = '[ ' + String(i).padStart(2, '0') + ' / ' +
      String(totalSteps).padStart(2, '0') + ' ] ' + code
  }

  function startHex() {
    var lines = 12
    function line() {
      var s = ''
      for (var i = 0; i < 26; i++) {
        s += '0123456789ABCDEF'.charAt(Math.floor(Math.random() * 16))
        if (i % 2 === 1) s += ' '
      }
      return s
    }
    function paint() {
      var out = []
      for (var i = 0; i < lines; i++) out.push(line())
      ui.hex.innerHTML = out.join('<br>')
    }
    paint()
    ui.hex.classList.add('dsu-in')
    audio.tickRun()
    hexTimer = setInterval(paint, 110)
  }
  function stopHex() {
    if (hexTimer) { clearInterval(hexTimer); hexTimer = null }
    ui.hex.classList.remove('dsu-in')
  }

  /* ── 声音 ──────────────────────────────────────────────────────────────
   * 两条独立的通道，都不依赖任何音频文件：
   *   audio —— 界面音效，WebAudio 现场合成（咔哒 / 双音确认 / 噪声扫频 / 和声钟）
   *   voice —— 女声播报，Web Speech API 念每一行的英文（照参考片的女声节奏：
   *            7.3-9.3s 念状态行、19.6-21.2s 念 PERMISSION AUTHORIZED）
   * 浏览器策略要求"先有用户手势"，所以第一次点击/按键会补一次解锁 + 补播。 */
  function clamp01(v, lo, hi) {
    var n = Number(v)
    return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo
  }

  var audio = (function () {
    var ctx = null
    function ac(force) {
      /* 语音素材要独立于「界面音效」开关：force=true 时无视 C.sound */
      if (!C.sound && !force) return null
      try {
        var AC = window.AudioContext || window.webkitAudioContext
        if (!AC) return null
        if (!ctx) ctx = new AC()
        if (ctx.state === 'suspended' && typeof ctx.resume === 'function') ctx.resume()
        return ctx
      } catch (e) { return null }
    }
    function vol(gain) { return Math.max(0.0002, (gain == null ? 0.05 : gain) * clamp01(C.soundVolume, 0, 1) * 2) }
    function tone(freq, dur, type, gain, delay, glideTo) {
      var c = ac(); if (!c) return
      try {
        var t0 = c.currentTime + (delay || 0)
        var o = c.createOscillator(), g = c.createGain()
        o.type = type || 'sine'
        o.frequency.setValueAtTime(freq, t0)
        if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t0 + dur)
        g.gain.setValueAtTime(0.0001, t0)
        g.gain.exponentialRampToValueAtTime(vol(gain), t0 + Math.min(0.02, dur * 0.3))
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
        o.connect(g); g.connect(c.destination)
        o.start(t0); o.stop(t0 + dur + 0.03)
      } catch (e) { /* 静默降级 */ }
    }
    function noise(dur, gain) {
      var c = ac(); if (!c) return
      try {
        var n = Math.floor(c.sampleRate * dur)
        var buf = c.createBuffer(1, n, c.sampleRate)
        var d = buf.getChannelData(0)
        for (var i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n)
        var src = c.createBufferSource(); src.buffer = buf
        var f = c.createBiquadFilter(); f.type = 'bandpass'
        f.frequency.value = 1500; f.Q.value = 0.6
        var g = c.createGain(); g.gain.value = vol(gain)
        src.connect(f); f.connect(g); g.connect(c.destination)
        src.start()
      } catch (e) { /* 静默降级 */ }
    }
    /* 真声素材走 HTMLAudio：file:// 下 fetch() 会被 Chromium 拦截，<audio> 不会。
       素材缺失 / 解码失败 / 加载超时都只是 resolve(false)——这一行静音，时间线照常走。 */
    var voiceEls = {}
    var ASSET_LOAD_TIMEOUT_MS = 3000

    function assetUrl(name) { return assetBase + name + '.mp3' }

    function newAudio(url) {
      if (typeof options.createAudio === 'function') return options.createAudio(url)
      var a = new Audio()
      a.preload = 'auto'
      a.src = url
      return a
    }

    /** 预加载一条素材；resolve(true) = 拿到了可播放的时长，resolve(false) = 没有 / 坏了 / 超时。 */
    function ensureAsset(name) {
      var known = voiceEls[name]
      if (known) return known.ready
      var rec = { el: null, ready: null }
      voiceEls[name] = rec
      rec.ready = new Promise(function (resolve) {
        if (C.voiceSource === 'tts' || !assetBase) { resolve(false); return }
        var a = null
        try { a = newAudio(assetUrl(name)) } catch (e) { resolve(false); return }
        if (!a) { resolve(false); return }
        rec.el = a
        var settled = false
        var timer = null
        function done(ok) {
          if (settled) return
          settled = true
          if (timer) clearTimeout(timer)
          try {
            a.removeEventListener('loadedmetadata', onMeta)
            a.removeEventListener('canplaythrough', onMeta)
            a.removeEventListener('error', onFail)
          } catch (e) { /* noop */ }
          if (!ok) rec.el = null
          resolve(ok)
        }
        function onMeta() { if (isFinite(a.duration) && a.duration > 0) done(true) }
        function onFail() { done(false) }
        try {
          a.addEventListener('loadedmetadata', onMeta)
          a.addEventListener('canplaythrough', onMeta)
          a.addEventListener('error', onFail)
        } catch (e) { done(false); return }
        timer = setTimeout(function () { done(false) }, ASSET_LOAD_TIMEOUT_MS)
        if (a.readyState >= 1) onMeta()
        try { if (typeof a.load === 'function') a.load() } catch (e) { /* noop */ }
      })
      return rec.ready
    }

    /** 播素材并等它播完，resolve 实际时长(ms)。拿不到素材 / 被自动播放策略拦下 resolve 0。
     *  'ended' 是正常出口；再加一道超时兜底，保证这一步一定有结果，不会把人锁在黑幕里。 */
    function playAssetAndWait(name, gain, onStart) {
      return new Promise(function (resolve) {
        var rec = voiceEls[name]
        var a = rec && rec.el
        if (!a || finished) { resolve(0); return }
        var dur = Math.round((isFinite(a.duration) && a.duration > 0 ? a.duration : 0) * 1000)
        var settled = false
        var guard = null
        function fin(ms) {
          if (settled) return
          settled = true
          if (guard) clearTimeout(guard)
          try {
            a.removeEventListener('ended', onEnd)
            a.removeEventListener('error', onErr)
          } catch (e) { /* noop */ }
          resolve(ms)
        }
        function onEnd() { fin(dur) }
        function onErr() { fin(0) }
        try {
          a.addEventListener('ended', onEnd)
          a.addEventListener('error', onErr)
          a.volume = Math.min(1, (gain == null ? 0.85 : gain) * clamp01(C.voiceVolume, 0, 1) * 1.6)
          try { a.currentTime = 0 } catch (e) { /* noop */ }
          var p = a.play()
          if (p && typeof p.then === 'function') {
            p.then(function () { if (!settled && typeof onStart === 'function') onStart() }, function () { fin(0) })
          } else if (typeof onStart === 'function') {
            onStart()
          }
        } catch (e) { fin(0); return }
        guard = setTimeout(function () { fin(dur) }, dur + 1500)
      })
    }

    /* 界面音效素材（「哒」）：同样走 HTMLAudio，没加载好 / 播不出就回落现场合成，绝不静音也不抛错。
       C.sfx === 'synth'、界面音效关闭、没有素材目录时一律不碰素材。 */
    var sfxEls = {}

    function sfxEnabled() { return C.sfx !== 'synth' && !!C.sound && !!assetBase }

    function newSfx(url) {
      if (typeof options.createSfxAudio === 'function') return options.createSfxAudio(url)
      return newAudio(url)
    }

    function ensureSfx(name) {
      if (!sfxEnabled()) return false
      var known = sfxEls[name]
      if (known) return known.ok
      var rec = { el: null, ok: false }
      sfxEls[name] = rec
      var a = null
      try { a = newSfx(assetUrl(name)) } catch (e) { return false }
      if (!a) return false
      rec.el = a
      function onMeta() { if (isFinite(a.duration) && a.duration > 0) rec.ok = true }
      function onFail() { rec.ok = false; rec.el = null }
      try {
        a.addEventListener('loadedmetadata', onMeta)
        a.addEventListener('canplaythrough', onMeta)
        a.addEventListener('error', onFail)
        if (a.readyState >= 1) onMeta()
        if (typeof a.load === 'function') a.load()
      } catch (e) { onFail() }
      return rec.ok
    }

    /** 优先播素材；素材没就绪 / 播放被拒就跑 fallback（合成音）。 */
    function sfx(name, gain, fallback) {
      var fell = false
      function fall() { if (fell) return; fell = true; try { fallback() } catch (e) { /* noop */ } }
      if (!sfxEnabled()) { fall(); return }
      ensureSfx(name)
      var rec = sfxEls[name]
      var a = rec && rec.ok && rec.el
      if (!a) { fall(); return }
      try {
        a.volume = Math.min(1, (gain == null ? 0.5 : gain) * clamp01(C.soundVolume, 0, 1) * 2)
        try { a.currentTime = 0 } catch (e) { /* noop */ }
        var p = a.play()
        if (p && typeof p.then === 'function') p.then(null, fall)
      } catch (e) { fall() }
    }

    function stopVoices() {
      for (var k in voiceEls) {
        var a = voiceEls[k] && voiceEls[k].el
        if (a) { try { a.pause() } catch (e) { /* noop */ } }
      }
      for (var s in sfxEls) {
        var b = sfxEls[s] && sfxEls[s].el
        if (b) { try { b.pause() } catch (e) { /* noop */ } }
      }
    }

    return {
      resume: function () { ac() },
      ensureAsset: ensureAsset,
      playAssetAndWait: playAssetAndWait,
      stopVoices: stopVoices,
      ensureSfx: ensureSfx,
      /* 文字渐显 / 阶段推进 / 按钮确认：真素材「哒」优先（增益沿用上游 0.45 / 0.85 / 0.6 / 0.5），缺了回落合成 */
      tick: function () { sfx('sfx-tick', 0.45, function () { tone(1760, 0.035, 'square', 0.022) }) },
      confirm: function () {
        sfx('sfx-tick', 0.85, function () { tone(660, 0.09, 'triangle', 0.07); tone(990, 0.17, 'triangle', 0.055, 0.085) })
      },
      tickRun: function () {
        sfx('sfx-ticks-run', 0.5, function () { for (var i = 0; i < 6; i++) tone(1760 + (i % 3) * 220, 0.03, 'square', 0.016, i * 0.09) })
      },
      step: function () { sfx('sfx-tick', 0.6, function () { tone(880, 0.05, 'sine', 0.05); tone(1320, 0.07, 'sine', 0.028, 0.045) }) },
      hover: function () { tone(2200, 0.02, 'sine', 0.018) },
      sweep: function () { noise(0.75, 0.035) },
      /* 念台词之前的两声轻提示 */
      cue: function () { tone(1046.5, 0.05, 'sine', 0.028); tone(1568, 0.06, 'sine', 0.02, 0.075) },
      rise: function () { tone(220, 1.1, 'sine', 0.032, 0, 990) },
      chime: function () {
        tone(659.25, 0.9, 'sine', 0.055)
        tone(830.61, 0.9, 'sine', 0.04, 0.09)
        tone(987.77, 1.3, 'sine', 0.045, 0.18)
      }
    }
  })()

  var voice = (function () {
    var supported = typeof window !== 'undefined' && !!window.speechSynthesis &&
      typeof window.SpeechSynthesisUtterance === 'function'
    var voices = []
    var picked = { en: null, zh: null }
    var meter = null
    var saidOnce = false
    var pending = { en: '', zh: '' }

    /* 想让它听起来像"AI 播报"，音色本身比什么都重要。
       同一台机器上，"Microsoft Zira Desktop" 是上世纪拼接合成，念长句塑料味很重；
       Edge 的 "... Online (Natural)"、Chrome 的 "Google ..."、macOS 的 Siri 才是神经网络音色。
       所以这里按分数挑，而不是挨个名字第一个命中。 */
    var NATURAL_HINTS = ['natural', 'neural', 'online', 'premium', 'enhanced', 'siri', 'google']
    var FEMALE_HINTS = [
      'aria', 'jenny', 'michelle', 'emma', 'ava', 'libby', 'sonia', 'maisie',
      'zira', 'samantha', 'karen', 'moira', 'tessa', 'victoria', 'serena', 'allison',
      'susan', 'fiona', 'hazel', 'female', 'woman',
      'xiaoxiao', 'xiaoyi', 'xiaomo', 'huihui', 'yaoyao', '晓晓', '晓伊', '女声'
    ]
    var MALE_HINTS = ['david', 'mark', 'guy', 'ryan', 'george', 'daniel', 'alex', 'fred',
      'male', 'yunxi', 'yunjian', 'kangkang']

    /** 给一个音色打分：神经网络 > 女声 > 语种吻合 > 本地 */
    function score(v, want) {
      var name = String(v.name || '').toLowerCase()
      var lang = String(v.lang || '').toLowerCase()
      var sc = 0
      for (var i = 0; i < NATURAL_HINTS.length; i++) {
        if (name.indexOf(NATURAL_HINTS[i]) !== -1) { sc += 60; break }
      }
      for (var j = 0; j < FEMALE_HINTS.length; j++) {
        if (name.indexOf(FEMALE_HINTS[j]) !== -1) { sc += 40; break }
      }
      for (var k = 0; k < MALE_HINTS.length; k++) {
        if (name.indexOf(MALE_HINTS[k]) !== -1) { sc -= 45; break }
      }
      if (lang.indexOf(want) === 0) sc += 25
      if (v.localService) sc += 4          /* 本地音色起播快，不会先卡半秒 */
      if (v.default) sc += 3
      return sc
    }

    /** 挑某语种最合适的一个音色（want 传 'en' / 'zh' 这样的两字母前缀） */
    function bestFor(want) {
      if (!voices.length) return null
      if (C.voiceName) {
        for (var i = 0; i < voices.length; i++) {
          var v = voices[i]
          if (v.name === C.voiceName && String(v.lang || '').toLowerCase().indexOf(want) === 0) return v
        }
      }
      var pool = []
      for (var j = 0; j < voices.length; j++) {
        if (String(voices[j].lang || '').toLowerCase().indexOf(want) === 0) pool.push(voices[j])
      }
      if (!pool.length) pool = voices.slice()
      var best = null
      var bs = -1e9
      for (var n = 0; n < pool.length; n++) {
        var sc = score(pool[n], want)
        if (sc > bs) { bs = sc; best = pool[n] }
      }
      return best
    }

    function setMeter(on) { if (meter) meter.classList.toggle('dsu-on', !!on) }

    function load() {
      if (!supported) return
      try { voices = window.speechSynthesis.getVoices() || [] } catch (e) { voices = [] }
      picked.en = bestFor('en')
      picked.zh = bestFor('zh')
    }

    /** 全大写名字有些引擎会一个字母一个字母念，转成 Title Case 更像在叫名字 */
    function spokenName(name) {
      return String(name || '').replace(/\S+/g, function (w) {
        return (/^[A-Z0-9.\-]+$/.test(w) && w.length > 1) ? w.charAt(0) + w.slice(1).toLowerCase() : w
      })
    }

    function utter(text, lang) {
      try {
        var u = new window.SpeechSynthesisUtterance(text)
        var v = lang.indexOf('zh') === 0 ? picked.zh : picked.en
        if (v) { u.voice = v; u.lang = v.lang || lang } else u.lang = lang
        /* 神经网络音色在 .95 / 1.02 这个档位最像"系统在播报"：
           再快就赶，再慢就假；音调略抬一点显得干净利落 */
        u.rate = clamp01(C.voiceRate, 0.5, 2)
        u.pitch = clamp01(C.voicePitch, 0, 2)
        u.volume = clamp01(C.voiceVolume, 0, 1)
        u.onstart = function () { setMeter(true) }
        u.onend = function () { setMeter(false) }
        u.onerror = function () { setMeter(false) }
        window.speechSynthesis.speak(u)
        return true
      } catch (e) { return false }
    }

    /** 一句话的时长估算（个别引擎不触发 onend 时兜底；中文按字、英文按字符） */
    function estimateMs(items) {
      var chars = 0
      var rate = clamp01(C.voiceRate, 0.5, 2) || 1
      for (var i = 0; i < items.length; i++) {
        var t = String(items[i].t || '')
        chars += /[\u4e00-\u9fa5]/.test(t) ? t.length * 1.7 : t.length
      }
      return Math.round((chars / 13) * 1000 / rate) + 460
    }

    function buildUtter(text, lang) {
      var u = new window.SpeechSynthesisUtterance(text)
      var v = lang.indexOf('zh') === 0 ? picked.zh : picked.en
      if (v) { u.voice = v; u.lang = v.lang || lang } else u.lang = lang
      u.rate = clamp01(C.voiceRate, 0.5, 2)
      u.pitch = clamp01(C.voicePitch, 0, 2)
      u.volume = clamp01(C.voiceVolume, 0, 1)
      return u
    }

    return {
      supported: supported,
      load: load,
      attach: function (node) { meter = node },

      /**
       * 念一行，返回"这一行实际花了多久(ms)"的 Promise。
       *
       * 三个关键决定：
       *  - **不 cancel 上一句**。原来每步都 cancel，用户点快一点、或者
       *    hold 短于台词长度，语音就被硬生生掐断 —— 那正是要避免的。
       *    speechSynthesis 本身是队列，不 cancel 就是顺序播报。
       *  - 提示音响过之后留 `voiceLead` 的空白再开口，这是旁白的呼吸感。
       *  - 等 `onend` 才 resolve，动画据此决定这一步停多久；个别引擎不触发
       *    onend 时按估算兜底，绝不把动画卡死。
       */
      line: function (en, zh, asset) {
        /* 有真声素材就用素材；素材缺失默认静音，只有 ttsFallback / voiceSource=tts 才退到浏览器 TTS */
        if (asset && C.voice && C.voiceSource !== 'tts' && !finished) {
          return audio.ensureAsset(asset).then(function (ok) {
            if (!ok || finished) return 0
            if (C.voiceCue !== false) audio.cue()
            return audio.playAssetAndWait(asset, 0.85, function () { setMeter(true) }).then(function (ms) {
              setMeter(false)
              return ms
            })
          }).then(function (ms) {
            if (ms > 0) { saidOnce = true; return ms }
            return ttsEnabled() ? ttsLine(en, zh) : 0
          })
        }
        return ttsEnabled() ? ttsLine(en, zh) : Promise.resolve(0)
      },

      /** TTS 路径：素材缺失 / voiceSource=tts / 终幕那条动态名字 */
      tts: function (en, zh) { return ttsLine(en, zh) },

      /** 不等待的版本：设置页试听 / 任何"念完就行"的场合 */
      say: function (en, zh) { return this.line(en, zh) },

      /** 浏览器要求"先有用户手势"才放声：第一次点击/按键解锁 + 补播当前行 */
      unlock: function () {
        try { if (supported) window.speechSynthesis.resume() } catch (e) {}
        audio.resume()
        /* 预热：先无声念一个空格，把引擎唤醒，避免第一句被吃掉开头半个字 */
        if (ttsEnabled() && supported && !saidOnce) {
          try {
            var w = new window.SpeechSynthesisUtterance(' ')
            w.volume = 0
            var v = picked.en || picked.zh
            if (v) { w.voice = v; w.lang = v.lang }
            window.speechSynthesis.speak(w)
          } catch (e) { /* noop */ }
        }
        if (!saidOnce && C.voice && (pending.en || pending.zh)) this.say(pending.en, pending.zh)
      },
      speakName: spokenName,
      current: function () {
        var a = picked.en ? picked.en.name : ''
        var b = picked.zh ? picked.zh.name : ''
        return a === b ? a : (a + (b ? '  /  ' + b : ''))
      },
      listVoices: function () { return voices.slice() },
      /** 只有这里才真的掐断语音（跳过 / 揭幕） */
      stop: function () {
        try { audio.stopVoices() } catch (e) { /* noop */ }
        try { if (supported) window.speechSynthesis.cancel() } catch (e) { /* noop */ }
        setMeter(false)
      }
    }

    function ttsEnabled() { return C.ttsFallback === true || C.voiceSource === 'tts' }

    /** TTS 合成并等它念完，resolve 实际时长(ms)；拿不到引擎时 resolve 0。 */
    function ttsLine(en, zh) {
      return new Promise(function (resolve) {
        if (!supported || !C.voice || finished) { resolve(0); return }
        pending = { en: en || '', zh: zh || '' }
        var items = []
        var mode = C.voiceLang
        if (mode === 'zh') { if (zh) items.push({ t: zh, l: 'zh-CN' }) }
        else if (mode === 'both') {
          if (zh) items.push({ t: zh, l: 'zh-CN' })
          if (en) items.push({ t: en, l: 'en-US' })
        } else if (en) { items.push({ t: en, l: 'en-US' }) }
        if (!items.length) { resolve(0); return }

        saidOnce = true
        if (C.voiceCue !== false) audio.cue()

        var startedAt = Date.now()
        var est = estimateMs(items)
        var lead = clamp01(C.voiceLead, 0, 1200)
        var settled = false
        var watchdog = null

        function settle() {
          if (settled) return
          settled = true
          if (watchdog) clearTimeout(watchdog)
          setMeter(false)
          resolve(Math.max(0, Date.now() - startedAt))
        }

        setTimeout(function () {
          if (finished) { settle(); return }
          var last = items.length - 1
          for (var i = 0; i <= last; i++) {
            var u = buildUtter(items[i].t, items[i].l)
            if (i === last) {
              u.onstart = function () { setMeter(true) }
              u.onend = settle
              u.onerror = settle
            }
            try { window.speechSynthesis.speak(u) } catch (e) { if (i === last) settle() }
          }
          watchdog = setTimeout(settle, est + 900)
        }, lead)
      })
    }
  })()

  /* 语音/音效接线：声卡要等用户手势才能出声，这里挂一次性解锁 */
  voice.attach(q('.dsu-voice'))
  ;(function preloadVoices() {
    if (!C.voice || C.voiceSource === 'tts') return
    for (var i = 0; i < STEPS.length; i++) if (STEPS[i].audio) audio.ensureAsset(STEPS[i].audio)
    audio.ensureAsset('line-6')   /* 终幕欢迎语 */
  })()
  ;(function preloadSfx() {
    audio.ensureSfx('sfx-tick')
    audio.ensureSfx('sfx-ticks-run')
  })()
  ;(function wireSound() {
    if (voice.supported && (C.ttsFallback === true || C.voiceSource === 'tts')) {
      voice.load()
      if (typeof window.speechSynthesis.addEventListener === 'function') {
        onGlobal(window.speechSynthesis, 'voiceschanged', function () { voice.load() })
      }
    }
    var unlocked = false
    function unlock() {
      if (unlocked) return
      unlocked = true
      voice.unlock()
    }
    onGlobal(document, 'pointerdown', unlock, true)
    onGlobal(document, 'keydown', unlock, true)
    onGlobal(document, 'touchstart', unlock, true)
  })()

  /* ── 时间线 ───────────────────────────────────────────────────────────── */
  function run() {
    armStall()
    return Promise.resolve()
      /* 第一幕：黑幕 --> CATIMATION 标识 */
      .then(function () { return wait(820) })
      .then(function () {
        ui.blackInner.classList.add('dsu-in')
        audio.rise()
        return wait(240)
      })
      .then(function () {
        ui.blackEn.classList.add('dsu-tighten')
        return wait(880)
      })
      .then(function () {
        ui.sweep.classList.add('dsu-go')
        return wait(760)
      })
      /* 过场：过曝洗白 */
      .then(function () {
        ui.blackInner.classList.add('dsu-out')
        audio.sweep()
        ui.wash.style.transition = 'opacity ' + ms(220) + 'ms linear'
        ui.wash.style.opacity = '1'
        return wait(260)
      })
      .then(function () {
        ui.plate.style.transition = 'opacity ' + ms(900) + 'ms ease'
        ui.plate.style.opacity = '1'
        /* 底板铺满之后才让根节点透出去；多留 60ms，避免收尾帧仍露出 body 白底。 */
        if (C.glass) {
          setTimeout(function () {
            try { root.style.background = 'transparent' } catch (e) { /* noop */ }
          }, ms(900) + 60)
        }
        ui.watermark.style.transition = 'opacity ' + ms(1100) + 'ms ease'
        ui.watermark.style.opacity = '1'
        ui.wash.style.transition = 'opacity ' + ms(720) + 'ms cubic-bezier(.2,.9,.2,1)'
        ui.wash.style.opacity = '0'
        ui.black.style.transition = 'opacity ' + ms(720) + 'ms ease'
        ui.black.style.opacity = '0'
        return wait(760)
      })
      /* 第二幕：品牌块 / 页脚 / 进度条 */
      .then(function () {
        ui.brand.classList.add('dsu-in')
        ui.foot.classList.add('dsu-in')
        ui.stepcount.classList.add('dsu-in')
        ui.idline.classList.add('dsu-in')
        ui.frame.classList.add('dsu-in')
        ui.slats.classList.add('dsu-in')
        ui.meta.classList.add('dsu-in')
        ui.vignette.classList.add('dsu-in')
        ui.voice.classList.add('dsu-in')
        setProgress(0.12)
        setStepCount(0, 'BOOT')
        setSlats(0)
        setSubtitle('系统自检中…', 'SYSTEM SELF-CHECK')
        if (C.allowSkip) ui.skip.classList.add('dsu-in')
        return wait(700)
      })
      .then(function () { ui.black.style.display = 'none'; sweep() })
      /* 六个阶段 */
      .then(function () { return stepLoop() })
      /* 终幕 */
      .then(function () { return finale() })
      .catch(function (err) {
        try { console.warn('[startup-screen] 动画异常，直接揭幕：', err) } catch (e2) {}
        return finish()
      })
  }

  function stepLoop() {
    var chain = Promise.resolve()
    STEPS.forEach(function (step, i) {
      chain = chain.then(function () {
        if (finished || stale()) return
        armStall()
        var n = i + 1
        /* 身份读数讲的是「身份已确认」，只属于前两幕。第 3 幕起是「接收访问需求」，
           这句信息已经过期，跟着身份核验一起退场，不再一路挂到终幕。 */
        if (i >= 2) ui.idline.classList.remove('dsu-in')
        setStepCount(n, step.badge)
        setSlats(n)
        setProgress(step.progress)
        setSubtitle(step.log, step.logEn)
        audio.step()
        /* 语音在这里起头，但**不阻塞**下面的文字渐显 —— 两者同时发生 */
        var spoke = voice.line(step.say, step.zh, step.audio)

        ui.status.classList.toggle('dsu-zhline', true)
        /* 先摘掉 dsu-in 并强制一次样式计算，新的逐字 span 才会重新走渐显动画 */
        ui.status.classList.remove('dsu-in')
        ui.subEn.classList.remove('dsu-in')
        void ui.status.offsetWidth
        typeIn(ui.statusZh, step.zh, 46)
        typeIn(ui.subEn, step.en, 13)
        ui.caret.classList.toggle('dsu-on', !!step.action && step.action !== 'auto')
        requestAnimationFrame(function () {
          if (finished) return
          ui.status.classList.add('dsu-in')
          ui.subEn.classList.add('dsu-in')
        })
        ui.rule.classList.add('dsu-in')

        if (step.assembleLogo) assembleLogo()
        if (step.reticle) {
          /* 照原片：准星出现时中央只留状态字，品牌标识和虚线收掉，别挤成一团 */
          ui.logo.classList.remove('dsu-in')
          ui.dots.hidden = true
          ui.reticle.classList.add('dsu-in')
          sweep()
        }
        if (step.hex) startHex()

        /* 这一步停多久 = max(视觉基准, 实际播报时长 + 收尾留白) —— 台词长就多停，
           台词短也不会干等。用户点得快时同样等这一句念完，不掐断。 */
        function holdFor(spoken) {
          var target = Math.max(ms(step.hold), (spoken || 0) + ms(240))
          return wait(Math.max(0, target - (spoken || 0)))
        }

        if (step.action === 'grant' || step.action === 'confirm') {
          showAction(step)
          return wait(520).then(function () { return waitAction(step) }).then(function () {
            hideAction()
            audio.confirm()
            ui.caret.classList.remove('dsu-on')
            return spoke
          }).then(function () { return wait(ms(320)) })
        }
        if (step.hex) {
          return spoke.then(holdFor).then(function () { stopHex() })
        }
        return spoke.then(holdFor)
      })
    })
    return chain
  }

  function assembleLogo() {
    ui.logo.classList.add('dsu-in')
    ui.dots.hidden = false
    /* 猫头一笔画成：沿轮廓描边走完再落墨（上游鲸鱼图标同一手法） */
    drawMark(ui.logo.querySelector('.dsu-mark'), 1300)
    return wait(300)
  }

  /** 当前正在等用户确认的那一步（没有 = null） */
  var actionStep = null

  var ERROR_FALLBACK = '登录没有完成，请重试'

  /** 第 1、2 步的按钮文案：游客点它就是「网页登录」（宿主收到 onAction 后立刻拉起浏览器），全程不输密码；
      等待 / 出错 / 退出中各有自己的字样。hint 是静态 HTML；text 是带外部内容的纯文本（走 textContent）。 */
  function labelsFor(step) {
    var guest = C.authenticated === false
    var l = {
      zh: step.btnZh,
      en: step.btnEn,
      hint: '按 <kbd>Enter</kbd> / <kbd>Space</kbd>，或点击按钮继续',
      text: null
    }
    if (guest) {
      l.zh = step.action === 'confirm' ? '网页登录验证身份' : '网页登录授权'
      l.en = step.action === 'confirm' ? 'SIGN IN TO VERIFY' : 'SIGN IN VIA WEB'
      l.hint = '点击或按 <kbd>Enter</kbd> 在浏览器中登录 · 无需输入密码 · <kbd>Esc</kbd> 跳过'
    }
    if (loginState === 'checking') {
      l.zh = '正在确认登录状态…'
      l.en = 'CHECKING SESSION'
      l.hint = '请稍候 · <kbd>Esc</kbd> 跳过'
    } else if (loginState === 'waiting') {
      l.zh = '等待浏览器登录…'
      l.en = 'WAITING FOR BROWSER'
      l.hint = '请在刚打开的浏览器里完成授权，完成后自动继续 · <kbd>Esc</kbd> 跳过'
    } else if (loginState === 'error') {
      var msg = loginMessage || ERROR_FALLBACK
      if (C.authenticated !== true) {
        l.zh = '重新登录'
        l.en = 'TRY AGAIN'
        l.text = msg + ' · 点击重试 · Esc 跳过'
      } else {
        l.text = msg
      }
    }
    return l
  }

  function paintActionLabels() {
    if (!actionStep) return
    var l = labelsFor(actionStep)
    ui.btnZh.textContent = l.zh
    ui.btnEn.textContent = l.en
    if (l.text != null) ui.hint.textContent = l.text
    else ui.hint.innerHTML = l.hint   /* 只来自上面的静态文案，不含任何用户数据 */
    var busy = loginState === 'checking' || loginState === 'waiting' || loginState === 'leaving'
    ui.btn.classList.toggle('dsu-wait', busy)
    ui.btn.setAttribute('aria-busy', busy ? 'true' : 'false')
    ui.hint.classList.toggle('dsu-err', loginState === 'error')
    /* 没登录的人随时能显式跳过；已登录的人在身份确认这一步可以退出重来 */
    ui.skipLogin.textContent = '跳过登录 · SKIP'
    ui.skipLogin.hidden = !(C.authenticated !== true && C.requireLogin !== false && C.allowSkip)
    ui.logout.textContent = loginState === 'leaving' ? '正在退出…' : '退出登录 · 切换账号'
    ui.logout.disabled = loginState === 'leaving'
    ui.logout.hidden = !(actionStep.action === 'confirm' && C.authenticated === true)
  }

  /** 宿主推进登录闸门的状态（见 loginState 注释）。message 只在 error 时用，按一行纯文本显示。 */
  function setLoginState(state, message) {
    var s = (state === 'checking' || state === 'waiting' || state === 'error' || state === 'leaving') ? state : 'idle'
    loginState = s
    loginMessage = s === 'error' ? cleanText(message, 80) : ''
    paintActionLabels()
  }

  function paintCard() {
    ui.card.innerHTML = ''
    /* 纯中文标签 + 数字/名称，去掉英文双写与主机行，别堆信息 */
    var rows = [
      ['身份名称', C.authenticated === false ? '未登录' : C.identity, true],
      ['身份编号', C.identityId, false],
      ['权限等级', C.accessLevel, false]
    ]
    rows.forEach(function (r) {
      var row = el('div', 'dsu-card-row')
      row.appendChild(el('span', null, r[0]))
      row.appendChild(el('b', r[2] ? 'dsu-zhname' : null, r[1]))
      ui.card.appendChild(row)
    })
  }

  function showAction(step) {
    actionStep = step
    loginState = 'idle'
    loginMessage = ''
    paintActionLabels()
    ui.card.hidden = step.action !== 'confirm'
    if (step.action === 'confirm') paintCard()
    ui.action.classList.add('dsu-in')
    ui.btn.classList.add('dsu-pulse')
  }

  function hideAction() {
    actionStep = null
    loginState = 'idle'
    loginMessage = ''
    ui.action.classList.remove('dsu-in')
    ui.btn.classList.remove('dsu-pulse')
  }

  function finale() {
    if (finished || stale()) return Promise.resolve()
    armStall()
    setStepCount(6, 'WELCOME')
    setSlats(6)
    setProgress(1)
    /* 底部日志和终幕里的「欢迎 xxx 访问」区分开，避免同一句出现两遍 */
    setSubtitle('身份验证完成，会话已建立', 'IDENTITY VERIFIED · SESSION ESTABLISHED')
    audio.chime()
    /* 终幕欢迎语：自制落幕词素材 line-6（3.73 秒），在欢迎文案亮起的同一刻开念。
       素材缺失 / voiceSource=tts / voice 关闭时静音（调用时 en、zh 都传 null，不会念出合成腔）。 */
    var welcome = null

    ui.status.classList.remove('dsu-in')
    ui.subEn.classList.remove('dsu-in')
    ui.rule.classList.remove('dsu-in')
    ui.reticle.classList.remove('dsu-in')
    stopHex()
    /* 中央区（状态行/分隔线/品牌标识/虚线）整体退场：不清掉会和 WELCOME 版式叠字 */
    ui.center.classList.add('dsu-off')
    ui.dots.hidden = true

    return wait(360)
      .then(function () {
        ui.welcome.classList.add('dsu-in')
        /* 终幕猫头也一笔画成：描边 + 落墨在光晕炸开之前（约 1.06 秒内）收完，
           光晕打在已经成形的标识上 */
        drawMark(ui.w3.querySelector('.dsu-mark'), 750)
        ui.idline.classList.remove('dsu-in')
        /* 欢迎文案亮起的同一刻开口 —— 早于画面会让人以为「话没说完画面就跳了」 */
        welcome = voice.line(null, null, 'line-6')
        return wait(420)
      })
      .then(function () {
        /* 结尾色散故障：分片位移 + 0.5px 模糊 + 混合模式，读起来像镜头色散 */
        var targets = [ui.w1, ui.w2, ui.w4]
        targets.forEach(function (t) {
          t.classList.add('dsu-glitch')
          t.setAttribute('data-text', t.textContent)
        })
        ui.w2.classList.add('dsu-glitch-box')   /* 黑底白字那块换加色混合 */
        void ui.welcome.offsetWidth
        targets.forEach(function (t) { t.classList.add('dsu-on') })
        return wait(640)
      })
      /* 光晕从中心炸开 + 变形光条横扫 + 文字青色 halation */
      .then(function () {
        root.classList.add('dsu-peak')
        ui.bloom.classList.add('dsu-go')
        ui.streak.classList.add('dsu-go')
        return wait(430)
      })
      /* 光晕最亮那一下补一记极短高光（是"眨一下"，不是长时间糊白） */
      .then(function () {
        ui.flash.style.transition = 'opacity ' + ms(70) + 'ms linear'
        ui.flash.style.opacity = '0.72'
        return wait(90)
      })
      .then(function () {
        ui.flash.style.transition = 'opacity ' + ms(340) + 'ms cubic-bezier(0.4, 0, 0.2, 1)'
        ui.flash.style.opacity = '0'
        return wait(320)
      })
      /* 欢迎语没播完就不揭幕（素材缺失时这个 Promise 立刻 resolve，不影响节奏） */
      .then(function () { return welcome })
      /* 揭幕：整个机位后撤 + 轻微失焦，比单纯淡出更有镜头感 */
      .then(function () {
        root.classList.add('dsu-handoff')
        return wait(780)
      })
      .then(function () { return finish() })
  }

  function finish() {
    if (finished) return
    finished = true
    disarmStall()
    try { restoreAppBackdrop() } catch (e) { /* noop */ }
    releaseAll()
    stopHex()
    voice.stop()
    if (clockTimer) { clearInterval(clockTimer); clockTimer = null }
    detachGlobalListeners()
    /* 揭幕即解锁：不摘掉的话主界面会永远滚不动 */
    unlockScroll()
    root.classList.remove('dsu-boot')
    root.classList.add('dsu-gone')
    var evt = { skipped: skipped }
    /* 此刻用户已经要看到应用了（含被跳过）：宿主在这里记「今天播过了」 */
    if (typeof options.onFinish === 'function') {
      try { options.onFinish(evt) } catch (err) { /* noop */ }
    }
    setTimeout(function () {
      if (disposed) return
      if (root && root.parentNode) root.parentNode.removeChild(root)
      if (typeof options.onDone === 'function') {
        try { options.onDone(evt) } catch (err) { /* noop */ }
      }
    }, ms(900))
  }

  function requestSkip() {
    if (skipped || finished) return
    skipped = true
    releaseAll()
    finish()
  }

  if (C.allowSkip && ui.skip) {
    ui.skip.hidden = false
    ui.skip.addEventListener('click', function (e) { e.stopPropagation(); requestSkip() })
    onGlobal(document, 'keydown', function (e) {
      if (e.key === 'Escape') requestSkip()
    })
  } else if (ui.skip) {
    ui.skip.hidden = true
  }

  /* 「跳过登录」：和右上角 SKIP / Esc 同一条出口（不登录直接进应用）。
     stopPropagation：别让这一下被外层 .dsu-action 当成「继续」。 */
  ui.skipLogin.addEventListener('click', function (e) {
    e.stopPropagation()
    e.preventDefault()
    requestSkip()
  })
  /* 「退出登录」（身份确认那一步）：只通知宿主去退出；之后宿主推回 authenticated=false，
     按钮自动变成「网页登录验证身份」，用户再点一下就是重新网页登录。 */
  ui.logout.addEventListener('click', function (e) {
    e.stopPropagation()
    e.preventDefault()
    if (finished || !actionStep || loginState === 'leaving') return
    setLoginState('leaving')
    emitAction('logout')
  })

  /* 锁滚动，动画期间不露出下面的应用 */
  document.documentElement.classList.add('dsu-lock')
  document.documentElement.style.overflow = 'hidden'
  if (document.body) document.body.style.overflow = 'hidden'
  setProgress(0.05)
  root.classList.remove('dsu-boot')

  run()

  return {
    skip: requestSkip,
    finish: finish,
    dispose: dispose,
    /** 登录态水合出来 / 换人时：「欢迎 XXX」、身份卡、右下读数一起换。 */
    setIdentity: function (name) {
      C.identity = cleanName(name) || DEFAULTS.identity
      C.identityId = deriveId(C.identity)
      paintIdentity()
    },
    /** 登录态变化：按钮字样、身份卡、「退出 / 跳过登录」随之变；
        变成已登录时，如果用户已经点过「继续」在等登录，这一步当场放行。 */
    setAuthenticated: function (value) {
      C.authenticated = value === true ? true : (value === false ? false : null)
      if (ui.card && !ui.card.hidden) paintCard()
      paintActionLabels()
      if (C.authenticated === true && gateRelease) gateRelease()
    },
    /** 推进登录闸门：'idle' | 'checking' | 'waiting' | 'error'(+message) | 'leaving'。 */
    setLoginState: setLoginState,
    /** 宿主没有登录能力（没有登录端口 / 非 Electron）：别拦人，已点过「继续」的当场放行。 */
    setLoginRequired: function (value) {
      C.requireLogin = value !== false
      paintActionLabels()
      if (!C.requireLogin && gateRelease) gateRelease()
    },
    isFinished: function () { return finished }
  }
}
