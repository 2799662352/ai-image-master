// 「任务详情」面板:一张卡的标识 / 时间 / 结果 / 请求参数 / 历史版本。
//
// 数据全部来自 `buildTaskDetail`(纯函数,见那边文件头的三条纪律),这里只负责摆:
// 上游任务号那一行加粗高亮 —— 用户来这一页十有八九就是为了拿它去找供应商;
// 每个 ID / 地址旁一个「复制」,底部一个「复制全部(JSON)」给工单 / 聊天用。
//
// 展示哪一版由卡片决定(`versionIdx` / `onSelectVersion` 受控):卡片上切到 v1,
// 面板打开就是 v1 那一轮的任务号与参数;面板里「历史版本」每行的「查看」也切的是
// 卡片那份状态,关掉面板后卡片播放的仍是刚看的那一版。这里刻意不另存一份
// 「面板自己选的版本」再去同步 —— 两份状态迟早对不上。

import { useEffect, useMemo, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import type { VideoWorkbenchCard } from '../../../../types/videoWorkbench'
import { buildTaskDetail, type TaskDetailField } from '../../features/video-workbench/taskDetail'

interface ShellBridge {
  shell?: { showItemInFolder?: (p: string) => unknown }
}

function shell(): ShellBridge['shell'] {
  return (window as Window & { electronAPI?: ShellBridge }).electronAPI?.shell
}

const COPIED_MS = 1200

function isTerminal(status: VideoWorkbenchCard['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled'
}

export function TaskDetailDialog({
  card,
  index,
  versionIdx,
  onSelectVersion,
  onClose,
}: {
  card: VideoWorkbenchCard
  index: number
  /** 卡片当前展示的版本下标(`card.versions`);省略 = 最新一版。 */
  versionIdx?: number
  /** 「历史版本」行的「查看」:把卡片切到那一版。省略则不给按钮。 */
  onSelectVersion?: (versionIdx: number) => void
  onClose: () => void
}) {
  const [now, setNow] = useState(() => Date.now())
  const detail = useMemo(
    () => buildTaskDetail(card, { index, now, versionIdx }),
    [card, index, now, versionIdx],
  )
  const requestJson = useMemo(() => JSON.stringify(detail.request, null, 2), [detail.request])

  // 「已耗时」要走秒表:非终态每秒重算一次 now;终态用 updatedAt,不需要 tick。
  // 看的是历史版本时没有耗时行,也不 tick。
  const live = !detail.view.historical && !isTerminal(card.status)
  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live])

  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  useEffect(() => {
    if (copiedKey === null) return
    const timer = setTimeout(() => setCopiedKey(null), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copiedKey])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const copy = (key: string, text: string): void => {
    void navigator.clipboard?.writeText(text)
    setCopiedKey(key)
  }

  const renderField = (field: TaskDetailField): JSX.Element => {
    const hero = field.key === 'upstreamTaskId'
    return (
      <div
        key={field.key}
        data-testid={`vw-detail-${field.key}`}
        className={['vw-detail-row', hero ? 'vw-detail-hero' : ''].join(' ')}
      >
        <div className="vw-detail-label">{field.label}</div>
        <div className="min-w-0">
          <div className={['vw-detail-value', field.missing ? 'vw-detail-value-missing' : ''].join(' ')}>{field.value}</div>
          {field.hint && <div className="vw-detail-hint">{field.hint}</div>}
        </div>
        <div className="vw-detail-actions">
          {field.copy && !field.missing && (
            <button
              type="button"
              className="vw-detail-copy"
              aria-label={`复制 ${field.label}`}
              onClick={() => copy(field.key, field.value)}
            >
              {copiedKey === field.key ? '已复制' : '复制'}
            </button>
          )}
          {field.path && (
            <button type="button" className="vw-detail-copy" onClick={() => void shell()?.showItemInFolder?.(field.path!)}>
              在文件夹中显示
            </button>
          )}
          {field.versionIdx !== undefined && field.current && <span className="vw-detail-current">当前显示</span>}
          {field.versionIdx !== undefined && !field.current && onSelectVersion && (
            <button
              type="button"
              className="vw-detail-copy"
              aria-label={`查看 ${field.label}`}
              onClick={() => onSelectVersion(field.versionIdx!)}
            >
              查看
            </button>
          )}
        </div>
      </div>
    )
  }

  // 挂到 body:工作台页根节点是 `relative z-10`,fixed 遮罩留在它里面会被顶部导航盖住。
  return createPortal(
    <div className="vw-palette-backdrop" data-testid="vw-detail-backdrop" onMouseDown={onClose}>
      <div
        className="vw-palette vw-dialog vw-detail"
        role="dialog"
        aria-label={detail.title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="vw-dialog-title">{detail.title}</div>
        <div className="vw-dialog-body vw-detail-body">
          {detail.sections.map((section) => (
            <section key={section.key} className="vw-detail-section">
              <div className="vw-detail-section-title">{section.title}</div>
              {section.fields.map(renderField)}
            </section>
          ))}
          <section className="vw-detail-section">
            <div className="vw-detail-section-title flex items-center justify-between">
              <span>请求参数</span>
              <button type="button" className="vw-detail-copy" onClick={() => copy('request', requestJson)}>
                {copiedKey === 'request' ? '已复制' : '复制参数'}
              </button>
            </div>
            <pre className="vw-detail-json" data-testid="vw-detail-request">{requestJson}</pre>
          </section>
        </div>
        <div className="vw-dialog-actions">
          <button type="button" className="vw-ghost" onClick={() => copy('all', detail.json)}>
            {copiedKey === 'all' ? '已复制' : '复制全部(JSON)'}
          </button>
          <button type="button" className="vw-primary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
