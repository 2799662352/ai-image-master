import { useMemo, useState } from 'react'
import type { FileChange, Message } from '../../../../types/agent-timeline'
import { useFileExplorerStore } from '../file-explorer/store'
import { DiffBody } from './cards/DiffBody'

/**
 * 回合级「本轮改了哪些文件」汇总条,挂在助手气泡末尾。
 *
 * 对应 VS Code 聊天里那条「N files changed」栏(2026-08 的 microsoft/vscode#296376
 * 把 Keep/Undo 整套删掉之后,它就是那边唯一的改动出口)。做它的理由是:一个回合里
 * agent 常常「改一次 → 跑个测试 → 再改一次」,产生多个 fileEdit item 散落在时间线
 * 中间,单看任何一张卡都答不出「这一轮到底动了什么」。
 *
 * 放在气泡末尾而不是像 VS Code 那样浮在输入框上方:那边浮动条只服务最新一轮,
 * 而这里是可滚动的聊天记录,往回翻要能看到当时那一轮的账。
 *
 * ## 口径:两种来源,可信度不同
 *
 * `source: 'reported'`(缺省)来自 Codex 的 `fileChange` item,即 agent 通过
 * apply_patch / 文件编辑工具做的改动 —— 确定是它干的。
 *
 * `source: 'observed'` 来自回合前后的工作区快照对比,补的是 agent 用 shell 命令
 * 改出来的文件(`sed -i`、跑构建、`npm install` 动 lockfile 都只留 stdout,不产生
 * fileChange)。代价是**归因不确定**:同一时间窗里你在别的编辑器里的改动、后台
 * 进程写出的产物,都会一并落进来。所以这类行单独打「命令行」标记,口径说明如实
 * 交代这一点,而不是混进来假装同样可信。
 *
 * 标题跟着来源走:全是 reported 时说「agent 编辑了 N 个文件」;一旦混入 observed
 * 就改口「本轮改动了 N 个文件」—— 后者不声称是谁改的。
 */

/** 同一个文件在一轮里可能被改多次,按路径合并成一行,行数累加。 */
export function mergeChangesByPath(changes: FileChange[]): FileChange[] {
  const byPath = new Map<string, FileChange>()
  for (const change of changes) {
    const existing = byPath.get(change.path)
    if (!existing) {
      byPath.set(change.path, { ...change })
      continue
    }
    existing.added += change.added
    existing.removed += change.removed
    // 先建后改仍算「新建」;最后被删掉就是「删除」—— 取最能说明这一轮净结果的那个。
    if (change.operation === 'delete') existing.operation = 'delete'
    else if (existing.operation !== 'create' && change.operation === 'create') {
      existing.operation = 'create'
    }
    // diff 取最后一次:点进去看的是文件现在长什么样,不是中间态。
    existing.diff = change.diff
  }
  return [...byPath.values()]
}

/** 从一条消息里收集所有 agent 报告过的文件改动。 */
export function collectFileChanges(message: Message): FileChange[] {
  const changes: FileChange[] = []
  for (const item of message.items) {
    if (item.type === 'fileEdit') changes.push(...item.changes)
  }
  return mergeChangesByPath(changes)
}

export const SCOPE_NOTE =
  '「命令行」标记的行来自回合前后的工作区对比，不保证都是 agent 改的——你在其它编辑器里的改动、后台进程写出的产物都可能落入。其余来自 agent 的文件编辑工具，可信。'

const OPERATION_LABEL: Record<FileChange['operation'], string> = {
  create: '新建',
  edit: '修改',
  delete: '删除',
}

const OPERATION_CLASS: Record<FileChange['operation'], string> = {
  create: 'text-emerald-300/80',
  edit: 'text-cyan-200/70',
  delete: 'text-red-300/80',
}

function splitPath(path: string): { dir: string; name: string } {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return idx >= 0 ? { dir: path.slice(0, idx + 1), name: path.slice(idx + 1) } : { dir: '', name: path }
}

/**
 * 汇总条里的一行。**一行三个动作**,取自 Codex review pane 的设计:点文件名进
 * 编辑器、点行背景就地展开内联 diff —— 多文件回合里想快速扫一眼三个文件改了
 * 什么,不该被迫开三个标签页。
 *
 * 与 Codex 的映射有一处出入,是 HTML 逼的:按钮不能套按钮,要让「点行背景」可
 * 访问就得整行是一个 `<button>`,那文件名就没法再是独立按钮。于是把**最常见的
 * 意图**(「改了什么」)给最大的点击面积,打开文件退成右侧一个明确的按钮:
 *
 *  - 整行     → 就地展开/收起内联 diff
 *  - 「打开」 → 在文件展示栏打开这个文件(revealPath:开面板、展开目录、选中)
 *  - 「并排」 → 展开后才出现,进 CodeMirror 并排对比
 */
