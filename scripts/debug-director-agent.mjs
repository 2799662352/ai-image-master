// One-off diagnostic: launch the built app, open the director overlay, and
// probe (1) whether the AGENT button click opens the agent panel, and
// (2) whether the MCP image viewer modal renders above the director —
// both windowed and in element-fullscreen.
import { _electron as electron } from 'playwright'

const app = await electron.launch({
  args: ['scripts/debug-main-bootstrap.cjs'],
  env: { ...process.env, NODE_ENV: 'test', ELECTRON_DISABLE_SANDBOX: '1' },
  timeout: 120000,
})
app.process().stderr.on('data', (d) => process.stderr.write(`[main-err] ${d}`))
const page = await app.firstWindow()
page.on('console', (m) => {
  const t = m.text()
  if (m.type() === 'error' || /error|Error|crash/i.test(t)) console.log(`[renderer:${m.type()}] ${t.slice(0, 500)}`)
})
page.on('crash', () => console.log('!!! RENDERER CRASHED !!!'))
page.on('close', () => console.log('!!! PAGE CLOSED !!!'))
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(4000)

const log = (label, v) => console.log(`\n=== ${label} ===\n${JSON.stringify(v, null, 2)}`)

// 1. Open director overlay via the top-nav entry.
const opened = await page.evaluate(() => {
  const btn = document.querySelector('[data-action="open-director"]')
  if (btn) { btn.click(); return 'clicked data-action' }
  return 'no entry button found'
})
log('open director', opened)
await page.waitForTimeout(3500)

const probe = async (label) => {
  const r = await page.evaluate(() => {
    const overlay = document.getElementById('director-overlay-root')
    // Only consider the director's own AGENT button (inside the overlay) with a
    // real layout box — the main app top bar also has an AGENT entry.
    const agentBtns = [...(overlay ?? document).querySelectorAll('button')]
      .filter((b) => b.textContent.includes('AGENT'))
      .filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
    const btn = agentBtns[0] ?? null
    let hit = null
    let rect = null
    if (btn) {
      const b = btn.getBoundingClientRect()
      rect = { x: b.x, y: b.y, w: b.width, h: b.height }
      const el = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)
      hit = el ? { tag: el.tagName, cls: String(el.className).slice(0, 80), text: (el.textContent || '').slice(0, 30), isBtn: el === btn || btn.contains(el) } : null
    }
    return {
      overlayExists: !!overlay,
      agentBtnCount: agentBtns.length,
      rect,
      hit,
      fullscreen: !!document.fullscreenElement,
      panelExists: !!document.querySelector('[data-testid="agent-chat-panel"]'),
      hostParent: document.getElementById('agent-chat-root')?.parentElement?.tagName ?? 'none',
    }
  })
  log(label, r)
  return r
}

const before = await probe('before click (windowed)')

// Capture unhandled rejections (dynamic chunk import failures are silent).
await page.evaluate(() => {
  window.__rejections = []
  window.addEventListener('unhandledrejection', (e) => window.__rejections.push(String(e.reason?.stack || e.reason)))
  window.__errors = []
  window.addEventListener('error', (e) => window.__errors.push(String(e.message)))
})

// 2. Click the AGENT button (real mouse click at coords).
if (before.rect) {
  await page.mouse.click(before.rect.x + before.rect.w / 2, before.rect.y + before.rect.h / 2)
  await page.waitForTimeout(1200)
}
log('rejections/errors after click', await page.evaluate(() => ({ rejections: window.__rejections, errors: window.__errors })))

// 2b. Compare with the global shortcut path (Ctrl+Shift+A handled in mount.tsx).
await page.keyboard.press('Control+Shift+A')
await page.waitForTimeout(800)
log('after Ctrl+Shift+A', await page.evaluate(() => ({
  panelExists: !!document.querySelector('[data-testid="agent-chat-panel"]'),
})))
// close it again if it opened
await page.keyboard.press('Control+Shift+A')
await page.waitForTimeout(400)
const afterClick = await page.evaluate(() => {
  const panel = document.querySelector('[data-testid="agent-chat-panel"]')
  let info = null
  if (panel) {
    const r = panel.getBoundingClientRect()
    const cs = getComputedStyle(panel)
    const mid = document.elementFromPoint(r.x + r.width / 2, r.y + Math.min(r.height / 2, 300))
    info = {
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      zIndex: cs.zIndex, position: cs.position, display: cs.display, visibility: cs.visibility,
      topElementAtCenter: mid ? { tag: mid.tagName, inPanel: panel.contains(mid) } : null,
    }
  }
  return { panelExists: !!panel, info, hostParent: document.getElementById('agent-chat-root')?.parentElement?.id || document.getElementById('agent-chat-root')?.parentElement?.tagName }
})
log('after AGENT click (windowed)', afterClick)

// close panel again for clean fullscreen test
await page.evaluate(() => {
  const w = window
  // toggle via keyboard shortcut path is not accessible; click again
})

// 3. Enter director fullscreen via the ⛶ button.
const fsClicked = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('全屏') && !b.textContent.includes('退出'))
  if (btn) { btn.click(); return true }
  return false
})
await page.waitForTimeout(1500)
const fsState = await page.evaluate(() => ({
  fullscreen: !!document.fullscreenElement,
  fsElId: document.fullscreenElement?.id || document.fullscreenElement?.tagName || null,
  hostParent: document.getElementById('agent-chat-root')?.parentElement?.id || document.getElementById('agent-chat-root')?.parentElement?.tagName,
  panelVisible: (() => {
    const p = document.querySelector('[data-testid="agent-chat-panel"]')
    if (!p) return 'no panel'
    const r = p.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  })(),
}))
log('after entering fullscreen', { fsClicked, ...fsState })

// 4. In fullscreen: open the image viewer the same way the MCP tool does.
const viewerProbe = await page.evaluate(async () => {
  const reg = window.appServices?.registry ?? null
  // ServiceRegistry import path: use the global bridge if exposed
  let viewer = null
  try {
    const { ServiceRegistry, SERVICE_KEYS } = window.__serviceRegistryDebug ?? {}
    if (ServiceRegistry) viewer = ServiceRegistry.get(SERVICE_KEYS.IMAGE_VIEWER)
  } catch { /* ignore */ }
  if (!viewer && window.appServices?.features?.imageViewer) viewer = window.appServices.features.imageViewer
  if (!viewer) return { got: false, note: 'no viewer handle exposed; probing DOM only' }
  viewer.open('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==')
  await new Promise((r) => setTimeout(r, 300))
  const modal = document.querySelector('.fixed.inset-0.bg-black\\/90') || [...document.body.children].find((c) => c.className?.includes?.('z-[50000]'))
  const inFs = modal && document.fullscreenElement ? document.fullscreenElement.contains(modal) : null
  return { got: true, modalExists: !!modal, modalInsideFullscreenEl: inFs }
})
log('viewer probe (fullscreen)', viewerProbe)

await app.close()
