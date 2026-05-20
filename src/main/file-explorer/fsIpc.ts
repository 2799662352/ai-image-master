import { app, ipcMain, dialog, shell } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

export const TEXT_READ_LIMIT = 10 * 1024 * 1024
const IMPORT_EXTERNAL_MAX_BYTES = 200 * 1024 * 1024

let allowedRoots: string[] | null = null

export function setFsAllowedRoots(roots: string[]): void {
  allowedRoots = roots.map((root) => path.resolve(root))
}

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
  avif: 'image/avif',
  ico: 'image/x-icon',
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogg: 'video/ogg',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  m4v: 'video/mp4',
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

function resolveAllowedRoots(): string[] {
  const roots = [...(allowedRoots ?? [])]
  if (typeof app?.getPath === 'function') {
    roots.push(path.resolve(app.getPath('userData'), 'agent', 'uploads'))
  }
  return roots
}

function hasTraversalSegment(p: string): boolean {
  return p.split(/[\\/]/).some((segment) => segment === '..')
}

async function realpathIfExists(p: string): Promise<string | undefined> {
  try {
    return await fs.realpath(p)
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return undefined
    throw err
  }
}

async function isInsideAllowedRoot(realTarget: string): Promise<boolean> {
  const realRoots = await Promise.all(resolveAllowedRoots().map((root) => realpathIfExists(root)))
  return realRoots.filter((root): root is string => typeof root === 'string').some((root) => {
    const rel = path.relative(root, realTarget)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  })
}

async function assertContained(p: string): Promise<void> {
  if (hasTraversalSegment(p)) {
    throw new Error('fs path outside allowed roots')
  }
  const realTarget = await realpathIfExists(p) ?? await realpathIfExists(path.dirname(p))
  if (!realTarget || !(await isInsideAllowedRoot(realTarget))) {
    throw new Error('fs path outside allowed roots')
  }
}

export async function handleReadText(p: string): Promise<{ content: string; mtime: number }> {
  await assertContained(p)
  const stat = await fs.stat(p)
  if (!stat.isFile()) throw new Error(`${p} is not a file`)
  if (stat.size > TEXT_READ_LIMIT) throw new Error(`File too large for inline edit (${stat.size} bytes)`)
  const content = await fs.readFile(p, 'utf-8')
  return { content, mtime: stat.mtimeMs }
}

export async function handleWriteText(args: { path: string; content: string }): Promise<{ mtime: number }> {
  await assertContained(args.path)
  await fs.writeFile(args.path, args.content, 'utf-8')
  const stat = await fs.stat(args.path)
  return { mtime: stat.mtimeMs }
}

export async function handleListDir(p: string): Promise<FileNodeIpc[]> {
  await assertContained(p)
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
    await assertContained(p)
    const s = await fs.stat(p)
    if (!s.isFile()) return { ok: false, reason: 'not a file' }
    return { ok: true, size: s.size, mime: mimeFromExt(p), mtime: s.mtimeMs }
  } catch (err) {
    return { ok: false, reason: String(err) }
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err
}

export async function handlePickFolder(): Promise<string | null> {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
}

export async function handleTrash(p: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await assertContained(p)
    await shell.trashItem(p)
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: String(err) }
  }
}

export async function handleRename(args: { oldPath: string; newName: string }): Promise<
  | { ok: true; newPath: string }
  | { ok: false; reason: string }
