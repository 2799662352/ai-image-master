// Dev-only helper: screenshot (and optionally evaluate JS in) the running app's
// renderer over CDP, without agent-browser. Used when agent-browser's daemon
// wedges on Electron's devtools:// target.
//
//   node scripts/dev/cdp-shot.mjs <out.png> [js-expression]
//
// Picks the page target whose url contains "localhost:5173" (dev renderer).
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')

const [out = 'shot.png', expr] = process.argv.slice(2)
const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = targets.find((t) => t.type === 'page' && /localhost:5173/.test(t.url))
if (!page) {
  console.error('renderer target not found; targets:', targets.map((t) => t.url))
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw))
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
  }
})
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })

await new Promise((r) => ws.once('open', r))
if (expr) {
  const { result } = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  console.log(JSON.stringify(result.value, null, 2))
}
const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(out, Buffer.from(shot.data, 'base64'))
console.log('saved', out)
ws.close()
