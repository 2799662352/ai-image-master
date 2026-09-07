// 「导出工程」确认页:剧名·段·镜·素材(待上传数)/ 保存位置 + 更改… / 一句说明 /
// 取消·导出。导出中显示上传进度;失败留在页上给原因可重试;成功态给
// 「在文件夹中显示」—— 用户得知道文件去了哪。

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { collectExportTargets } from '../../features/video-workbench/projectFile'
import { runProjectExport, type ExportApi } from '../../features/video-workbench/exportProject'
import { useVideoWorkbenchStore } from '../../features/video-workbench/store'

interface ProjectFileBridge {
  defaultPath: (name: string) => Promise<{ path: string; appVersion?: string }>
  pickSavePath: (defaultPath: string) => Promise<{ path: string | null }>
  write: ExportApi['write']
}

interface ExportBridge {
  videoWorkbench?: { projectFile?: ProjectFileBridge }
  attachments?: { resolveRefMedia?: ExportApi['resolveRefMedia'] }
  cos?: {
    uploadImageHistory?: (
      base64: string,
      mimeType: string,
    ) => Promise<{ success: true; url: string } | { success: false; error: string }>
  }
  shell?: { showItemInFolder?: (p: string) => void }
}

function bridge(): ExportBridge | undefined {
  return (window as Window & { electronAPI?: ExportBridge }).electronAPI
}

/** `data:<mime>;base64,<payload>` → COS https(经既有的图片直传通道)。 */
async function uploadDataUrl(dataUrl: string): Promise<string | null> {
  const upload = bridge()?.cos?.uploadImageHistory
  const m = /^data:([^;,]+);base64,(.*)$/is.exec(dataUrl)
  if (!upload || !m) return null
  const r = await upload(m[2], m[1])
  return r.success ? r.url : null
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'running'; done: number; total: number }
  | { kind: 'failed'; reason: string; missing: string[] }
  | { kind: 'done'; path: string; skipped: string[] }