> {
  try {
    await assertContained(args.oldPath)
    if (!args.newName || /[\\/:*?"<>|]/.test(args.newName) || args.newName === '.' || args.newName === '..') {
      return { ok: false, reason: 'invalid file name' }
    }
    const dir = path.dirname(args.oldPath)
    const newPath = path.join(dir, args.newName)
    await assertContained(newPath)
    try {
      await fs.access(newPath)
      return { ok: false, reason: 'target already exists' }
    } catch {
      // good — target does not exist
    }
    await fs.rename(args.oldPath, newPath)
    return { ok: true, newPath }
  } catch (err) {
    return { ok: false, reason: String(err) }
  }
}

function isValidName(n: string): boolean {
  return !!n && !/[\\/:*?"<>|]/.test(n) && n !== '.' && n !== '..' && !n.endsWith('.')
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

// 自动生成不冲突的名字: foo.txt → foo copy.txt → foo copy 2.txt → ... (与 VSCode 一致)
async function uniquePath(dir: string, name: string): Promise<string> {
  const ext = path.extname(name)
  const base = ext ? name.slice(0, -ext.length) : name
  let candidate = path.join(dir, name)
  if (!(await pathExists(candidate))) return candidate
  candidate = path.join(dir, `${base} copy${ext}`)
  if (!(await pathExists(candidate))) return candidate
  for (let i = 2; i < 10000; i += 1) {
    candidate = path.join(dir, `${base} copy ${i}${ext}`)
    if (!(await pathExists(candidate))) return candidate
  }
  throw new Error('cannot allocate unique name')
}

export async function handleCreateFile(args: { parentDir: string; name: string }): Promise<
  | { ok: true; path: string }
  | { ok: false; reason: string }
> {
  try {
    await assertContained(args.parentDir)
    if (!isValidName(args.name)) return { ok: false, reason: 'invalid file name' }
    const target = await uniquePath(args.parentDir, args.name)
    await assertContained(target)
    await fs.writeFile(target, '', { flag: 'wx' })
    return { ok: true, path: target }
  } catch (err) {
    return { ok: false, reason: String(err) }
  }
}

export async function handleCreateFolder(args: { parentDir: string; name: string }): Promise<
  | { ok: true; path: string }
  | { ok: false; reason: string }
> {
  try {
    await assertContained(args.parentDir)
    if (!isValidName(args.name)) return { ok: false, reason: 'invalid folder name' }
    const target = await uniquePath(args.parentDir, args.name)
    await assertContained(target)
    await fs.mkdir(target)
    return { ok: true, path: target }
  } catch (err) {
    return { ok: false, reason: String(err) }
  }
}

async function copyOne(src: string, destDir: string): Promise<string> {
  const baseName = path.basename(src)
  const target = await uniquePath(destDir, baseName)
  await assertContained(target)
  await fs.cp(src, target, { recursive: true, errorOnExist: false })
  return target
}

export async function handleCopy(args: { sources: string[]; destDir: string }): Promise<
  | { ok: true; written: string[] }
  | { ok: false; reason: string }
> {
  try {
    await assertContained(args.destDir)
    const dest = await fs.stat(args.destDir).catch(() => null)
    if (!dest || !dest.isDirectory()) return { ok: false, reason: 'destination not a directory' }
    const written: string[] = []
    for (const src of args.sources) {
      await assertContained(src)
      // 防止把目录复制进自己
      const srcStat = await fs.stat(src).catch(() => null)
      if (srcStat?.isDirectory()) {
        const rel = path.relative(src, args.destDir)
        if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
          return { ok: false, reason: 'cannot copy a folder into itself' }
        }
      }
      written.push(await copyOne(src, args.destDir))
    }
    return { ok: true, written }
  } catch (err) {
    return { ok: false, reason: String(err) }
  }
}

export async function handleMove(args: { sources: string[]; destDir: string }): Promise<
  | { ok: true; written: string[] }
  | { ok: false; reason: string }
> {
  try {
    await assertContained(args.destDir)
    const dest = await fs.stat(args.destDir).catch(() => null)
    if (!dest || !dest.isDirectory()) return { ok: false, reason: 'destination not a directory' }
    const written: string[] = []
    for (const src of args.sources) {
      await assertContained(src)
      if (path.dirname(src) === args.destDir) {
        // 同目录直接 no-op
        written.push(src)
        continue
      }
      const srcStat = await fs.stat(src).catch(() => null)
      if (srcStat?.isDirectory()) {
        const rel = path.relative(src, args.destDir)
        if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
          return { ok: false, reason: 'cannot move a folder into itself' }
        }
      }
      const baseName = path.basename(src)
      const target = await uniquePath(args.destDir, baseName)
      await assertContained(target)
      try {
        await fs.rename(src, target)
      } catch (err) {
        // 跨盘 EXDEV → 退化为 cp + rm
        if (isNodeError(err) && err.code === 'EXDEV') {
          await fs.cp(src, target, { recursive: true })
          await fs.rm(src, { recursive: true, force: true })
        } else {
          throw err
        }
      }
      written.push(target)
    }
    return { ok: true, written }
  } catch (err) {
    return { ok: false, reason: String(err) }
  }
}

export async function handleOpenInTerminal(p: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await assertContained(p)
    const stat = await fs.stat(p)
    const dir = stat.isDirectory() ? p : path.dirname(p)
    const platform = process.platform
    if (platform === 'win32') {
      // Windows Terminal 优先, 兜底 cmd.exe
      const child = spawn('wt.exe', ['-d', dir], { detached: true, stdio: 'ignore' })
      child.on('error', () => {
        spawn('cmd.exe', ['/K', `cd /d "${dir}"`], { detached: true, stdio: 'ignore' }).unref()
      })
      child.unref()
    } else if (platform === 'darwin') {
      spawn('open', ['-a', 'Terminal', dir], { detached: true, stdio: 'ignore' }).unref()
    } else {
      // Linux: 尝试 x-terminal-emulator
      spawn('x-terminal-emulator', [], { cwd: dir, detached: true, stdio: 'ignore' }).unref()
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: String(err) }
  }
}

