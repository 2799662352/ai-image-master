import { useMemo } from 'react'
import type { FileChange, Message } from '../../../../types/agent-timeline'
import { useFileExplorerStore } from '../file-explorer/store'

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
 * ## 口径:只统计 agent 报告过的编辑
 *
 * 数据来自 Codex 的 `fileChange` item,也就是它通过 apply_patch / 文件编辑工具做的
 * 改动。**agent 用 shell 命令改的文件不在其中** —— 它跑 `sed -i`、跑构建、
 * `npm install` 动 lockfile,都只会产生 commandExecution 的 stdout,不会有
 * fileChange。用户自己的改动、重命名、二进制文件同样不在。
 *
 * 所以文案写「agent 编辑了 N 个文件」而不是「本轮改动了 N 个文件」—— 后者是在
 * 承诺一个我们给不出的全集。真要全集得读 git(Codex 自己的 review pane 就是那么
 * 做的),那是另一件事。
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

export function FileChangeSummary({ message }: { message: Message }) {
  const openAiChange = useFileExplorerStore((s) => s.openAiChange)
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
      <div className="flex items-center gap-2 border-b border-cyan-500/15 px-2.5 py-1.5 text-[11px]">
        <span className="font-medium text-zinc-100">agent 编辑了 {changes.length} 个文件</span>
        <span className="ml-auto text-emerald-300">+{added}</span>
        <span className="text-red-300">-{removed}</span>
      </div>
      <div className="divide-y divide-cyan-500/10">
        {changes.map((change) => {
          const { dir, name } = splitPath(change.path)
          return (
            <button
              key={change.path}
              type="button"
              aria-label={`打开 ${change.path} 的改动对比`}
              onClick={() => void openAiChange(change)}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] text-zinc-300 transition hover:bg-cyan-500/10"
            >
              <span className={`w-8 shrink-0 ${OPERATION_CLASS[change.operation]}`}>
                {OPERATION_LABEL[change.operation]}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono" title={change.path}>
                <span className="text-zinc-500">{dir}</span>
                <span className="text-zinc-200">{name}</span>
              </span>
              <span className="shrink-0 text-emerald-300">+{change.added}</span>
              <span className="shrink-0 text-red-300">-{change.removed}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
