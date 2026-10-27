// 导入编排:读文件(主进程,带 50 MB 闸)→ 加固解析 → 摘要给确认页。
// 真正写 store 由 importProject 动作做;这里不碰 store,测试直接喂 mock api。

import { parseProjectFile, type ProjectFileSummary, type WorkbenchProjectFile } from './projectFile'

export interface ImportApi {
  read: (path: string) => Promise<
    | { ok: true; path: string; text: string }
    | { ok: false; code: string; reason: string }
  >
}

export type LoadProjectFileResult =
  | { ok: true; path: string; file: WorkbenchProjectFile; summary: ProjectFileSummary }
  | { ok: false; path: string; code: string; reason: string }

export async function loadProjectFile(path: string, api: ImportApi): Promise<LoadProjectFileResult> {
  const read = await api.read(path)
  if (!read.ok) return { ok: false, path, code: read.code, reason: read.reason }
  const parsed = parseProjectFile(read.text)
  if (!parsed.ok) return { ok: false, path, code: parsed.code, reason: parsed.reason }
  return { ok: true, path, file: parsed.file, summary: parsed.summary }
}

/** 拖进剧栏的文件里挑出工程文件(只认后缀)。 */
export function isProjectFileName(name: string): boolean {
  return name.toLowerCase().endsWith('.catwb.json')
}
