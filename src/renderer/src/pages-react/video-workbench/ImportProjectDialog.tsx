// 「导入工程」确认页:剧名(可改,重名自动加「(2)」)/ N 段·M 镜·K 素材 /
// 导出时间与客户端版本 / 不兼容时红字原因且不能导入 / 取消·导入为新剧。
// 文件由调用方选好(系统对话框或拖到剧栏),这里只负责读、校验、确认、写 store。

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useToastStore } from '../../stores/useToastStore'
import { loadProjectFile, type ImportApi, type LoadProjectFileResult } from '../../features/video-workbench/importProject'
import { planImport, uniqueProjectName } from '../../features/video-workbench/projectFile'
import { useVideoWorkbenchStore } from '../../features/video-workbench/store'

function bridge(): { videoWorkbench?: { projectFile?: ImportApi } } | undefined {
  return (window as Window & { electronAPI?: { videoWorkbench?: { projectFile?: ImportApi } } }).electronAPI
}

function formatExportedAt(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export interface ImportProjectDialogProps {
  /** 要导入的文件路径;null = 关闭。 */
  path: string | null
  onClose: () => void
}

export function ImportProjectDialog({ path, onClose }: ImportProjectDialogProps) {
  const projects = useVideoWorkbenchStore((s) => s.projects)
  const importProject = useVideoWorkbenchStore((s) => s.importProject)
  const [loaded, setLoaded] = useState<LoadProjectFileResult | null>(null)
  const [name, setName] = useState('')

  useEffect(() => {
    if (!path) return
    setLoaded(null)
    let cancelled = false
    const api = bridge()?.videoWorkbench?.projectFile
    if (!api) {
      setLoaded({ ok: false, path, code: 'io', reason: '当前环境不支持读文件' })
      return
    }
    void loadProjectFile(path, api).then((r) => {
      if (cancelled) return
      setLoaded(r)
      if (r.ok) setName(uniqueProjectName(r.file.project.name, useVideoWorkbenchStore.getState().projects.map((p) => p.name)))
    })
    return () => {
      cancelled = true
    }
    // projects 不进依赖:去重只在文件刚读出来时算一次,用户改名后不该被覆盖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  if (!path) return null

  const fileName = path.split(/[\\/]/).pop() ?? path
  const canImport = loaded?.ok === true && name.trim().length > 0
  const nameTaken = loaded?.ok === true && projects.some((p) => p.name === name.trim())

  const run = () => {
    if (!loaded?.ok) return
    const finalName = uniqueProjectName(name, projects.map((p) => p.name))
    importProject(planImport(loaded.file), finalName, loaded.file.project.summary)
    useToastStore.getState().addToast({
      type: 'success',
      message: `已导入「${finalName}」· ${loaded.summary.segments} 段 ${loaded.summary.cards} 镜`,
    })
    onClose()
  }

  // 挂到 body:工作台页根节点是 `relative z-10`,fixed 遮罩留在它里面会被顶部导航盖住。
  return createPortal(
    <div className="vw-palette-backdrop" onMouseDown={onClose}>
      <div className="vw-palette vw-dialog" role="dialog" aria-label="导入工程" onMouseDown={(e) => e.stopPropagation()}>
        <div className="vw-dialog-title">导入工程</div>
        <div className="vw-dialog-body">
          <div className="vw-dialog-line">
            <span className="vw-dialog-path" title={path}>{fileName}</span>
          </div>
          {loaded === null && <p className="vw-dialog-note" role="status">正在读取…</p>}
          {loaded && !loaded.ok && (
            <p className="vw-dialog-error" role="alert">
              {loaded.code === 'version' ? loaded.reason : `无法导入:${loaded.reason}`}
            </p>
          )}
          {loaded?.ok && (
            <>
              <div className="vw-dialog-field">
                <label className="vw-dialog-label" htmlFor="vw-import-name">导入为新剧,剧名</label>
                <input
                  id="vw-import-name"
                  className="vw-dialog-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && canImport) run()
                  }}
                />
                {nameTaken && <span className="vw-dialog-note">已有同名剧,导入时会自动加「(2)」</span>}
              </div>
              <div className="vw-dialog-line text-[#a1a1aa]">
                {loaded.summary.segments} 段 · {loaded.summary.cards} 镜 · {loaded.summary.materials} 个素材
              </div>
              <p className="vw-dialog-note">
                导出于 {formatExportedAt(loaded.summary.exportedAt)} · 客户端 {loaded.summary.appVersion || '未知'}
                ;素材与成片按云端地址引用,排队/生成中的卡片会重置为待生成。
              </p>
            </>
          )}
        </div>
        <div className="vw-dialog-actions">
          <button type="button" className="vw-ghost" onClick={onClose}>取消</button>
          <button type="button" className="vw-primary" onClick={run} disabled={!canImport}>导入为新剧</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
