// 4K 生成的二次确认弹窗。
//
// 4K 比 1080p 贵得多,而且提交后不能撤销(已开始的任务照样计费),所以要用户本人点两次:
//   第 1 步:看清要生成什么、风险是什么 →「继续(1/2)」
//   第 2 步:勾选「我已了解」→「确认生成 4K(2/2)」
// store 层默认拒绝 4K,只认这里第二步点击时带上的 `uhdConfirmed: true`;AI 的入口没有这个标记,
// 也没有任何办法点这个弹窗 —— 这就是「不开放权限给 AI 确认」的落点。
// 不用 window.confirm(jsdom 里被禁用),也不做超时自动确认:没人点就一直停在这里。

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useVideoWorkbenchStore } from '../../features/video-workbench/store'
import { useUhdConfirmStore } from '../../features/video-workbench/uhdConfirm'
import { useToastStore } from '../../stores/useToastStore'
import { MODEL_LABELS } from './WorkbenchCard'

/** 弹窗里最多逐张列几条,其余折成「另 N 张」,免得一整页 4K 把弹窗撑出屏幕。 */
const MAX_LISTED = 6

function snippet(prompt: string): string {
  const one = prompt.replace(/\s+/g, ' ').trim()
  if (!one) return '(提示词为空)'
  return one.length > 28 ? `${one.slice(0, 28)}…` : one
}

export function UhdConfirmDialog() {
  const request = useUhdConfirmStore((s) => s.request)
  const dismiss = useUhdConfirmStore((s) => s.dismiss)
  const cards = useVideoWorkbenchStore((s) => s.cards)
  const addToast = useToastStore((s) => s.addToast)

  const [step, setStep] = useState<1 | 2>(1)
  const [acknowledged, setAcknowledged] = useState(false)
  /** 防连点:第二步只会真正提交一次。 */
  const submitting = useRef(false)

  // 每次打开一个新请求都从第 1 步、未勾选开始 —— 上一次走到一半的状态不能带过来。
  useEffect(() => {
    setStep(1)
    setAcknowledged(false)
    submitting.current = false
  }, [request])

  useEffect(() => {
    if (!request) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') dismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [request, dismiss])

  if (!request) return null

  const isFinalize = request.kind === 'finalize'
  const held = request.cardIds
    .map((id) => cards.find((c) => c.id === id))
    .filter((c): c is NonNullable<typeof c> => Boolean(c))
  const count = held.length
  const kindLabel = isFinalize ? '样片升 4K 成片' : '4K 视频'

  const confirm = async (): Promise<void> => {
    if (submitting.current || !acknowledged) return
    submitting.current = true
    const { kind, cardIds } = request
    dismiss()
    const store = useVideoWorkbenchStore.getState()
    // 整个应用里只有这里会带 uhdConfirmed:true。
    const result = kind === 'finalize'
      ? await store.finalizeDrafts(cardIds, '4k', { uhdConfirmed: true })
      : await store.startCards(cardIds, { uhdConfirmed: true })
    const skipped = result.skipped[0]
    if (skipped) {
      addToast({
        type: 'warning',
        message: result.skipped.length > 1 ? `${result.skipped.length} 张没有提交:${skipped.reason}` : skipped.reason,
      })
    }
  }

  return createPortal(
    <div className="vw-palette-backdrop" onMouseDown={dismiss}>
      <div
        className="vw-palette vw-dialog"
        role="dialog"
        aria-label={`确认生成 4K(${step}/2)`}
        data-testid="vw-uhd-dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="vw-dialog-title">
          {step === 1 ? `确认生成 4K(1/2)` : `再确认一次(2/2)`}
        </div>
        <div className="vw-dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {count === 0 ? (
            <p className="vw-dialog-error" role="alert">这些卡片已经不存在了,没有可生成的内容。</p>
          ) : step === 1 ? (
            <>
              <p className="vw-dialog-note" style={{ color: '#e4e4e7' }}>
                即将生成 {count} 个{kindLabel}:
              </p>
              <ul aria-label="待确认的 4K 卡片" style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.7 }}>
                {held.slice(0, MAX_LISTED).map((c) => (
                  <li key={c.id}>
                    {snippet(c.prompt)} · {MODEL_LABELS[c.model] ?? c.model}
                  </li>
                ))}
                {count > MAX_LISTED && <li>…另 {count - MAX_LISTED} 张</li>}
              </ul>
              {isFinalize && (
                <p className="vw-dialog-note">
                  沿用样片的提示词、素材、时长、比例、seed 与音频,只把分辨率升到 4K(样片 7 天内有效)。
                </p>
              )}
              <p className="vw-dialog-note">
                4K 比 1080p 贵得多,提交后无法撤销 —— 已开始的任务照样计费。4K 使用独占资源,同时提交多张可能排队或被上游拒绝。
              </p>
              <p className="vw-dialog-note">这一步只有你本人能确认,AI 没有权限代为确认。</p>
            </>
          ) : (
            <>
              <p className="vw-dialog-note" style={{ color: '#e4e4e7' }}>
                最后一步:确认后立即提交 {count} 个{kindLabel}。
              </p>
              <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, lineHeight: 1.6, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                  style={{ marginTop: 3 }}
                />
                <span>我已了解:4K 按 4K 档位计费,提交后无法撤销。</span>
              </label>
            </>
          )}
        </div>
        <div className="vw-dialog-actions">
          {step === 2 && (
            <button type="button" className="vw-ghost" style={{ padding: '0 10px' }} onClick={() => setStep(1)}>
              返回
            </button>
          )}
          <span className="flex-1" />
          <button type="button" className="vw-ghost" style={{ padding: '0 10px' }} onClick={dismiss}>
            取消
          </button>
          {step === 1 ? (
            <button
              type="button"
              className="vw-primary"
              disabled={count === 0}
              onClick={() => setStep(2)}
            >
              继续(1/2)
            </button>
          ) : (
            <button
              type="button"
              className="vw-primary"
              disabled={!acknowledged || count === 0}
              title={acknowledged ? undefined : '先勾选上面的确认项'}
              onClick={() => void confirm()}
            >
              确认生成 4K · {count} 个(2/2)
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
