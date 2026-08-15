# 命令行改动也能看见 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 agent 用 shell 命令改的文件也能在聊天里看到 diff 卡,而不是只留下两个 CMD 块。

**Architecture:** 回合开始时异步给工作区拍一份内存内容快照;`turn_completed` 时重扫、对比,把差异合成一条 `fileEdit` item 事件发出去,复用现有的渲染与持久化路径。基线不可靠时(赛跑输了 / 超预算 / 读盘出错 / 本轮没跑过命令)整轮不显示,而不是显示一份可能错的。

**Tech Stack:** TypeScript、Node fs、`diff`(jsdiff)、Vitest。

设计依据见 `docs/superpowers/specs/2026-08-15-observed-file-changes-design.md`。

## Global Constraints

- **绝不落盘。** 快照只在内存,回合结束即弃。上游 [#29388](https://github.com/openai/codex/issues/29388) 因持久化写出 102 GB。
- **绝不提供回滚/还原。** 上游 [#30214](https://github.com/openai/codex/issues/30214) 的数据丢失来自 rollback 路径。本功能只读。
- **预算硬闸:** 文件数 3000、单文件 256 KB、总量 32 MB。
- **跳过目录:** `node_modules` `.git` `dist` `build` `out` `.next` `coverage` `target` `.venv` `__pycache__`。
- **二进制判定:** 前 8192 字节含 `0x00` 即视为二进制,跳过。
- **宁可不给,不给错的。** 任一作废条件成立即整轮不显示。
- 所有新文件零 lint 错误;`npm run typecheck:ci` 必须 0 新增。
- 测试用 `npx vitest run --pool=threads --maxWorkers=2 <path>`(本机 forks 池会 worker 超时)。

---

### Task 1: 工作区快照

**Files:**
- Create: `src/main/agent/workspaceSnapshot.ts`
- Test: `src/main/agent/__tests__/workspaceSnapshot.test.ts`

**Interfaces:**
- Produces: `takeSnapshot(roots: string[], budget?: SnapshotBudget): Promise<Snapshot>`;
  `interface Snapshot { files: Map<string, string>; skipped: Set<string>; complete: boolean }`;
  `DEFAULT_SNAPSHOT_BUDGET: SnapshotBudget`

- [ ] **Step 1: 写失败的测试**

创建 `src/main/agent/__tests__/workspaceSnapshot.test.ts`:

```ts
// 快照是「命令行改动也能看见」的基线。它错一次,整轮 diff 就是错的,
// 所以这里盯的全是**边界**:什么该跳过、什么该让整轮作废。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_SNAPSHOT_BUDGET, takeSnapshot } from '../workspaceSnapshot'

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-snap-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function write(rel: string, content: string | Buffer): Promise<void> {
  const full = path.join(root, rel)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, content)
}

describe('takeSnapshot', () => {
  it('收下文本文件的内容', async () => {
    await write('a.md', 'hello\n')
    await write('sub/b.ts', 'export const x = 1\n')

    const snap = await takeSnapshot([root])

    expect(snap.complete).toBe(true)
    expect(snap.files.get(path.join(root, 'a.md'))).toBe('hello\n')
    expect(snap.files.get(path.join(root, 'sub', 'b.ts'))).toBe('export const x = 1\n')
  })

  it('跳过产物目录 —— 否则 node_modules 一进来预算立刻爆', async () => {
    await write('node_modules/pkg/index.js', 'module.exports = 1\n')
    await write('.git/HEAD', 'ref: refs/heads/main\n')
    await write('dist/out.js', 'x\n')
    await write('keep.md', 'k\n')

    const snap = await takeSnapshot([root])

    expect([...snap.files.keys()]).toEqual([path.join(root, 'keep.md')])
  })

  it('二进制文件不进 files,但要进 skipped —— 免得被当成新建/删除', async () => {
    await write('bin.dat', Buffer.from([0x41, 0x00, 0x42]))

    const snap = await takeSnapshot([root])

    expect(snap.files.has(path.join(root, 'bin.dat'))).toBe(false)
    expect(snap.skipped.has(path.join(root, 'bin.dat'))).toBe(true)
  })

  it('超过单文件上限的也进 skipped', async () => {
    await write('big.md', 'x'.repeat(100))

    const snap = await takeSnapshot([root], { ...DEFAULT_SNAPSHOT_BUDGET, maxFileBytes: 10 })

    expect(snap.files.has(path.join(root, 'big.md'))).toBe(false)
    expect(snap.skipped.has(path.join(root, 'big.md'))).toBe(true)
  })

  it('文件数超预算 → complete:false 且不返回半份快照', async () => {
    await write('a.md', 'a\n')
    await write('b.md', 'b\n')
    await write('c.md', 'c\n')

    const snap = await takeSnapshot([root], { ...DEFAULT_SNAPSHOT_BUDGET, maxFiles: 2 })

    expect(snap.complete).toBe(false)
    expect(snap.files.size).toBe(0)
  })

  it('总量超预算 → complete:false', async () => {
    await write('a.md', 'x'.repeat(60))
    await write('b.md', 'y'.repeat(60))

    const snap = await takeSnapshot([root], { ...DEFAULT_SNAPSHOT_BUDGET, maxTotalBytes: 100 })

    expect(snap.complete).toBe(false)
    expect(snap.files.size).toBe(0)
  })

  it('根目录不存在不抛错,当作空', async () => {
    const snap = await takeSnapshot([path.join(root, 'nope')])

    expect(snap.complete).toBe(true)
    expect(snap.files.size).toBe(0)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run --pool=threads --maxWorkers=2 src/main/agent/__tests__/workspaceSnapshot.test.ts`
Expected: FAIL —— 找不到模块 `../workspaceSnapshot`

- [ ] **Step 3: 写实现**

创建 `src/main/agent/workspaceSnapshot.ts`:

```ts
/**
 * 工作区的一次性内存快照,用来算出「本轮命令行改了什么」的基线。
 *
 * ## 为什么不落盘
 *
 * 上游 Codex Desktop 把同样的东西写成 git 对象(`refs/codex/turn-diffs/`),
 * 结果单个项目的 `.git/objects` 涨到 102 GB(openai/codex#29388),另有一例
 * 连续 rollback 写坏内部仓库、工作区文件永久丢失(#30214)。我们只在内存里
 * 存、回合结束即弃,这两类问题因此不存在。
 *
 * ## 为什么超预算要整份作废
 *
 * 半份快照比没有快照更坏:起始扫描完整、结束扫描被截断,对比出来的「删除了
 * 800 个文件」全是扫描范围差异造成的假象,而它看起来跟真的一样。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

export interface SnapshotBudget {
  maxFiles: number
  maxFileBytes: number
  maxTotalBytes: number
  skipDirs: ReadonlySet<string>
}

export const DEFAULT_SNAPSHOT_BUDGET: SnapshotBudget = {
  maxFiles: 3000,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  skipDirs: new Set([
    'node_modules',
    '.git',
    'dist',
    'build',
    'out',
    '.next',
    'coverage',
    'target',
    '.venv',
    '__pycache__',
  ]),
}

export interface Snapshot {
  /** 绝对路径 → 文本内容。 */
  files: Map<string, string>
  /**
   * 见到了但没收内容的路径(二进制、超大、读不动)。对比时两边都要排除它们 ——
   * 否则一个读不动的文件会在下一轮变成「新建」。
   */
  skipped: Set<string>
  /** false = 预算爆了,这份快照不可用,调用方必须整轮作废。 */
  complete: boolean
}

const BINARY_SNIFF_BYTES = 8192

function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)
}

const EMPTY_SNAPSHOT: Snapshot = { files: new Map(), skipped: new Set(), complete: false }

export async function takeSnapshot(
  roots: string[],
  budget: SnapshotBudget = DEFAULT_SNAPSHOT_BUDGET,
): Promise<Snapshot> {
  const files = new Map<string, string>()
  const skipped = new Set<string>()
  let totalBytes = 0
  let overBudget = false

  async function walk(dir: string): Promise<void> {
    if (overBudget) return
    let entries: Awaited<ReturnType<typeof fs.readdir>>
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      // 根目录不存在 / 没权限:当作空,不炸掉整个回合。
      return
    }
    for (const entry of entries) {
      if (overBudget) return
      const name = String(entry.name)
      const full = path.join(dir, name)
      if (entry.isDirectory()) {
        if (budget.skipDirs.has(name)) continue
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue

      if (files.size + 1 > budget.maxFiles) {
        overBudget = true
        return
      }
      let buf: Buffer
      try {
        const stat = await fs.stat(full)
        if (stat.size > budget.maxFileBytes) {
          skipped.add(full)
          continue
        }
        buf = await fs.readFile(full)
      } catch {
        skipped.add(full)
        continue
      }
      if (looksBinary(buf)) {
        skipped.add(full)
        continue
      }
      totalBytes += buf.byteLength
      if (totalBytes > budget.maxTotalBytes) {
        overBudget = true
        return
      }
      files.set(full, buf.toString('utf8'))
    }
  }

  for (const root of roots) {
    await walk(path.resolve(root))
    if (overBudget) break
  }

  if (overBudget) return { files: new Map(), skipped: new Set(), complete: false }
  return { files, skipped, complete: true }
}

/** 供调用方在「压根没拍」时构造一个明确不可用的快照。 */
export function unavailableSnapshot(): Snapshot {
  return { files: new Map(EMPTY_SNAPSHOT.files), skipped: new Set(), complete: false }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run --pool=threads --maxWorkers=2 src/main/agent/__tests__/workspaceSnapshot.test.ts`
Expected: PASS,7 个用例

- [ ] **Step 5: 提交**

```bash
git add src/main/agent/workspaceSnapshot.ts src/main/agent/__tests__/workspaceSnapshot.test.ts
git commit -m "feat(agent): 工作区内存快照 —— 带预算闸,超了就整份作废"
```

---

### Task 2: 快照对比

**Files:**
- Create: `src/main/agent/snapshotDiff.ts`
- Modify: `src/types/agent-timeline.ts`(给 `FileChange` 加 `source`)
- Modify: `package.json`(加 `diff` 依赖)
- Test: `src/main/agent/__tests__/snapshotDiff.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `Snapshot`
- Produces: `diffSnapshots(before: Snapshot, after: Snapshot): FileChange[]`,每条 `source: 'observed'`

- [ ] **Step 1: 装依赖并加类型字段**

```bash
pnpm add diff
pnpm add -D @types/diff
```

在 `src/types/agent-timeline.ts` 把 `FileChange` 改成:

```ts
export interface FileChange {
  path: string
  operation: 'create' | 'edit' | 'delete'
  diff: string
  added: number
  removed: number
  /**
   * 这条改动是怎么知道的。
   *
   * - `reported`(缺省)—— agent 通过 apply_patch / 文件编辑工具报告的,可信。
   * - `observed` —— 我们对比回合前后的工作区快照观察到的。**不保证是 agent
   *   改的**:用户在别的编辑器里的改动、后台进程写出的产物都可能落进来。
   *
   * 可选是为了已经落库的历史行仍然合法。
   */
  source?: 'reported' | 'observed'
}
```

- [ ] **Step 2: 写失败的测试**

创建 `src/main/agent/__tests__/snapshotDiff.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { diffSnapshots } from '../snapshotDiff'
import type { Snapshot } from '../workspaceSnapshot'

function snap(files: Record<string, string>, over: Partial<Snapshot> = {}): Snapshot {
  return {
    files: new Map(Object.entries(files)),
    skipped: new Set(),
    complete: true,
    ...over,
  }
}

describe('diffSnapshots', () => {
  it('内容变了 → edit,并给出带 @@ 的 diff', () => {
    const out = diffSnapshots(snap({ '/w/a.md': 'one\ntwo\n' }), snap({ '/w/a.md': 'one\nTWO\n' }))

    expect(out).toHaveLength(1)
    expect(out[0].path).toBe('/w/a.md')
    expect(out[0].operation).toBe('edit')
    expect(out[0].diff).toContain('@@')
    expect(out[0].diff).toContain('-two')
    expect(out[0].diff).toContain('+TWO')
    expect(out[0].added).toBe(1)
    expect(out[0].removed).toBe(1)
  })

  it('每条都标成 observed —— 渲染层据此和 agent 自报的区分开', () => {
    const out = diffSnapshots(snap({}), snap({ '/w/n.md': 'x\n' }))

    expect(out[0].source).toBe('observed')
  })

  it('后有前无 → create;前有后无 → delete', () => {
    expect(diffSnapshots(snap({}), snap({ '/w/n.md': 'x\n' }))[0].operation).toBe('create')
    expect(diffSnapshots(snap({ '/w/g.md': 'x\n' }), snap({}))[0].operation).toBe('delete')
  })

  it('没变的不出现', () => {
    expect(diffSnapshots(snap({ '/w/a.md': 'same\n' }), snap({ '/w/a.md': 'same\n' }))).toEqual([])
  })

  it('任一侧不完整就返回空 —— 不能把扫描范围差异当成改动', () => {
    const before = snap({ '/w/a.md': 'x\n' }, { complete: false })
    const after = snap({})

    expect(diffSnapshots(before, after)).toEqual([])
    expect(diffSnapshots(after, before)).toEqual([])
  })

  it('任一侧 skipped 的路径都不报 —— 读不动的文件不该变成「新建」', () => {
    const before = snap({}, { skipped: new Set(['/w/locked.md']) })
    const after = snap({ '/w/locked.md': 'now readable\n' })

    expect(diffSnapshots(before, after)).toEqual([])
  })

  it('按路径排序,输出稳定', () => {
    const out = diffSnapshots(snap({}), snap({ '/w/b.md': 'b\n', '/w/a.md': 'a\n' }))

    expect(out.map((c) => c.path)).toEqual(['/w/a.md', '/w/b.md'])
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run --pool=threads --maxWorkers=2 src/main/agent/__tests__/snapshotDiff.test.ts`
Expected: FAIL —— 找不到模块 `../snapshotDiff`

- [ ] **Step 4: 写实现**

创建 `src/main/agent/snapshotDiff.ts`:

```ts
/**
 * 两份工作区快照之间的差异,产出与 Codex `fileChange` 同形的 `FileChange[]`,
 * 好让渲染层与持久化层原样复用。
 *
 * 只输出 hunk(不带 `---`/`+++` 文件头):`FileDiffBlock` 按行首字符上色,
 * 头行对它没有信息量;而 jsdiff 各版本对文件头的拼法略有出入,不依赖它更稳。
 */

import { structuredPatch } from 'diff'
import { countDiffLines } from '../../shared/diffUtils'
import type { FileChange } from '../../types/agent-timeline'
import type { Snapshot } from './workspaceSnapshot'

const CONTEXT_LINES = 3

function renderHunks(oldText: string, newText: string, filePath: string): string {
  const patch = structuredPatch(filePath, filePath, oldText, newText, '', '', {
    context: CONTEXT_LINES,
  })
  return patch.hunks
    .map(
      (h) =>
        `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join('\n')}`,
    )
    .join('\n')
}

export function diffSnapshots(before: Snapshot, after: Snapshot): FileChange[] {
  // 半份快照算出来的「改动」是扫描范围差异,不是真的改动。
  if (!before.complete || !after.complete) return []

  const paths = new Set<string>([...before.files.keys(), ...after.files.keys()])
  const out: FileChange[] = []

  for (const filePath of [...paths].sort()) {
    if (before.skipped.has(filePath) || after.skipped.has(filePath)) continue
    const oldText = before.files.get(filePath)
    const newText = after.files.get(filePath)
    if (oldText === newText) continue

    const operation: FileChange['operation'] =
      oldText === undefined ? 'create' : newText === undefined ? 'delete' : 'edit'
    const diff = renderHunks(oldText ?? '', newText ?? '', filePath)
    const { added, removed } = countDiffLines(diff)
    out.push({ path: filePath, operation, diff, added, removed, source: 'observed' })
  }

  return out
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run --pool=threads --maxWorkers=2 src/main/agent/__tests__/snapshotDiff.test.ts`
Expected: PASS,7 个用例

- [ ] **Step 6: 提交**

```bash
git add package.json pnpm-lock.yaml src/types/agent-timeline.ts src/main/agent/snapshotDiff.ts src/main/agent/__tests__/snapshotDiff.test.ts
git commit -m "feat(agent): 快照对比产出 observed 改动"
```

---

### Task 3: 回合追踪器

**Files:**
- Create: `src/main/agent/observedChanges.ts`
- Test: `src/main/agent/__tests__/observedChanges.test.ts`

**Interfaces:**
- Consumes: Task 1 `takeSnapshot`、Task 2 `diffSnapshots`
- Produces: `beginObservedChanges(deps: ObservedChangesDeps): ObservedChangeTracker`;
  `interface ObservedChangeTracker { noteShellStarted(): void; finish(reportedPaths: Set<string>): Promise<FileChange[]> }`

依赖全部注入,所以这一层不碰真磁盘也能测全部作废分支。

- [ ] **Step 1: 写失败的测试**

创建 `src/main/agent/__tests__/observedChanges.test.ts`:

```ts
// 这一层的全部价值在「什么时候**不**显示」。四个作废条件各一条用例 ——
// 少任何一条,用户就会看到一份看起来对、实则拿脏基线算出来的 diff。
import { describe, expect, it, vi } from 'vitest'
import { beginObservedChanges } from '../observedChanges'
import type { Snapshot } from '../workspaceSnapshot'
import type { FileChange } from '../../../types/agent-timeline'

function snap(complete = true): Snapshot {
  return { files: new Map(), skipped: new Set(), complete }
}

const change = (path: string): FileChange => ({
  path,
  operation: 'edit',
  diff: '@@ -1 +1 @@\n-a\n+b',
  added: 1,
  removed: 1,
  source: 'observed',
})

function deps(over: Partial<Parameters<typeof beginObservedChanges>[0]> = {}) {
  return {
    roots: () => ['/w'],
    snapshot: vi.fn(async () => snap()),
    diff: vi.fn(() => [change('/w/a.md')]),
    ...over,
  }
}

describe('beginObservedChanges', () => {
  it('跑过命令且基线可信 → 给出观察到的改动', async () => {
    const t = beginObservedChanges(deps())
    t.noteShellStarted()

    await expect(t.finish(new Set())).resolves.toEqual([change('/w/a.md')])
  })

  it('本轮没跑过命令 → 不显示(apply_patch 那条路已全覆盖,不该猜)', async () => {
    const t = beginObservedChanges(deps())

    await expect(t.finish(new Set())).resolves.toEqual([])
  })

  it('命令比起始快照先到 → 基线可能已被污染,整轮作废', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const t = beginObservedChanges(deps({ snapshot: vi.fn(async () => { await gate; return snap() }) }))

    t.noteShellStarted() // 快照还没回来
    release()

    await expect(t.finish(new Set())).resolves.toEqual([])
  })

  it('起始快照不完整 → 作废', async () => {
    const t = beginObservedChanges(deps({ snapshot: vi.fn(async () => snap(false)) }))
    t.noteShellStarted()

    await expect(t.finish(new Set())).resolves.toEqual([])
  })

  it('快照抛错 → 作废,不炸掉回合', async () => {
    const t = beginObservedChanges(
      deps({ snapshot: vi.fn(async () => { throw new Error('EACCES') }) }),
    )
    t.noteShellStarted()

    await expect(t.finish(new Set())).resolves.toEqual([])
  })

  it('apply_patch 已报告过的路径要减掉,否则同一个文件出现两条', async () => {
    const t = beginObservedChanges(
      deps({ diff: vi.fn(() => [change('/w/a.md'), change('/w/b.md')]) }),
    )
    t.noteShellStarted()

    const out = await t.finish(new Set(['/w/a.md']))

    expect(out.map((c) => c.path)).toEqual(['/w/b.md'])
  })

  it('起始快照只拍一次,结束时再拍一次', async () => {
    const snapshot = vi.fn(async () => snap())
    const t = beginObservedChanges(deps({ snapshot }))
    t.noteShellStarted()
    t.noteShellStarted() // 多条命令不该多拍

    await t.finish(new Set())

    expect(snapshot).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run --pool=threads --maxWorkers=2 src/main/agent/__tests__/observedChanges.test.ts`
Expected: FAIL —— 找不到模块 `../observedChanges`

- [ ] **Step 3: 写实现**

创建 `src/main/agent/observedChanges.ts`:

```ts
/**
 * 一个回合内「命令行改了什么」的追踪器。
 *
 * ## 为什么起始快照不能等到看见命令再拍
 *
 * 看见 `item_started` 时命令可能已经在跑了,那时拍的基线里已经含着它造成的
 * 修改,diff 会算空或算错。所以回合一开始就异步拍,并记录「第一条命令是不是
 * 比快照先到」—— 先到就说明基线不可信,整轮作废。
 *
 * 宁可不给也不给错的:这条纪律抄自上游 `TurnDiffTracker`,它在 patch 不能被
 * 精确表示时直接 `invalidate()` 丢掉整轮,而不是展示一份可能不准的。
 */

import type { FileChange } from '../../types/agent-timeline'
import type { Snapshot } from './workspaceSnapshot'

export interface ObservedChangesDeps {
  roots: () => string[]
  snapshot: (roots: string[]) => Promise<Snapshot>
  diff: (before: Snapshot, after: Snapshot) => FileChange[]
}

export interface ObservedChangeTracker {
  /** 每见到一个 shell item_started 调一次。 */
  noteShellStarted(): void
  /** 回合结束时调。`reportedPaths` 是 apply_patch 已经报告过的路径。 */
  finish(reportedPaths: Set<string>): Promise<FileChange[]>
}

export function beginObservedChanges(deps: ObservedChangesDeps): ObservedChangeTracker {
  const roots = deps.roots()
  let baselineReady = false
  let sawShell = false
  let raceLost = false

  // 不 await:回合开始不该为此多等。失败收敛成 null,由 finish 统一作废。
  const baseline: Promise<Snapshot | null> = deps
    .snapshot(roots)
    .then((snap) => {
      baselineReady = true
      return snap
    })
    .catch(() => {
      baselineReady = true
      return null
    })

  return {
    noteShellStarted(): void {
      sawShell = true
      if (!baselineReady) raceLost = true
    },
    async finish(reportedPaths: Set<string>): Promise<FileChange[]> {
      if (!sawShell || raceLost) return []
      const before = await baseline
      if (!before || !before.complete) return []

      let after: Snapshot
      try {
        after = await deps.snapshot(roots)
      } catch {
        return []
      }
      if (!after.complete) return []

      return deps.diff(before, after).filter((change) => !reportedPaths.has(change.path))
    },
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run --pool=threads --maxWorkers=2 src/main/agent/__tests__/observedChanges.test.ts`
Expected: PASS,7 个用例

- [ ] **Step 5: 提交**

```bash
git add src/main/agent/observedChanges.ts src/main/agent/__tests__/observedChanges.test.ts
git commit -m "feat(agent): 回合观察追踪器 —— 四个作废条件全部收在一处"
```

---

### Task 4: 接进 AgentManager

**Files:**
- Modify: `src/main/agent/AgentManager.ts`(`forwardEvents`,约 4742–4825 行)
- Test: `src/main/agent/__tests__/AgentManager.observedChanges.test.ts`

**Interfaces:**
- Consumes: Task 3 `beginObservedChanges`、Task 1 `takeSnapshot`、Task 2 `diffSnapshots`
- Produces: 回合结束时向渲染端与累加器发出一条 `item_completed` / `itemType: 'fileEdit'` 事件

- [ ] **Step 1: 写失败的测试**

创建 `src/main/agent/__tests__/AgentManager.observedChanges.test.ts`:

```ts
// 盯合成事件的形状:它必须能被 applyAssistantEvent 原样消费,否则落库的
// items 里会多出一条畸形项,而渲染端用的是同一个 reducer。
import { describe, expect, it } from 'vitest'
import { applyAssistantEvent } from '../AgentManager'
import type { AgentStreamEvent } from '../../../types/agent'
import type { FileChange } from '../../../types/agent-timeline'

const observed: FileChange = {
  path: 'D:/w/a.md',
  operation: 'edit',
  diff: '@@ -1 +1 @@\n-a\n+b',
  added: 1,
  removed: 1,
  source: 'observed',
}

describe('observed 改动的合成事件', () => {
  it('applyAssistantEvent 能把它变成一条带 changes 的 fileEdit item', () => {
    const event: AgentStreamEvent = {
      type: 'item_completed',
      threadId: 't1',
      itemId: 'observed-1',
      itemType: 'fileEdit',
      final: { changes: [observed], totalAdded: 1, totalRemoved: 1 },
    }

    const items = applyAssistantEvent([], event)

    expect(items).toHaveLength(1)
    expect(items[0].type).toBe('fileEdit')
    expect(items[0]).toMatchObject({ changes: [observed], totalAdded: 1, totalRemoved: 1 })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run --pool=threads --maxWorkers=2 src/main/agent/__tests__/AgentManager.observedChanges.test.ts`
Expected: FAIL —— `source` 字段还没进类型时会报类型错;若 Task 2 已完成则此条应直接 PASS(它验证的是既有 reducer 的契约),继续下一步。

- [ ] **Step 3: 在 AgentManager 里接线**

在 `AgentManager.ts` 顶部 import 区加:

```ts
import { beginObservedChanges } from './observedChanges'
import { takeSnapshot } from './workspaceSnapshot'
import { diffSnapshots } from './snapshotDiff'
```

在 `forwardEvents` 里,紧跟 `let assistantItems: TimelineItem[] = []` 之后加:

```ts
      // 回合一开始就异步拍基线。没跑过命令 / 赛跑输了 / 超预算都会在 finish
      // 里收敛成空数组 —— 判断集中在 observedChanges.ts,这里只负责喂依赖。
      const observer = beginObservedChanges({
        roots: () => [...this.allowedRoots],
        snapshot: (roots) => takeSnapshot(roots),
        diff: diffSnapshots,
      })
```

在 `assistantItems = applyAssistantEvent(assistantItems, event)` 之后加:

```ts
          if (event.type === 'item_started' && event.itemType === 'shell') {
            observer.noteShellStarted()
          }
```

在 `if (event.type === 'turn_completed') {` 之后、`if (this.store && assistantItems.length > 0) {` 之前加:

```ts
            // 落库之前把观察到的改动补进去,这样直播和历史看到的是同一份。
            const reportedPaths = new Set(
              assistantItems.flatMap((item) =>
                item.type === 'fileEdit' ? item.changes.map((c) => c.path) : [],
              ),
            )
            const observedChanges = await observer.finish(reportedPaths).catch(() => [])
            if (observedChanges.length > 0) {
              const observedEvent: AgentStreamEvent = {
                type: 'item_completed',
                threadId: dbThreadId,
                itemId: `observed-${Date.now()}`,
                itemType: 'fileEdit',
                final: {
                  changes: observedChanges,
                  totalAdded: observedChanges.reduce((s, c) => s + c.added, 0),
                  totalRemoved: observedChanges.reduce((s, c) => s + c.removed, 0),
                },
              }
              this.emitEvent(observedEvent)
              assistantItems = applyAssistantEvent(assistantItems, observedEvent)
            }
```

- [ ] **Step 4: 跑回归**

Run: `npx vitest run --pool=threads --maxWorkers=2 src/main/agent`
Expected: PASS,全部通过(基线 111 文件 / 1304 用例,加上本轮新增)

- [ ] **Step 5: typecheck**

Run: `npm run typecheck:ci`
Expected: `Typecheck debt gate passed`,0 新增

- [ ] **Step 6: 提交**

```bash
git add src/main/agent/AgentManager.ts src/main/agent/__tests__/AgentManager.observedChanges.test.ts
git commit -m "feat(agent): 回合结束把观察到的改动合成 fileEdit 事件发出"
```

---

### Task 5: 渲染层区分标记与口径文案

**Files:**
- Modify: `src/renderer/src/features/agent-chat/FileChangeSummary.tsx`
- Test: `src/renderer/src/features/agent-chat/__tests__/FileChangeSummary.test.tsx`

**Interfaces:**
- Consumes: Task 2 的 `FileChange.source`

- [ ] **Step 1: 写失败的测试**

在 `src/renderer/src/features/agent-chat/__tests__/FileChangeSummary.test.tsx` 末尾追加:

```ts
describe('observed 改动的口径', () => {
  const observedChange = (path: string) => ({
    path,
    operation: 'edit' as const,
    diff: '@@ -1 +1 @@\n-a\n+b',
    added: 1,
    removed: 1,
    source: 'observed' as const,
  })

  it('observed 的行带「命令行」标记,和 agent 自报的区分开', () => {
    render(
      <FileChangeSummary
        message={assistantMessage([[change('a.ts')], [observedChange('b.md')]])}
      />,
    )

    expect(screen.getByText('命令行')).toBeInTheDocument()
  })

  it('混入 observed 时标题改口 —— 不能再说「agent 编辑了」', () => {
    render(
      <FileChangeSummary
        message={assistantMessage([[change('a.ts')], [observedChange('b.md')]])}
      />,
    )

    expect(screen.getByText('本轮改动了 2 个文件')).toBeInTheDocument()
  })

  it('全是 agent 自报时维持原文案', () => {
    render(<FileChangeSummary message={assistantMessage([[change('a.ts')], [change('b.ts')]])} />)

    expect(screen.getByText('agent 编辑了 2 个文件')).toBeInTheDocument()
  })

  it('口径说明要讲明 observed 不保证是 agent 改的', () => {
    render(
      <FileChangeSummary
        message={assistantMessage([[change('a.ts')], [observedChange('b.md')]])}
      />,
    )

    expect(screen.getByRole('note')).toHaveAttribute(
      'aria-label',
      expect.stringContaining('不保证'),
    )
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run --pool=threads --maxWorkers=2 src/renderer/src/features/agent-chat/__tests__/FileChangeSummary.test.tsx`
Expected: FAIL —— 找不到「命令行」文本

- [ ] **Step 3: 改实现**

在 `FileChangeSummary.tsx` 里,把 `SCOPE_NOTE` 换成:

```ts
export const SCOPE_NOTE =
  '「命令行」标记的行来自回合前后的工作区对比，不保证都是 agent 改的——你在其它编辑器里的改动、后台进程写出的产物都可能落入。其余来自 agent 的文件编辑工具，可信。'
```

在 `SummaryRow` 的操作标签之后、文件名之前插入标记:

```tsx
          <span className={`w-8 shrink-0 ${OPERATION_CLASS[change.operation]}`}>
            {OPERATION_LABEL[change.operation]}
          </span>
          {change.source === 'observed' && (
            <span className="shrink-0 rounded bg-amber-500/15 px-1 text-[9px] text-amber-200/80">
              命令行
            </span>
          )}
```

把标题那一行改成:

```tsx
        <span className="font-medium text-zinc-100">
          {changes.some((c) => c.source === 'observed')
            ? `本轮改动了 ${changes.length} 个文件`
            : `agent 编辑了 ${changes.length} 个文件`}
        </span>
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run --pool=threads --maxWorkers=2 src/renderer/src/features/agent-chat`
Expected: PASS,全部通过

- [ ] **Step 5: 提交**

```bash
git add src/renderer/src/features/agent-chat/FileChangeSummary.tsx src/renderer/src/features/agent-chat/__tests__/FileChangeSummary.test.tsx
git commit -m "feat(agent-chat): 汇总条区分命令行改动，口径文案如实交代归因不确定"
```

---

### Task 6: 全量验收

**Files:** 无新增

- [ ] **Step 1: 跑受影响的全部套件**

```bash
npx vitest run --pool=threads --maxWorkers=2 src/main/agent src/renderer/src/features/agent-chat src/shared
```

Expected: 全绿,零失败

- [ ] **Step 2: typecheck 与构建**

```bash
npm run typecheck:ci
npm run build:vite
```

Expected: `Typecheck debt gate passed` 且 0 新增;构建通过

- [ ] **Step 3: 手动验收(dev 必须重启,主进程改动不热更)**

```bash
pnpm dev
```

1. 打开一个**非 git** 的内容目录当工作区
2. 让 agent 用命令行改一个 md 文件(例如要求它用 UTF-8 无 BOM 回写)
3. 预期:聊天里出现带 diff 的卡片,行上带「命令行」标记
4. 让 agent 只聊天不跑命令 → 不应出现任何观察到的改动
5. 让 agent 用文件编辑工具改 → 行上**不该**有「命令行」标记

- [ ] **Step 4: 开 PR**

```bash
git push -u origin <branch>
gh pr create --base main --title "feat(agent-chat): 命令行改的文件也能看见 diff" --body-file <path>
```

---

## Self-Review

**Spec 覆盖检查**

| Spec 要求 | 对应任务 |
|---|---|
| `workspaceSnapshot.ts` + 预算闸 | Task 1 |
| `snapshotDiff.ts` + `diff` 依赖 | Task 2 |
| `FileChange.source` 可选字段 | Task 2 Step 1 |
| 四个作废条件 | Task 3 |
| 两次扫描共用预算、任一不完整即作废 | Task 2(`diffSnapshots` 前置判断)+ Task 3 |
| 扫描根取 `allowedRoots` | Task 4 Step 3 |
| 减去已报告路径 | Task 3 + Task 4 Step 3 |
| 复用 `fileEdit` item 与 `item_completed` | Task 4 |
| UI 标记与口径文案 | Task 5 |
| 不落盘、不做回滚 | 全局约束;实现里没有任何写盘路径 |

**类型一致性** — `Snapshot`(Task 1)→ `diffSnapshots`(Task 2)→ `ObservedChangesDeps.diff`(Task 3)签名一致;`beginObservedChanges` 在 Task 3 定义、Task 4 消费,参数名一致。

**占位符扫描** — 每个代码步骤都是可直接粘贴的完整代码,无 TBD / 「适当处理错误」类表述。
