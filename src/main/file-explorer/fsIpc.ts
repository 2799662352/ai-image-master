import { ipcMain, dialog } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export const TEXT_READ_LIMIT = 10 * 1024 * 1024

export type FileNodeIpc = {
  path: string
  name: string
  kind: 'file' | 'dir'
  source: 'workspace' | 'attachments'
  childrenLoaded: false
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  js: 'text/javascript',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  jsx: 'text/javascript',
  html: 'text/html',
  css: 'text/css',
  py: 'text/x-python',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  sh: 'text/x-shellscript',
}

function mimeFromExt(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

export async function handleReadText(p: string): Promise<{ content: string; mtime: number }> {
  const stat = await fs.stat(p)
  if (!stat.isFile()) throw new Error(`${p} is not a file`)
  if (stat.size > TEXT_READ_LIMIT) throw new Error(`File too large for inline edit (${stat.size} bytes)`)
  const content = await fs.readFile(p, 'utf-8')
  return { content, mtime: stat.mtimeMs }
}

export async function handleWriteText(args: { path: string; content: string }): Promise<{ mtime: number }> {
  await fs.writeFile(args.path, args.content, 'utf-8')
  const stat = await fs.stat(args.path)
  return { mtime: stat.mtimeMs }
}

export async function handleListDir(p: string): Promise<FileNodeIpc[]> {
  const entries = await fs.readdir(p, { withFileTypes: true })
  return entries
    .filter((e) => e.name !== '.git')
    .map<FileNodeIpc>((e) => ({
      path: path.join(p, e.name),
      name: e.name,
      kind: e.isDirectory() ? 'dir' : 'file',
      source: 'workspace',
      childrenLoaded: false,
    }))
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
}

export async function handleStat(p: string): Promise<
  | { ok: true; size: number; mime: string; mtime: number }
  | { ok: false; reason: string }
> {
  try {
    const s = await fs.stat(p)
    if (!s.isFile()) return { ok: false, reason: 'not a file' }
    return { ok: true, size: s.size, mime: mimeFromExt(p), mtime: s.mtimeMs }
  } catch (err) {
    return { ok: false, reason: String(err) }
  }
}

export async function handlePickFolder(): Promise<string | null> {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
}

export function registerFsIpc(): void {
  ipcMain.handle('fs:read-text', (_e, p: string) => handleReadText(p))
  ipcMain.handle('fs:write-text', (_e, args: { path: string; content: string }) => handleWriteText(args))
  ipcMain.handle('fs:list-dir', (_e, p: string) => handleListDir(p))
  ipcMain.handle('fs:stat', (_e, p: string) => handleStat(p))
  ipcMain.handle('workspace:pick-folder', () => handlePickFolder())
}
