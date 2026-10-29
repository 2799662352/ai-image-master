// 任务详情里的「效果问题反馈」:把一条已完成的 Seedance 2.x 任务的效果问题报给火山方舟
// Case 平台,并回看处理进度。网页版 sora-ui(#300 / #301)已有同一功能,这里是桌面端的对应物。
//
// 几条刻意的行为(与网页版一致,出处是网关 new-api #188 / #189 的契约):
//   1. **只在点击时才查**,不轮询。网关对「已处理」记录永久走本地缓存、对「处理中」45 秒内走本地缓存,
//      用户手点「刷新状态」就够了,后台轮询只会白占一个渠道额度。
//   2. **一个任务只能报一次**(上游限制)。报的时候被拒(`rejected`)先重查一次:多半是之前报过了,
//      这时候直接展示那条记录并说明,而不是丢一个看不懂的错误。
//   3. **受理 ≠ 立刻查得到**。受理后马上查可能还没同步,此时进入「已提交,等待同步」而不是报错。
//   4. 刷新失败**保留旧记录**并在上面提示,不要把已经看到的进度换成空白。
//   5. 上游给的附件只渲染 https 链接(主进程已过滤一遍,这里再挡一遍),`rel="noopener noreferrer"`。
//
// 凭据、基址、请求都在主进程(`main/services/videoBadcase`),渲染层只通过 preload 的
// `videoWorkbench.badcase` 取结果;这里不碰令牌。

import { useEffect, useRef, useState, type JSX } from 'react'
import {
  VIDEO_BADCASE_CONTACT_MAX_CHARS,
  VIDEO_BADCASE_FEEDBACK_MAX_CHARS,
  VIDEO_BADCASE_TYPES,
  type VideoBadcaseQueryResult,
  type VideoBadcaseRecord,
  type VideoBadcaseReportInput,
  type VideoBadcaseReportResult,
} from '../../../../types/videoBadcase'

interface BadcaseBridge {
  report: (input: VideoBadcaseReportInput) => Promise<VideoBadcaseReportResult>
  query: (taskId: string) => Promise<VideoBadcaseQueryResult>
}

function bridge(): BadcaseBridge | undefined {
  return (window as Window & { electronAPI?: { videoWorkbench?: { badcase?: BadcaseBridge } } }).electronAPI
    ?.videoWorkbench?.badcase
}

const UNSUPPORTED = '当前应用版本不支持效果反馈,请升级后重试。'
const UNKNOWN_FAILURE = '操作没有完成,请稍后重试。'
export const BADCASE_ALREADY_SUBMITTED_NOTICE = '该任务已提交过反馈,以下是处理进度。'
export const BADCASE_PENDING_NOTICE = '反馈已提交。处理进度需要一点时间同步,稍后点「刷新状态」查看。'

function failure(message: string): { ok: false; code: 'NETWORK'; message: string } {
  return { ok: false, code: 'NETWORK', message }
}

async function callQuery(taskId: string): Promise<VideoBadcaseQueryResult> {
  const b = bridge()
  if (!b) return failure(UNSUPPORTED)
  try {
    return await b.query(taskId)
  } catch {
    return failure(UNKNOWN_FAILURE)
  }
}

async function callReport(input: VideoBadcaseReportInput): Promise<VideoBadcaseReportResult> {
  const b = bridge()
  if (!b) return failure(UNSUPPORTED)
  try {
    return await b.report(input)
  } catch {
    return failure(UNKNOWN_FAILURE)
  }
}

/** 按字符(code point)数,与网关的 rune 口径一致;`.length` 会把 emoji 算成 2。 */
function charCount(text: string): number {
  return Array.from(text).length
}

function typeLabel(value: string): string {
  return VIDEO_BADCASE_TYPES.find((t) => t.value === value)?.label ?? value
}

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

function formatSubmitTime(raw: string): string {
  if (!raw) return '—'
  const ms = Date.parse(raw)
  if (Number.isNaN(ms)) return raw
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}

type View =
  | { kind: 'idle' }
  | { kind: 'loading'; label: string }
  | { kind: 'form' }
  | { kind: 'pending' }
  | { kind: 'record'; record: VideoBadcaseRecord }

function statusBadge(status: string): { text: string; cls: string } {
  if (status === 'processing') return { text: '处理中', cls: 'vw-bc-badge-processing' }
  if (status === 'done') return { text: '已处理', cls: 'vw-bc-badge-done' }
  return { text: status || '未知', cls: '' }
}

