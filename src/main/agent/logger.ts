import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

export function createAgentLogStream(name: string): fs.WriteStream {
  const dir = path.join(app.getPath('userData'), 'logs')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${name}-${new Date().toISOString().slice(0, 10)}.log`)
  return fs.createWriteStream(file, { flags: 'a' })
}
