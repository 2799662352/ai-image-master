/**
 * `forwardEvents` 里三个接线点的端到端测试:回合开始拍基线 → shell 的 item_started
 * 计入 → turn_completed 时对比、减去 apply_patch 已报告的、合成事件发出并落库。
 *
 * 这一层非写不可,不是补覆盖率。同目录的 `AgentManager.observedChanges.test.ts`
 * 只证明 reducer 能吃下一条**手写**的合成事件,`observedChanges.test.ts` 又只在
 * 注入的假依赖上验作废条件 —— 两边都绿,拼起来却可以是坏的:reported 路径是 codex
 * 的 wire 值(`parseChange` 原样透传,仓库所有 fixture 都是工作区相对的 POSIX 写法),
 * 而观察侧的键是 `path.join(path.resolve(root), …)` 的原生绝对路径。两种写法在
 * `Set.has` 眼里毫不相干,去重于是成了死代码,同一个文件出两张卡。所以这里的
 * reported 一律用**相对 POSIX**,观察侧走真实的 takeSnapshot —— 格式不一致是被测
 * 对象本身,不能在测试里替它对齐。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentManager } from '../AgentManager'
import type { AgentInput, IAgentBackend } from '../types'
import type { AgentStreamEvent } from '../../../types/agent'
import type { FileChange, TimelineItem } from '../../../types/agent-timeline'

let userDataDir: string
let workspace: string

beforeEach(async () => {
  userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'obs-wiring-ud-'))
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'obs-wiring-ws-'))
  await fs.writeFile(path.join(workspace, 'by-shell.md'), 'before\n')
  await fs.writeFile(path.join(workspace, 'by-patch.md'), 'before\n')
})

afterEach(async () => {
  await fs.rm(userDataDir, { recursive: true, force: true })
  await fs.rm(workspace, { recursive: true, force: true })
})

/**
 * 起始快照是异步发起、不 await 的,而「第一条命令早于基线拍完」是四个作废条件之一。
 * 生产里两者隔着模型输出的许多个宏任务,测试里得自己把这段间隔造出来 —— 否则假 stream
 * 会瞬间把 shell 事件推到基线前面,整轮被正确地作废,用例就永远看不到卡。
 *
 * 100ms 对一个两文件的临时目录是几十倍的余量。真不够时的失败方向是**红**(拿不到卡),
 * 不会假绿放过回归。
 */
const BASELINE_HEADROOM_MS = 100

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

interface Recorder {
  emitted: AgentStreamEvent[]
  persisted: TimelineItem[][]
  /** 交错记录发事件与落库的先后,用来钉「先发后落」这个顺序。 */
  order: string[]
}

function makeBackend(rec: Recorder, workspaceDir: string): IAgentBackend {
  return {
    async start() {},
    async stop() {},
    isHealthy() {
      return true
    },
    async cancel() {},
    async *send(_threadId: string | undefined, _input: AgentInput): AsyncIterable<AgentStreamEvent> {
      const threadId = 'codex-thread-1'
      yield { type: 'thread_created', threadId }

      await sleep(BASELINE_HEADROOM_MS)

      yield {
        type: 'item_started',
        threadId,
        itemId: 'sh1',
        itemType: 'shell',
        payload: { command: 'pwsh -c "…"', cwd: workspaceDir },
      }
      // 命令的真实副作用:两个文件都被改了,其中一个稍后还会由 apply_patch 报告。
      await fs.writeFile(path.join(workspaceDir, 'by-shell.md'), 'after\n')
      await fs.writeFile(path.join(workspaceDir, 'by-patch.md'), 'after\n')
      yield { type: 'item_completed', threadId, itemId: 'sh1', itemType: 'shell', final: { exitCode: 0 } }

      // apply_patch 自报的一条 —— 路径按 codex 的写法:工作区相对 + 正斜杠。
      const reported: FileChange = {
        path: 'by-patch.md',
        operation: 'edit',
        diff: '@@ -1 +1 @@\n-before\n+after',
        added: 1,
        removed: 1,
      }
      yield {
        type: 'item_completed',
        threadId,
        itemId: 'fe1',
        itemType: 'fileEdit',
        final: { changes: [reported], totalAdded: 1, totalRemoved: 1 },
      }

      yield { type: 'turn_completed', threadId }
    },
  }
}