function RecordCard({ record }: { record: VideoBadcaseRecord }): JSX.Element {
  const badge = statusBadge(record.status)
  const attachments = (record.solution?.attachments ?? []).filter((a) => isHttps(a.url))
  return (
    <div data-testid="vw-bc-record">
      <div className="vw-bc-card">
        <div className="vw-bc-row">
          <div className="vw-bc-row-label">状态</div>
          <div className="vw-bc-row-value">
            <span className={['vw-bc-badge', badge.cls].join(' ')} data-testid="vw-bc-status">
              {badge.text}
            </span>
          </div>
        </div>
        <div className="vw-bc-row">
          <div className="vw-bc-row-label">问题类型</div>
          <div className="vw-bc-row-value">
            {record.badcaseTypes.length > 0 ? (
              record.badcaseTypes.map((t) => (
                <span key={t} className="vw-bc-tag">
                  {typeLabel(t)}
                </span>
              ))
            ) : (
              '—'
            )}
          </div>
        </div>
        {record.problemLabel && (
          <div className="vw-bc-row">
            <div className="vw-bc-row-label">问题标签</div>
            <div className="vw-bc-row-value">{record.problemLabel}</div>
          </div>
        )}
        <div className="vw-bc-row">
          <div className="vw-bc-row-label">反馈内容</div>
          <div className="vw-bc-row-value vw-bc-pre">{record.feedback || '—'}</div>
        </div>
        <div className="vw-bc-row">
          <div className="vw-bc-row-label">提交时间</div>
          <div className="vw-bc-row-value">{formatSubmitTime(record.submitTime)}</div>
        </div>
      </div>
      {record.solution && (
        <div className="vw-bc-solution" data-testid="vw-bc-solution">
          <div className="vw-bc-solution-title">处理方案</div>
          {record.solution.text && <div className="vw-bc-row-value vw-bc-pre">{record.solution.text}</div>}
          {attachments.length > 0 && (
            <div className="mt-2 flex flex-col gap-1">
              {attachments.map((a, i) => (
                <a key={`${a.url}-${i}`} className="vw-bc-link" href={a.url} target="_blank" rel="noopener noreferrer">
                  {a.name || a.url}
                </a>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function VideoBadcasePanel({ taskId }: { taskId: string }): JSX.Element {
  const [view, setView] = useState<View>({ kind: 'idle' })
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [types, setTypes] = useState<string[]>([])
  const [feedback, setFeedback] = useState('')
  const [contact, setContact] = useState('')

  // 卸载后(关面板 / 切版本)回包不再落状态。切 taskId 由调用方 `key={taskId}` 整个重建。
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])
  const inFlightRef = useRef(false)

  const feedbackChars = charCount(feedback)
  const contactChars = charCount(contact)
  const feedbackTooLong = feedbackChars > VIDEO_BADCASE_FEEDBACK_MAX_CHARS
  const contactTooLong = contactChars > VIDEO_BADCASE_CONTACT_MAX_CHARS
  const canSubmit = feedback.trim().length > 0 && !feedbackTooLong && !contactTooLong && !busy

  /** 首次点开:查有没有记录。有 → 展示;没有 → 出表单。 */
  const open = async (): Promise<void> => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    setError(null)
    setNotice(null)
    setView({ kind: 'loading', label: '正在查询反馈记录…' })
    const res = await callQuery(taskId)
    inFlightRef.current = false
    if (!aliveRef.current) return
    if (!res.ok) {
      setView({ kind: 'idle' })
      setError(res.message)
      return
    }
    if (res.record) {
      setView({ kind: 'record', record: res.record })
      return
    }
    // 40002 = 任务不存在 / 不在当前计费池:此时出表单只会再被拒一次,直接把原因给出来。
    if (res.rejection?.code === 40002) {
      setView({ kind: 'idle' })
      setError(res.rejection.message)
      return
    }
    setView({ kind: 'form' })
  }

  /** 「刷新状态」:失败保留旧记录。 */
  const refresh = async (): Promise<void> => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    setBusy(true)
    setError(null)
    setNotice(null)
    const res = await callQuery(taskId)
    inFlightRef.current = false
    if (!aliveRef.current) return
    setBusy(false)
    if (!res.ok) {
      setError(`刷新失败:${res.message}`)
      return
    }
    if (res.record) {
      setView({ kind: 'record', record: res.record })
      return
    }
    setNotice('暂未查到处理进度,请稍后再试。')
  }

  const submit = async (): Promise<void> => {
    if (!canSubmit || inFlightRef.current) return
    inFlightRef.current = true
    setBusy(true)
    setError(null)
    setNotice(null)
    const trimmedContact = contact.trim()
    const res = await callReport({
      taskId,
      feedback: feedback.trim(),
      badcaseTypes: types,
      ...(trimmedContact ? { contactInfo: trimmedContact } : {}),
    })
    if (!aliveRef.current) {
      inFlightRef.current = false
      return
    }

    if (!res.ok) {
      inFlightRef.current = false
      setBusy(false)
      setError(res.message)
      return
    }

    if (res.outcome === 'accepted') {
      // 立刻查一次:同步得快就直接看到记录,否则进「已提交,等待同步」。
      setView({ kind: 'loading', label: '反馈已提交,正在读取处理进度…' })
      const q = await callQuery(taskId)
      inFlightRef.current = false
      if (!aliveRef.current) return
      setBusy(false)
      if (q.ok && q.record) {
        setView({ kind: 'record', record: q.record })
        return
      }
      setView({ kind: 'pending' })
      setNotice(BADCASE_PENDING_NOTICE)
      if (!q.ok) setError(`读取处理进度失败:${q.message}`)
      return
    }

    // rejected:一个任务只能报一次,先看看是不是已经报过。
    const rejection = res.rejection
    const q = await callQuery(taskId)
    inFlightRef.current = false
    if (!aliveRef.current) return
    setBusy(false)
    if (q.ok && q.record) {
      setView({ kind: 'record', record: q.record })
      setNotice(BADCASE_ALREADY_SUBMITTED_NOTICE)
      return
    }
    setError(rejection.message || '反馈未被受理,请稍后重试。')
  }

  const toggleType = (value: string): void => {
    setTypes((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]))
  }

  return (
    <div data-testid="vw-bc-panel">
      {view.kind === 'idle' && (
        <div className="flex items-center justify-between gap-3">
          <div className="vw-bc-note">视频效果不符合预期(角色漂移、字幕错误、水印…)?可提交给火山方舟 Case 平台,并回看处理进度。</div>
          <button type="button" className="vw-bc-btn" onClick={() => void open()}>
            提交 / 查看反馈
          </button>
        </div>
      )}

      {view.kind === 'loading' && (
        <div className="vw-bc-note" role="status">
          {view.label}
        </div>
      )}

      {notice && (
        <div className="vw-bc-notice" role="status">
          {notice}
        </div>
      )}

      {view.kind === 'form' && (
        <div>
          <div className="vw-bc-note">一个任务只能提交一次反馈,提交后不能修改。</div>
          <div className="vw-bc-label">问题类型(可多选)</div>
          <div className="vw-bc-chips" role="group" aria-label="问题类型">
            {VIDEO_BADCASE_TYPES.map((t) => {
              const on = types.includes(t.value)
              return (
                <button
                  key={t.value}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  className={['vw-bc-chip', on ? 'vw-bc-chip-on' : ''].join(' ')}
                  disabled={busy}
                  onClick={() => toggleType(t.value)}
                >
                  {t.label}
                </button>
              )
            })}
          </div>

          <div className="vw-bc-label">
            问题描述<span className="vw-bc-req">*</span>
          </div>
          <textarea
            className="vw-bc-input vw-bc-textarea"
            aria-label="问题描述"
            placeholder="描述哪里不对:出现在第几秒、期望是什么样子。"
            value={feedback}
            disabled={busy}
            onChange={(e) => setFeedback(e.target.value)}
          />
          <div className="vw-bc-counter" style={feedbackTooLong ? { color: '#f87171' } : undefined}>
            {feedbackChars}/{VIDEO_BADCASE_FEEDBACK_MAX_CHARS}
          </div>

          <div className="vw-bc-label">联系方式(选填)</div>
          <input
            className="vw-bc-input"
            aria-label="联系方式"
            placeholder="邮箱 / 手机号 / 微信,方便平台回访"
            value={contact}
            disabled={busy}
            onChange={(e) => setContact(e.target.value)}
          />
          {contactTooLong && (
            <div className="vw-bc-counter" style={{ color: '#f87171' }}>
              {contactChars}/{VIDEO_BADCASE_CONTACT_MAX_CHARS}
            </div>
          )}

          <div className="mt-3 flex justify-end gap-2">
            <button type="button" className="vw-bc-btn" disabled={busy} onClick={() => setView({ kind: 'idle' })}>
              取消
            </button>
            <button type="button" className="vw-bc-btn vw-bc-btn-primary" disabled={!canSubmit} onClick={() => void submit()}>
              {busy ? '提交中…' : '提交反馈'}
            </button>
          </div>
        </div>
      )}

      {view.kind === 'pending' && (
        <div className="mt-2 flex justify-end">
          <button type="button" className="vw-bc-btn" disabled={busy} onClick={() => void refresh()}>
            {busy ? '刷新中…' : '刷新状态'}
          </button>
        </div>
      )}

      {view.kind === 'record' && (
        <div>
          <RecordCard record={view.record} />
          <div className="mt-2 flex justify-end">
            <button type="button" className="vw-bc-btn" disabled={busy} onClick={() => void refresh()}>
              {busy ? '刷新中…' : '刷新状态'}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="vw-bc-error" role="alert">
          {error}
        </div>
      )}
    </div>
  )
}
