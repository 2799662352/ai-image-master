// Offline probe: ask the bundled codex app-server for its native model metadata
// (model/list) so we can compare context windows against our UI catalog.
// No API key needed — initialize + model/list read local metadata only.
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const BIN = path.resolve('resources/codex/win32-x64/codex.exe')

const codexHome = await mkdtemp(path.join(tmpdir(), 'codex-meta-'))
await writeFile(path.join(codexHome, 'config.toml'), '')

const child = spawn(BIN, ['app-server'], {
  env: { ...process.env, CODEX_HOME: codexHome },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let buf = ''
const pending = new Map()
let nextId = 1

function rpc(method, params = {}) {
  const id = nextId++
  const p = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`timeout: ${method}`))
      }
    }, 15000)
  })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  return p
}

child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8')
  let idx
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result)
    }
  }
})
child.stderr.on('data', (c) => process.stderr.write('[stderr] ' + c.toString()))

try {
  const init = await rpc('initialize', {
    clientInfo: { name: 'meta-probe', title: 'meta-probe', version: '0.0.1' },
    capabilities: { experimentalApi: true },
  })
  console.log('[init ok]', JSON.stringify(init).slice(0, 200))
  const models = await rpc('model/list', {})
  console.log(JSON.stringify(models, null, 2))
} catch (err) {
  console.error('[probe failed]', err.message)
  process.exitCode = 1
} finally {
  child.kill()
  await rm(codexHome, { recursive: true, force: true }).catch(() => {})
}
