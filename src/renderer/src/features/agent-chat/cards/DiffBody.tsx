import { useCallback, useLayoutEffect, useRef, useState } from 'react'

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
/**
 * 取最后 `maxLines` 行,不切分整个字符串。行数不够就原样返回。
 */
function tailWindow(diff: string, maxLines: number): string {
  let cut = diff.length
  for (let seen = 0; seen < maxLines; seen += 1) {
    const prev = diff.lastIndexOf('\n', cut - 1)
    if (prev === -1) return diff
    cut = prev
  }
  return diff.slice(cut + 1)
}

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

/** 距底多少像素以内算「还贴着底」。一行约 18px,留一行多的余量。 */
const STICK_TO_BOTTOM_SLACK = 24

export interface DiffBodyProps {
  diff: string
  /**
   * 内容还在增长(agent 正在写这个文件)。开启后:截断保留**尾部**而不是
   * 开头,并且在用户没有主动往回翻的前提下自动滚到底。
   */
  followTail?: boolean
}

/**
 * diff 的内容层:行号栏 + 收窄配色 + 限高滚动。不含 header、不含折叠。
 *
 * 之所以和 `FileDiffBlock` 拆开:`FileChangeSummary` 和 `EvidenceDetails` 已经
 * 各自带了 header 和折叠,如果内容层也自带一套,那边就成了折叠套娃。
 */
export function DiffBody({ diff, followTail = false }: DiffBodyProps) {
  const [showAll, setShowAll] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  // 用户主动往回翻之后就别再抢滚动条 —— 他正想看上面某一行,结果每来一段
  // 增量就被拽回底部,是这类「跟随」实现最常见的毛病。
  const stickRef = useRef(true)

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_TO_BOTTOM_SLACK
  }, [])

  useLayoutEffect(() => {
    if (!followTail || !stickRef.current) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [diff, followTail])

  // 流式期间只解析**尾部窗口**。toRows 每一行分配一个对象,而这个组件在写入
  // 过程中是展开的、每帧都重渲染(diff 每帧都变,useMemo 永远命不中)——
  // 整块解析几十 KB 的 diff 就是每秒几十次、每次上千个短命对象,GC 压力正好
  // 压在用户盯着看的那段时间里。反正也只渲染最后 MAX_VISIBLE_LINES 行。
  //
  // 截断方向跟着看的方向走:收起态看的是「这次改了什么」,从头截合理;流式态
  // 看的是「现在正写到哪」,从头截等于永远停在开头,后面写的一个字都看不到。
  const windowed = followTail && !showAll
  const source = windowed ? tailWindow(diff, MAX_VISIBLE_LINES) : diff
  const rows = toRows(source)
  const hasMore = windowed ? source.length < diff.length : rows.length > MAX_VISIBLE_LINES
  const visible = !windowed && hasMore && !showAll ? rows.slice(0, MAX_VISIBLE_LINES) : rows

  return (
    <div>
      <div
        ref={scrollRef}
        onScroll={onScroll}
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
      {hasMore && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="mt-1 text-[10px] text-cyan-400/80 transition hover:text-cyan-300 hover:underline"
        >
          {showAll
            ? `收起,只看${followTail ? '后' : '前'} ${MAX_VISIBLE_LINES} 行`
            : // 流式态不报总行数:窗口外的部分没解析,数不出来;而且它每帧都在
              // 涨,报出来也只是一个跳个不停的数字。
              windowed
              ? '显示全部'
              : `显示全部 ${rows.length} 行`}
        </button>
      )}
    </div>
  )
}
