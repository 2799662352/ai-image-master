import { useState } from 'react'

/**
 * 仍然截断。限高解决的是「视觉高度」,不是「渲染成本」—— 一个 5000 行的 diff
 * 就算只露出 320px,那 5000 个 <div> 也是实打实要建的。
 *
 * 与旧实现的区别只有一个,但很关键:这次可以收回去。旧的 `setShowAll(true)`
 * 没有反向操作,手滑点开就再也回不去了。
 */
const MAX_VISIBLE_LINES = 200

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

interface DiffRow {
  text: string
  /** 空串 = 这一侧没有这一行(新增行没有旧行号,删除行没有新行号)。 */
  oldLine: string
  newLine: string
  kind: 'hunk' | 'add' | 'del' | 'ctx'
}

/**
 * 按 hunk 头推算左右两侧行号。
 *
 * 主进程 `snapshotDiff.ts` 会发**不带** `---`/`+++` 头、也可能不带 `@@` 的
 * 裸 diff(那边有测试锁着这个形状)。这种情况下起始行号无从得知 —— 标一个
 * 编造的行号比留空更坏,所以没有 hunk 头就两侧都留空。
 */
function toRows(diff: string): DiffRow[] {
  const rows: DiffRow[] = []
  let oldNo: number | null = null
  let newNo: number | null = null

  for (const text of diff.split('\n')) {
    const hunk = HUNK_HEADER.exec(text)
    if (hunk) {
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      rows.push({ text, oldLine: '', newLine: '', kind: 'hunk' })
      continue
    }
    if (text.startsWith('+')) {
      rows.push({ text, oldLine: '', newLine: newNo === null ? '' : String(newNo), kind: 'add' })
      if (newNo !== null) newNo += 1
      continue
    }
    if (text.startsWith('-')) {
      rows.push({ text, oldLine: oldNo === null ? '' : String(oldNo), newLine: '', kind: 'del' })
      if (oldNo !== null) oldNo += 1
      continue
    }
    rows.push({
      text,
      oldLine: oldNo === null ? '' : String(oldNo),
      newLine: newNo === null ? '' : String(newNo),
      kind: 'ctx',
    })
    if (oldNo !== null) oldNo += 1
    if (newNo !== null) newNo += 1
  }
  return rows
}

/**
 * 收窄后的配色:左边条 + 极淡的底,而不是整行重色块。
 *
 * 旧配色 `bg-emerald-500/10` 铺满整行,几十行连在一起就是一片糊掉的绿/红,
 * 反而看不清改了什么。GitHub / Cursor 都是「淡底 + 靠行号栏和边条区分」。
 * 色相保持 emerald / red / cyan 三系不变。
 */
const ROW_CLASS: Record<DiffRow['kind'], string> = {
  hunk: 'border-l-2 border-cyan-400/30 bg-cyan-500/[0.04] text-cyan-300/50',
  add: 'border-l-2 border-emerald-400/50 bg-emerald-500/[0.06] text-emerald-100/90',
  del: 'border-l-2 border-red-400/50 bg-red-500/[0.06] text-red-100/80',
  ctx: 'border-l-2 border-transparent text-zinc-400/80',
}

const GUTTER_CLASS: Record<DiffRow['kind'], string> = {
  hunk: 'text-cyan-300/25',
  add: 'text-emerald-300/30',
  del: 'text-red-300/30',
  ctx: 'text-zinc-600',
}

export interface DiffBodyProps {
  diff: string
}

/**
 * diff 的内容层:行号栏 + 收窄配色 + 限高滚动。不含 header、不含折叠。
 *
 * 之所以和 `FileDiffBlock` 拆开:`FileChangeSummary` 和 `EvidenceDetails` 已经
 * 各自带了 header 和折叠,如果内容层也自带一套,那边就成了折叠套娃。
 */
export function DiffBody({ diff }: DiffBodyProps) {
  const [showAll, setShowAll] = useState(false)

  const rows = toRows(diff)
  const truncated = !showAll && rows.length > MAX_VISIBLE_LINES
  const visible = truncated ? rows.slice(0, MAX_VISIBLE_LINES) : rows

  return (
    <div>
      <div
        data-diff-scroll
        className="max-h-[320px] overflow-y-auto overflow-x-auto rounded border border-zinc-800/60 bg-zinc-950/70 font-mono text-[11px] leading-[1.6]"
      >
        {visible.map((row, i) => (
          <div
            key={i}
            data-diff-row
            data-old-line={row.oldLine}
            data-new-line={row.newLine}
            className={`flex ${ROW_CLASS[row.kind]}`}
          >
            <span
              aria-hidden
              className={`sticky left-0 w-8 shrink-0 select-none bg-zinc-950/70 pr-1 text-right tabular-nums ${GUTTER_CLASS[row.kind]}`}
            >
              {row.oldLine}
            </span>
            {/* 两条都要 sticky,否则横向滚长行时旧行号钉住、新行号跟着跑掉。 */}
            <span
              aria-hidden
              className={`sticky left-8 w-8 shrink-0 select-none bg-zinc-950/70 pr-2 text-right tabular-nums ${GUTTER_CLASS[row.kind]}`}
            >
              {row.newLine}
            </span>
            <span className="whitespace-pre pl-1">{row.text || ' '}</span>
          </div>
        ))}
      </div>
      {rows.length > MAX_VISIBLE_LINES && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="mt-1 text-[10px] text-cyan-400/80 transition hover:text-cyan-300 hover:underline"
        >
          {showAll ? `收起,只看前 ${MAX_VISIBLE_LINES} 行` : `显示全部 ${rows.length} 行`}
        </button>
      )}
    </div>
  )
}