function SummaryRow({ change }: { change: FileChange }) {
  const [expanded, setExpanded] = useState(false)
  const openAiChange = useFileExplorerStore((s) => s.openAiChange)
  const revealPath = useFileExplorerStore((s) => s.revealPath)
  const { dir, name } = splitPath(change.path)
  const hasDiff = change.diff.trim().length > 0

  return (
    <div>
      <div className="flex items-center gap-2 text-[11px] text-zinc-300">
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={`${expanded ? '收起' : '展开'} ${change.path} 的改动`}
          disabled={!hasDiff}
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left transition hover:bg-cyan-500/10 disabled:cursor-default disabled:hover:bg-transparent"
        >
          <span className={`w-8 shrink-0 ${OPERATION_CLASS[change.operation]}`}>
            {OPERATION_LABEL[change.operation]}
          </span>
          {change.source === 'observed' && (
            <span className="shrink-0 rounded bg-amber-500/15 px-1 text-[9px] text-amber-200/80">
              命令行
            </span>
          )}
          <span className="min-w-0 flex-1 truncate font-mono" title={change.path}>
            <span className="text-zinc-500">{dir}</span>
            <span className="text-zinc-200">{name}</span>
          </span>
          <span className="shrink-0 text-emerald-300">+{change.added}</span>
          <span className="shrink-0 text-red-300">-{change.removed}</span>
        </button>
        <button
          type="button"
          aria-label={`在文件栏打开 ${change.path}`}
          onClick={() => void revealPath(change.path)}
          className="mr-2 shrink-0 rounded px-1.5 py-0.5 text-[10px] text-cyan-200/70 transition hover:bg-cyan-500/15 hover:text-cyan-100"
        >
          打开
        </button>
      </div>
      {expanded && hasDiff && (
        <div className="border-t border-cyan-500/10 bg-black/20 px-2.5 pt-1.5">
          {/*
            这里用内容层而不是 FileDiffBlock:这一行**自己**已经是折叠头了
            (路径、+N/−N、aria-expanded 都在上面),再套一个自带 header 的
            组件就是折叠套娃 —— 展开一行,看到的是另一个收起的行。
          */}
          <div className="mb-1.5">
            <DiffBody diff={change.diff} />
          </div>
          <button
            type="button"
            aria-label={`并排对比 ${change.path}`}
            onClick={() => void openAiChange(change)}
            className="mb-2 rounded border border-cyan-500/30 px-1.5 py-0.5 text-[10px] text-cyan-200 transition hover:bg-cyan-500/10"
          >
            并排对比
          </button>
        </div>
      )}
    </div>
  )
}

export function FileChangeSummary({ message }: { message: Message }) {
  const changes = useMemo(() => collectFileChanges(message), [message.items])

  // 单文件时上面那张 FileEditCard 已经把话说完了,再来一条汇总纯属噪音。
  if (changes.length < 2) return null

  const added = changes.reduce((sum, c) => sum + c.added, 0)
  const removed = changes.reduce((sum, c) => sum + c.removed, 0)

  return (
    <div
      data-testid="file-change-summary"
      className="my-2 overflow-hidden rounded-lg border border-cyan-500/20 bg-cyan-500/[0.04]"
    >
      <div className="flex items-center gap-1.5 border-b border-cyan-500/15 px-2.5 py-1.5 text-[11px]">
        <span className="font-medium text-zinc-100">
          {changes.some((c) => c.source === 'observed')
            ? `本轮改动了 ${changes.length} 个文件`
            : `agent 编辑了 ${changes.length} 个文件`}
        </span>
        {/* 口径提示。两种来源可信度不同(见模块注释):带「命令行」标记的行归因
            不确定。被这个坑到的人不会自己想明白,所以把口径摆在够得着的地方 ——
            但只做成一个 ⓘ,不占正文。 */}
        <span
          role="note"
          title={SCOPE_NOTE}
          aria-label={SCOPE_NOTE}
          className="cursor-help text-zinc-500 transition hover:text-zinc-300"
        >
          ⓘ
        </span>
        <span className="ml-auto text-emerald-300">+{added}</span>
        <span className="text-red-300">-{removed}</span>
      </div>
      <div className="divide-y divide-cyan-500/10">
        {changes.map((change) => (
          <SummaryRow key={change.path} change={change} />
        ))}
      </div>
    </div>
  )
}
