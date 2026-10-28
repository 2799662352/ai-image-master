// 可灵分镜编辑器 —— 卡片规格行下面的一块,仅 kling4 / kling4-omni 显示。
//
// 三态:单镜头(默认,不占地方)/ 智能分镜(模型按总提示词自己切)/ 自定义分镜(1~6 个镜头,
// 每个镜头一段描述 + 整数秒,时长之和 = 上方「时长」)。规则全部来自 types/klingMultiShot,
// 与主进程组包层、MCP 工具共用一份;这里只管把状态画出来,不自己再判一遍。
//
// 刻意**不在这里拦输入**:镜头描述超 512 字、时长之和对不上时只给计数 / 差额提示,
// 不截断、不改用户刚填的数 —— 修正的责任交给用户(提交按钮旁的原因来自 store.canStart)。

import { memo } from 'react'
import {
  KLING_MAX_SHOTS,
  KLING_MAX_SHOT_PROMPT_LENGTH,
  addKlingShot,
  defaultKlingShots,
  removeKlingShot,
  sumShotSeconds,
  type KlingMultiShot,
  type KlingShot,
} from '../../../../types/klingMultiShot'

type Mode = 'single' | 'intelligence' | 'customize'

const MODE_LABELS: Record<Mode, string> = {
  single: '单镜头',
  intelligence: '智能分镜',
  customize: '自定义分镜',
}

const MODE_HINTS: Record<Mode, string> = {
  single: '整条视频一个镜头',
  intelligence: '只写总提示词,模型自己决定怎么切镜头',
  customize: '自己分镜头:每个镜头一段描述 + 时长,时长之和等于总时长',
}

function modeOf(multiShot: KlingMultiShot | undefined): Mode {
  return multiShot ? multiShot.type : 'single'
}

const codePoints = (text: string): number => [...text].length

export interface KlingMultiShotEditorProps {
  multiShot: KlingMultiShot | undefined
  /** 卡片总时长(整数秒;可灵没有智能时长)。 */
  duration: number
  busy: boolean
  /** `null` = 回到单镜头。 */
  onChange: (next: KlingMultiShot | null) => void
}