export async function handleReadBinary(p: string): Promise<
  | { ok: true; base64: string; mime: string }
  | { ok: false; reason: string }
> {
  try {
    await assertContained(p)
    const s = await fs.stat(p)
    if (!s.isFile()) return { ok: false, reason: 'not a file' }
    const buf = await fs.readFile(p)
    return { ok: true, base64: buf.toString('base64'), mime: mimeFromExt(p) }
  } catch (err) {
    return { ok: false, reason: String(err) }
  }
}

/**
 * Copy files from arbitrary OS paths (e.g. Desktop) into a workspace
 * directory. Unlike `handleCopy`, this does NOT sandbox-validate sources —
 * the user has explicitly drag-dropped them, so we trust the path. We still
 * gate on:
 *   - destDir must be inside an allowed root (workspace),
 *   - each source must be an actual file (no directories — v0 reject),
 *   - each source must be ≤ 200 MB,
 *   - name conflicts get the same VSCode-style ` copy` / ` copy 2` suffix
 *     used by handleCopy / handleCreateFile.
 *
 * Failure is fail-fast: the first src that fails stops the loop and we
 * return its reason. `written` lists the paths that succeeded before that
 * failure (so the UI can still refresh those rows).
 */
export async function handleImportExternal(args: { sources: string[]; destDir: string }): Promise<
  | { ok: true; written: string[] }
  | { ok: false; reason: string; written?: string[] }
> {
  try {
    await assertContained(args.destDir)
    const dest = await fs.stat(args.destDir).catch(() => null)
    if (!dest || !dest.isDirectory()) return { ok: false, reason: 'destination not a directory' }

    const written: string[] = []
    for (const src of args.sources) {
      // NOTE: no assertContained(src) — external OS paths are by design
      // outside allowed roots. The drag-drop UX is the user-consent surface.
      const srcStat = await fs.stat(src).catch(() => null)
      if (!srcStat) {
        return { ok: false, reason: 'unreadable', written }
      }
      if (srcStat.isDirectory()) {
        return { ok: false, reason: 'is_dir', written }
      }
      if (srcStat.size > IMPORT_EXTERNAL_MAX_BYTES) {
        return { ok: false, reason: 'oversize', written }
      }
      const baseName = path.basename(src)
      const target = await uniquePath(args.destDir, baseName)
      await assertContained(target)
      await fs.cp(src, target, { recursive: false, errorOnExist: false })
      written.push(target)
    }
    return { ok: true, written }
  } catch (err) {
    return { ok: false, reason: String(err) }
  }
}

export function registerFsIpc(): void {
  ipcMain.handle('fs:read-text', (_e, p: string) => handleReadText(p))
  ipcMain.handle('fs:write-text', (_e, args: { path: string; content: string }) => handleWriteText(args))
  ipcMain.handle('fs:list-dir', (_e, p: string) => handleListDir(p))
  ipcMain.handle('fs:stat', (_e, p: string) => handleStat(p))
  ipcMain.handle('fs:read-binary', (_e, p: string) => handleReadBinary(p))
  ipcMain.handle('fs:trash', (_e, p: string) => handleTrash(p))
  ipcMain.handle('fs:rename', (_e, args: { oldPath: string; newName: string }) => handleRename(args))
  ipcMain.handle('fs:create-file', (_e, args: { parentDir: string; name: string }) => handleCreateFile(args))
  ipcMain.handle('fs:create-folder', (_e, args: { parentDir: string; name: string }) => handleCreateFolder(args))
  ipcMain.handle('fs:copy', (_e, args: { sources: string[]; destDir: string }) => handleCopy(args))
  ipcMain.handle('fs:import-external', (_e, args: { sources: string[]; destDir: string }) =>
    handleImportExternal(args))
  ipcMain.handle('fs:move', (_e, args: { sources: string[]; destDir: string }) => handleMove(args))
  ipcMain.handle('fs:open-in-terminal', (_e, p: string) => handleOpenInTerminal(p))
  ipcMain.handle('workspace:pick-folder', () => handlePickFolder())
}