function makeManager(rec: Recorder): AgentManager {
  return new AgentManager({
    userDataDir,
    backend: makeBackend(rec, workspace),
    eventSink: (event) => {
      rec.emitted.push(event)
      if (event.type === 'item_completed' && event.itemType === 'fileEdit') {
        rec.order.push(`emit:${event.itemId}`)
      }
    },
    store: {
      createThread: async () => ({ id: 'thread-1' }),
      addMessage: async (msg: { role: string; items: TimelineItem[] }) => {
        if (msg.role === 'assistant') {
          rec.persisted.push(msg.items)
          rec.order.push('persist')
        }
        return { id: 'msg-1' }
      },
      updateLastMessageAt: async () => undefined,
    } as never,
    attachments: { ingest: async () => [] } as never,
  })
}

async function waitFor(predicate: () => boolean, rec: Recorder, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for the turn to finish; emitted=${JSON.stringify(
          rec.emitted.map((e) =>
            e.type === 'error' ? `error: ${String((e as { error?: unknown }).error)}` : e.type,
          ),
        )}`,
      )
    }
    await sleep(10)
  }
}

function fileEditChanges(items: TimelineItem[]): FileChange[] {
  return items.flatMap((item) => (item.type === 'fileEdit' ? item.changes : []))
}

describe('forwardEvents 里的观察接线', () => {
  it('命令改的文件出卡,apply_patch 已报告的那个不重复出现', async () => {
    const rec: Recorder = { emitted: [], persisted: [], order: [] }
    const mgr = makeManager(rec)
    await mgr.setCodexApiKey('sk-test')
    await mgr.setAllowedRoots([workspace])

    await mgr.sendMessage({ content: '改点东西', attachments: [] })
    await waitFor(() => rec.persisted.length > 0, rec, 3000)

    const observed = fileEditChanges(rec.persisted[0]).filter((c) => c.source === 'observed')

    expect(observed.map((c) => path.basename(c.path))).toEqual(['by-shell.md'])
    // by-patch.md 同样被命令改了,快照对比一定看得见它 —— 它不在这里,只能是因为
    // 减去了 apply_patch 报告的那条相对路径。这就是本用例存在的理由。
    expect(observed.some((c) => c.path.endsWith('by-patch.md'))).toBe(false)
  })

  it('合成事件先发给渲染端,再连同自报的改动一起落库', async () => {
    const rec: Recorder = { emitted: [], persisted: [], order: [] }
    const mgr = makeManager(rec)
    await mgr.setCodexApiKey('sk-test')
    await mgr.setAllowedRoots([workspace])

    await mgr.sendMessage({ content: '改点东西', attachments: [] })
    await waitFor(() => rec.persisted.length > 0, rec, 3000)

    // 直播与历史必须是同一份:落库的 items 里既有 apply_patch 那条,也有合成的那条。
    const paths = fileEditChanges(rec.persisted[0]).map((c) => path.basename(c.path))
    expect(paths).toContain('by-patch.md')
    expect(paths).toContain('by-shell.md')

    // 顺序:两条 fileEdit 事件都在落库之前发出去。
    expect(rec.order[rec.order.length - 1]).toBe('persist')
    expect(rec.order.filter((s) => s.startsWith('emit:'))).toHaveLength(2)
  })

  it('没跑过命令的回合不产生任何观察卡', async () => {
    const rec: Recorder = { emitted: [], persisted: [], order: [] }
    const mgr = new AgentManager({
      userDataDir,
      backend: {
        async start() {},
        async stop() {},
        isHealthy() {
          return true
        },
        async cancel() {},
        async *send(): AsyncIterable<AgentStreamEvent> {
          const threadId = 'codex-thread-1'
          yield { type: 'thread_created', threadId }
          await sleep(BASELINE_HEADROOM_MS)
          // 纯聊天:没有 shell,但工作区照样被外部改了(别的编辑器、后台进程)。
          await fs.writeFile(path.join(workspace, 'by-shell.md'), 'touched by someone else\n')
          yield {
            type: 'item_delta',
            threadId,
            itemId: 'txt1',
            itemType: 'text',
            patch: { kind: 'appendText', field: 'content', text: '好的' },
          }
          yield { type: 'turn_completed', threadId }
        },
      } as IAgentBackend,
      eventSink: (event) => rec.emitted.push(event),
      store: {
        createThread: async () => ({ id: 'thread-1' }),
        addMessage: async (msg: { role: string; items: TimelineItem[] }) => {
          if (msg.role === 'assistant') rec.persisted.push(msg.items)
          return { id: 'msg-1' }
        },
        updateLastMessageAt: async () => undefined,
      } as never,
      attachments: { ingest: async () => [] } as never,
    })
    await mgr.setCodexApiKey('sk-test')
    await mgr.setAllowedRoots([workspace])

    await mgr.sendMessage({ content: '聊两句', attachments: [] })
    await waitFor(() => rec.persisted.length > 0, rec, 3000)

    expect(fileEditChanges(rec.persisted[0])).toEqual([])
  })
})