function KlingMultiShotEditorImpl({ multiShot, duration, busy, onChange }: KlingMultiShotEditorProps) {
  const mode = modeOf(multiShot)

  const switchMode = (next: Mode): void => {
    if (next === mode) return
    if (next === 'single') onChange(null)
    else if (next === 'intelligence') onChange({ type: 'intelligence' })
    else onChange({ type: 'customize', shots: defaultKlingShots(duration) })
  }

  const shots: KlingShot[] = multiShot?.type === 'customize' ? multiShot.shots : []
  const setShots = (next: KlingShot[]): void => onChange({ type: 'customize', shots: next })
  const patchShot = (index: number, patch: Partial<KlingShot>): void =>
    setShots(shots.map((shot, i) => (i === index ? { ...shot, ...patch } : shot)))

  const sum = sumShotSeconds(shots)
  const sumOk = Number.isInteger(duration) && sum === duration

  return (
    <div className="space-y-2 text-xs" data-testid="vw-multishot">
      <label className="flex items-center gap-1.5 text-white/70 select-none" title={MODE_HINTS[mode]}>
        <span aria-hidden="true">🎬</span>
        <select
          aria-label="分镜"
          value={mode}
          disabled={busy}
          className="bg-[#18181B] border border-[#3F3F46] text-white/80 px-2 py-1.5 focus:outline-none focus:border-[#FCE300] disabled:opacity-60"
          onChange={(e) => switchMode(e.target.value as Mode)}
        >
          {(Object.keys(MODE_LABELS) as Mode[]).map((m) => (
            <option key={m} value={m}>{MODE_LABELS[m]}</option>
          ))}
        </select>
        {mode !== 'single' && <span className="text-[10px] text-white/40">{MODE_HINTS[mode]}</span>}
      </label>

      {mode === 'customize' && (
        <div className="space-y-1.5">
          {shots.map((shot, i) => {
            const length = codePoints(shot.prompt)
            const tooLong = length > KLING_MAX_SHOT_PROMPT_LENGTH
            return (
              <div key={i} className="flex items-start gap-1.5" data-testid={`vw-shot-${i + 1}`}>
                <span className="shrink-0 w-12 pt-1.5 text-white/50">镜头 {i + 1}</span>
                <div className="min-w-0 flex-1 space-y-0.5">
                  <textarea
                    aria-label={`镜头 ${i + 1} 描述`}
                    rows={2}
                    value={shot.prompt}
                    disabled={busy}
                    placeholder="这个镜头里发生什么"
                    className={`w-full resize-y bg-[#18181B] border px-2 py-1.5 text-white/80 focus:outline-none focus:border-[#FCE300] disabled:opacity-60 ${
                      tooLong ? 'border-orange-400/60' : 'border-[#3F3F46]'
                    }`}
                    onChange={(e) => patchShot(i, { prompt: e.target.value })}
                  />
                  {(tooLong || length > KLING_MAX_SHOT_PROMPT_LENGTH * 0.8) && (
                    <p className={`text-[10px] ${tooLong ? 'text-orange-300' : 'text-white/35'}`}>
                      {length} / {KLING_MAX_SHOT_PROMPT_LENGTH} 字
                    </p>
                  )}
                </div>
                <input
                  type="number"
                  aria-label={`镜头 ${i + 1} 时长(秒)`}
                  min={1}
                  step={1}
                  value={shot.duration > 0 ? shot.duration : ''}
                  disabled={busy}
                  className="w-16 shrink-0 bg-[#18181B] border border-[#3F3F46] text-white/80 px-2 py-1.5 focus:outline-none focus:border-[#FCE300] disabled:opacity-60 [appearance:textfield]"
                  onChange={(e) => {
                    const raw = e.target.value.trim()
                    // 空 / 非数字记 0:校验会如实说这一镜的时长不对,而不是悄悄补一个数。
                    patchShot(i, { duration: raw === '' ? 0 : Math.trunc(Number(raw)) || 0 })
                  }}
                />
                <span className="shrink-0 pt-1.5 text-white/40">s</span>
                <button
                  type="button"
                  aria-label={`删除镜头 ${i + 1}`}
                  disabled={busy || shots.length <= 1}
                  title={shots.length <= 1 ? '至少保留 1 个镜头;要回到单镜头请切换分镜模式' : '删除这个镜头(它的时长并给相邻镜头)'}
                  className="shrink-0 px-1 pt-1.5 text-white/40 hover:text-red-400 disabled:opacity-30 disabled:hover:text-white/40"
                  onClick={() => setShots(removeKlingShot(shots, i))}
                >
                  ✕
                </button>
              </div>
            )
          })}

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <button
              type="button"
              disabled={busy || shots.length >= KLING_MAX_SHOTS}
              title={shots.length >= KLING_MAX_SHOTS ? `最多 ${KLING_MAX_SHOTS} 个镜头` : '从最长的镜头里借 1 秒给新镜头'}
              className="border border-dashed border-[#3F3F46] px-2 py-1 text-white/40 hover:border-[#FCE300] hover:text-[#FCE300] transition-colors disabled:opacity-40 disabled:hover:border-[#3F3F46] disabled:hover:text-white/40"
              onClick={() => setShots(addKlingShot(shots))}
            >
              <span aria-hidden="true">＋</span> 加一个镜头
            </button>
            <span
              data-testid="vw-shot-sum"
              className={sumOk ? 'text-white/40' : 'text-orange-300'}
            >
              合计 {sum}s / 总时长 {Number.isInteger(duration) && duration > 0 ? `${duration}s` : '未定'}
              {!sumOk && Number.isInteger(duration) && duration > 0 && sum !== duration
                ? `(${sum > duration ? '多' : '少'} ${Math.abs(sum - duration)}s,需与上方「时长」一致)`
                : ''}
            </span>
          </div>
          <p className="text-[10px] text-white/35">
            总提示词可以留空(以各镜头描述为准)。分镜不改变价格,仍按总秒数计费。
          </p>
        </div>
      )}
    </div>
  )
}

export const KlingMultiShotEditor = memo(KlingMultiShotEditorImpl)
