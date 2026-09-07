// 视频工作台工程文件 `*.catwb.json` 的主进程侧:只做文件 IO。
//
// 解析与校验在渲染端(features/video-workbench/projectFile.ts,纯函数、有单测),
// 这里不复写第二份;主进程守的是文件系统那一层:默认路径、保存/打开对话框、
// **原子写**(临时文件 + rename,崩溃不留半个文件)、带体积闸的读。
//
// 照 canvasCheckpointIpc 的形状:纯函数可测,registerProjectFileIpc 只做接线。

import { app, dialog, ipcMain, type BrowserWindow } from 'electron'
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export const PROJECT_FILE_EXT = '.catwb.json'
/** 与渲染端 PROJECT_FILE_MAX_BYTES 同值:URL 方案下正常文件几十 KB,这只防误选。 */
export const PROJECT_FILE_IO_MAX_BYTES = 50 * 1024 * 1024
export const PROJECT_FILE_DIR_NAME = 'CATIMATION 工程'

const DIALOG_FILTERS = [{ name: 'CATIMATION 工程', extensions: ['catwb.json'] }]

/** 剧名 → 文件名:去掉文件系统不接受的字符与控制字符,空名回退,截 80 字符。 */
export function safeProjectFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .replace(/^\.+$/, '')
  const base = (cleaned || '工程').slice(0, 80)
  return `${base}${PROJECT_FILE_EXT}`
}

export function defaultProjectFilePath(documentsDir: string, projectName: string): string {
  return path.join(documentsDir, PROJECT_FILE_DIR_NAME, safeProjectFileName(projectName))
}

function isProjectFilePath(p: string): boolean {
  return p.toLowerCase().endsWith(PROJECT_FILE_EXT)
}

export type WriteProjectFileResult = { ok: true; path: string } | { ok: false; reason: string }

interface WriteDeps {
  rename?: (from: string, to: string) => Promise<void>
}

/**
 * 先写同目录临时文件再 rename:rename 在同一卷上是原子的,写到一半崩溃只会留下
 * 一个临时文件而不是半份工程;rename 失败则把临时文件收走,目标位置什么都不留。
 */
export async function writeProjectFileAtomic(
  fullPath: string,
  json: string,
  deps: WriteDeps = {},
): Promise<WriteProjectFileResult> {
  if (!isProjectFilePath(fullPath)) return { ok: false, reason: `文件名必须以 ${PROJECT_FILE_EXT} 结尾` }
  if (Buffer.byteLength(json, 'utf8') > PROJECT_FILE_IO_MAX_BYTES) {
    return { ok: false, reason: '工程文件超过 50 MB,拒绝写入' }
  }
  const dir = path.dirname(fullPath)
  const tmpPath = path.join(dir, `.${path.basename(fullPath)}.tmp-${randomBytes(6).toString('hex')}`)
  const rename = deps.rename ?? ((from, to) => fs.rename(from, to))
  try {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(tmpPath, json, 'utf8')
    await rename(tmpPath, fullPath)
    return { ok: true, path: fullPath }
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => undefined)
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

export type ReadProjectFileResult =
  | { ok: true; path: string; text: string }
  | { ok: false; code: 'not-found' | 'not-project-file' | 'too-large' | 'io'; reason: string }

/** 先 stat 看体积再读:超闸的文件一个字节都不读进内存。 */
export async function readProjectFileText(
  fullPath: string,
  maxBytes = PROJECT_FILE_IO_MAX_BYTES,
): Promise<ReadProjectFileResult> {
  if (!isProjectFilePath(fullPath)) {
    return { ok: false, code: 'not-project-file', reason: `只接受 ${PROJECT_FILE_EXT} 文件` }
  }
  try {
    const st = await fs.stat(fullPath)
    if (st.size > maxBytes) {
      return { ok: false, code: 'too-large', reason: '文件超过 50 MB,不像是工程文件' }
    }
    const text = await fs.readFile(fullPath, 'utf8')
    return { ok: true, path: fullPath, text }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return { ok: false, code: 'not-found', reason: '文件不存在' }
    return { ok: false, code: 'io', reason: err instanceof Error ? err.message : String(err) }
  }
}

export function registerProjectFileIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.removeHandler('video-workbench:project-default-path')
  ipcMain.handle('video-workbench:project-default-path', async (_e, args: { name?: unknown }) => {
    const name = typeof args?.name === 'string' ? args.name : ''
    return { path: defaultProjectFilePath(app.getPath('documents'), name) }
  })

  ipcMain.removeHandler('video-workbench:project-pick-save-path')
  ipcMain.handle('video-workbench:project-pick-save-path', async (_e, args: { defaultPath?: unknown }) => {
    const defaultPath = typeof args?.defaultPath === 'string' ? args.defaultPath : undefined
    const win = getWindow()
    const opts = { title: '导出工程', defaultPath, filters: DIALOG_FILTERS }
    const result = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (result.canceled || !result.filePath) return { path: null }
    const chosen = isProjectFilePath(result.filePath) ? result.filePath : `${result.filePath}${PROJECT_FILE_EXT}`
    return { path: chosen }
  })

  ipcMain.removeHandler('video-workbench:project-write')
  ipcMain.handle('video-workbench:project-write', async (_e, args: { path?: unknown; json?: unknown }) => {
    const target = typeof args?.path === 'string' ? args.path : ''
    const json = typeof args?.json === 'string' ? args.json : ''
    if (!target || !json) return { ok: false, reason: 'project-write requires path and json' }
    return writeProjectFileAtomic(target, json)
  })

  ipcMain.removeHandler('video-workbench:project-pick-open')
  ipcMain.handle('video-workbench:project-pick-open', async () => {
    const win = getWindow()
    const opts = { title: '导入工程', properties: ['openFile' as const], filters: DIALOG_FILTERS }
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (result.canceled || result.filePaths.length === 0) return { path: null }
    return { path: result.filePaths[0] }
  })

  ipcMain.removeHandler('video-workbench:project-read')
  ipcMain.handle('video-workbench:project-read', async (_e, args: { path?: unknown }) => {
    const target = typeof args?.path === 'string' ? args.path : ''
    if (!target) return { ok: false, code: 'io', reason: 'project-read requires path' }
    return readProjectFileText(target)
  })
}
