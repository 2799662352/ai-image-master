import { useState } from 'react'
import type { FileChange } from '../../../../../types/agent-timeline'
import { DiffBody } from './DiffBody'

/**
 * 操作类型徽章。缺了它,「删掉一个文件」和「改了几行」在 diff 里都是一片红,
 * 分不出来 —— 而这两件事的严重程度差着量级。
 */
const OPERATION_BADGE: Record<FileChange['operation'], { label: string; className: string }> = {
  create: { label: '新建', className: 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200' },
  edit: { label: '修改', className: 'border-cyan-400/30 bg-cyan-500/10 text-cyan-200' },
  delete: { label: '删除', className: 'border-red-400/30 bg-red-500/10 text-red-200' },
}

export interface FileDiffBlockProps {
  change: FileChange
  /**
   * 有值时在 header 右侧出一个「打开」按钮(并排对比视图)。它必须是折叠按钮的
   * 兄弟节点而不是子节点 —— 按钮不能嵌套。`FileChangeSummary` 里已经因为同样
   * 的约束这么排版了。
   */
  onOpen?: () => void
  /** 宿主决定初始展开状态。 */
  defaultExpanded?: boolean
}

/**
 * 一个文件改动 = 一行可折叠的 header + 展开后的 {@link DiffBody}。
 *
 * 改造前这里是「永远摊开」的:200 行上限、没有任何高度约束、`Show all` 单向
 * 不可逆。按 11px/1.6 行高算,200 行就是约 3500px —— 一次改动就把整个聊天
 * 气泡顶穿,而且收不回去。
 *
 * 折叠的形态照搬 `ReasoningCard` / `ShellCard`:药丸形 header 按钮 + `▾`/`▸`
 * 字形 + 条件渲染(仓库里没有任何一处用高度动画,别在这里破例)。
 */
export function FileDiffBlock({ change, onOpen, defaultExpanded = false }: FileDiffBlockProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const badge = OPERATION_BADGE[change.operation]

  return (
    <div className="mb-1">
      <div className="flex items-center gap-1 rounded-md border border-zinc-800/70 bg-zinc-900/40 pr-1 transition hover:border-zinc-700/80">
        {/*
          显式 aria-label:否则折叠按钮的可访问名是由内容拼出来的
          「▸ 修改 docs/a.md +1 −1」,会和旁边「Open diff for docs/a.md」
          撞车 —— 按路径找按钮时两个都命中。
        */}
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={`${expanded ? '收起' : '展开'} ${change.path} 的改动`}
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-left text-[11px]"
        >
          <span className="w-2 shrink-0 text-[9px] text-zinc-500">{expanded ? '▾' : '▸'}</span>
          <span className={`shrink-0 rounded border px-1 py-px text-[10px] leading-none ${badge.className}`}>
            {badge.label}
          </span>
          <code className="min-w-0 flex-1 truncate font-medium text-zinc-200" title={change.path}>
            {change.path}
          </code>
          <span className="shrink-0 text-emerald-400/90">+{change.added}</span>
          <span className="shrink-0 text-red-400/90">−{change.removed}</span>
        </button>
        {onOpen && (
          <button
            type="button"
            aria-label={`Open diff for ${change.path}`}
            onClick={onOpen}
            className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-zinc-500 transition hover:bg-cyan-500/10 hover:text-cyan-300"
          >
            打开
          </button>
        )}
      </div>
      {expanded && (
        <div className="mt-1">
          <DiffBody diff={change.diff} />
        </div>
      )}
    </div>
  )
}