export function ExportProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const project = useVideoWorkbenchStore((s) => s.projects.find((p) => p.id === s.activeProjectId))
  const boards = useVideoWorkbenchStore((s) => s.boards)
  const cards = useVideoWorkbenchStore((s) => s.cards)
  const [path, setPath] = useState<string>('')
  const [appVersion, setAppVersion] = useState<string>('')
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })

  const api = bridge()
  const own = boards.filter((b) => b.projectId === project?.id)
  const targets = collectExportTargets(own, cards)

  useEffect(() => {
    if (!open || !project) return
    setPhase({ kind: 'idle' })
    let cancelled = false
    const pf = bridge()?.videoWorkbench?.projectFile
    if (!pf) {
      setPath('')
      return
    }
    void pf.defaultPath(project.name).then((r) => {
      if (cancelled) return
      setPath(r.path)
      setAppVersion(r.appVersion ?? '')
    })
    return () => {
      cancelled = true
    }
  }, [open, project?.id, project?.name])

  if (!open || !project) return null

  const pf = api?.videoWorkbench?.projectFile
  const busy = phase.kind === 'running'

  const changePath = async () => {
    if (!pf) return
    const r = await pf.pickSavePath(path)
    if (r.path) setPath(r.path)
  }

  const run = async (skipMissing = false) => {
    if (!pf || !path) return
    setPhase({ kind: 'running', done: 0, total: targets.pending.length })
    const r = await runProjectExport({
      project,
      boards,
      cards,
      app: { name: 'CATIMATION-Cyberpunk Master', version: appVersion },
      path,
      api: {
        resolveRefMedia: api?.attachments?.resolveRefMedia,
        uploadDataUrl,
        write: (p, json) => pf.write(p, json),
      },
      onProgress: (done, total) => setPhase({ kind: 'running', done, total }),
      skipMissing,
    })
    setPhase(
      r.ok
        ? { kind: 'done', path: r.path, skipped: r.skipped }
        : { kind: 'failed', reason: r.reason, missing: r.missing },
    )
  }
  // 只有「缺失本地文件」这一种失败可以跳过;COS 不通之类的要么重试要么放弃。
  const onlyMissing = phase.kind === 'failed' && phase.missing.length > 0 && /本地文件已不存在/.test(phase.reason)

  // 挂到 body:工作台页根节点是 `relative z-10`,fixed 遮罩留在它里面会被顶部导航盖住。
  return createPortal(
    <div className="vw-palette-backdrop" onMouseDown={busy ? undefined : onClose}>
      <div className="vw-palette vw-dialog" role="dialog" aria-label="导出工程" onMouseDown={(e) => e.stopPropagation()}>
        <div className="vw-dialog-title">导出工程</div>
        <div className="vw-dialog-body">
          <div className="vw-dialog-line">
            <span className="text-white font-bold">{project.name}</span>
            <span className="text-[#a1a1aa]">
              {' '}· {targets.segments} 段 · {targets.cards} 镜 · {targets.materials} 个素材
              {targets.pending.length > 0 ? `(其中 ${targets.pending.length} 个待上传)` : ''}
            </span>
          </div>
          {phase.kind !== 'done' && (
            <div className="vw-dialog-field">
              <div className="vw-dialog-label">保存位置</div>
              <div className="flex items-center gap-2 min-w-0">
                <span className="vw-dialog-path" title={path}>{path || (pf ? '…' : '当前环境不支持写文件')}</span>
                <button type="button" className="vw-ghost shrink-0" onClick={changePath} disabled={!pf || busy}>
                  更改…
                </button>
              </div>
            </div>
          )}
          <p className="vw-dialog-note">素材和成片以云端地址保存;文件包含全部提示词。</p>
          {phase.kind === 'running' && (
            <p className="vw-dialog-note" role="status">
              {phase.total > 0 ? `正在上传 ${phase.total} 个素材…(${phase.done}/${phase.total})` : '正在写入…'}
            </p>
          )}
          {phase.kind === 'failed' && (
            <p className="vw-dialog-error" role="alert">
              {onlyMissing ? '有素材找不到:' : '导出失败:'}{phase.reason}
              {onlyMissing && (
                <span className="block mt-1 text-[#a1a1aa]">
                  {phase.missing.length > 3 && `全部缺失:${phase.missing.join('、')}。`}
                  挂上原来的盘后「重试导出」;或者「跳过缺失素材并导出」—— 这些素材会从对应卡片上去掉,其余原样。没写出任何文件。
                </span>
              )}
              {!onlyMissing && /\bSTS\b|中转服务器|fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT/i.test(phase.reason) && (
                <span className="block mt-1 text-[#a1a1aa]">
                  这是上传服务器连不上,不是文件的问题:检查网络 / 代理后「重试导出」;没写出任何文件。
                </span>
              )}
            </p>
          )}
          {phase.kind === 'done' && (
            <p className="vw-dialog-ok" role="status">
              已导出到 <span className="vw-dialog-path" title={phase.path}>{phase.path}</span>
              {phase.skipped.length > 0 && (
                <span className="block text-[#a1a1aa]" title={phase.skipped.join('\n')}>
                  已跳过 {phase.skipped.length} 个找不到的素材
                </span>
              )}
            </p>
          )}
        </div>
        <div className="vw-dialog-actions">
          {phase.kind === 'done' ? (
            <>
              <button
                type="button"
                className="vw-ghost"
                onClick={() => api?.shell?.showItemInFolder?.(phase.path)}
              >
                在文件夹中显示
              </button>
              <button type="button" className="vw-primary" onClick={onClose}>完成</button>
            </>
          ) : (
            <>
              <button type="button" className="vw-ghost" onClick={onClose} disabled={busy}>取消</button>
              {onlyMissing && (
                <button type="button" className="vw-ghost" onClick={() => void run(true)} disabled={!pf || !path || busy}>
                  跳过缺失素材并导出
                </button>
              )}
              <button type="button" className="vw-primary" onClick={() => void run(false)} disabled={!pf || !path || busy}>
                {phase.kind === 'failed' ? '重试导出' : '导出'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
