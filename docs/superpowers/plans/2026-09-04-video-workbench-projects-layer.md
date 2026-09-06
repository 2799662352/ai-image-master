# 视频工作台「剧 / 分段」项目层 实现计划(计划 1 / 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给视频工作台加一层「剧(project)」:分段(原页面 board)归属某部剧,界面变为左侧剧栏 + 剧总览 + 现有分段页,Agent 工具按当前剧隔离;卡片一个像素不改。

**Architecture:** 类型上给 `VideoWorkbenchBoard` 加 `projectId`、新增 `VideoWorkbenchProject`;IndexedDB v2→v3 加 `projects` store 与索引,升级时把老 board 全部归入「默认项目」。store 用 zustand slices 模式在新文件 `projects.ts` 承载剧的状态与动作,统计是纯函数 `projectStats.ts`;撤销快照扩展到剧。渲染层新增 `ProjectRail` / `ProjectOverview` / `SegmentCard` / `MigrationNotice`,`VideoWorkbenchPage` 变两栏并按每部剧记忆的视图切总览/分段页,`BoardTabs` 只显示本剧分段、单行滚动。MCP 现有工具隐式作用于当前剧,新增列剧 / 切剧 / 建剧三个工具。

**Tech Stack:** Electron 28 + React 19 + zustand + Tailwind v4(CSS-first)+ IndexedDB;测试 vitest + jsdom(+ 新增 devDependency `fake-indexeddb` 只给升级迁移测试用)。

**Spec:** `docs/superpowers/specs/2026-09-04-video-workbench-projects-design.md`。计划 2(`data:` 落盘与清理)和计划 3(工程文件导入/导出)另写。

## Global Constraints

- **`WorkbenchCard.tsx` 及其子组件不改**(spec §1)。
- 代码里 `Board` / `boardId` 命名不改;界面文案「页面」→「分段」,新建分段默认名「分段 N」,老数据名字不动(spec §3)。
- 只用现有 token:黄 `#FCE300`、底 `#09090B / #111113 / #18181b / #27272a`、边 `#3F3F46`、灰字 `#71717a`、成功 `#22c55e`、失败 `#f87171`;圆角 0–2px;无投影(spec §4.3)。
- 顶栏、跑马灯、导航 tab 不动。
- **偏离 spec 一处(实现时同步改 spec §4.1)**:每部剧至少一个分段。新建剧自动带「分段 1」,分段页的"仅剩一页拒删"改为"本剧仅剩一段拒删"。理由:store 里 `activeBoardId: string` 是硬不变量,`addCards`/MCP `add_tasks` 都依赖它;允许零分段要给整个 store 加可空分支,收益只是一个空态插画。
- 所有会改 boards/cards/projects 集合或顺序的 action 必须 `revision + 1` 与 `structureRevision + 1`(store.ts 第 326–346 行的既有纪律);纯 UI 状态(视图模式、折叠、选中)两个都不动。
- 统计口径唯一来源 `projectStats.ts`;花费复用 `pricing.summarizeCostUsd(cards, cardHasVideoInput)`。
- 测试命令统一 `pnpm exec vitest run <file>`;每个任务结束 `pnpm typecheck` 不得新增错误(基线机制见 `scripts/ci/typecheck-baseline.mjs`)。
- 提交:每个任务一次 `git commit`,消息前缀 `feat(workbench):` / `test(workbench):` / `refactor(workbench):`。**不 push。**
- Windows 环境:不要用 PowerShell 的 `Get-Content`/`Set-Content` 改源文件(会破坏 CJK 编码);用编辑器工具。commit message 含中文时写到临时文件用 `git commit -F`。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/types/videoWorkbench.ts`(改) | `VideoWorkbenchProject` 类型;`VideoWorkbenchBoard.projectId`;`DEFAULT_PROJECT_ID` / `DEFAULT_PROJECT_NAME` 常量 |
| `src/renderer/src/features/video-workbench/projectStats.ts`(新) | 纯函数:分段统计、剧统计、封面选择 |
| `src/renderer/src/features/video-workbench/WorkbenchDb.ts`(改) | v3:`projects` store、索引、升级迁移、`putProject/removeProject/listProjects` |
| `src/renderer/src/features/video-workbench/projects.ts`(新) | zustand slice:剧的状态与动作 |
| `src/renderer/src/features/video-workbench/store.ts`(改) | 合并 slice;`addBoard/removeBoard/switchBoard/ensureHydrated` 感知剧 |
| `src/renderer/src/features/video-workbench/workbenchHistory.ts`(改) | 撤销快照含 projects |
| `src/renderer/src/pages-react/video-workbench/ProjectRail.tsx`(新) | 左侧剧栏 |
| `src/renderer/src/pages-react/video-workbench/ProjectOverview.tsx`(新) | 剧总览(头部 + 分段网格) |
| `src/renderer/src/pages-react/video-workbench/SegmentCard.tsx`(新) | 总览里一张分段卡 |
| `src/renderer/src/pages-react/video-workbench/MigrationNotice.tsx`(新) | 默认项目的迁移提示条 |
| `src/renderer/src/pages-react/video-workbench/ProjectSearchPalette.tsx`(新) | Ctrl+P 搜索剧/分段 |
| `src/renderer/src/pages-react/video-workbench/BoardTabs.tsx`(改) | 只显示本剧分段、单行滚动、面包屑、接受卡片拖入 |
| `src/renderer/src/pages-react/VideoWorkbenchPage.tsx`(改) | 两栏布局;按视图模式渲染总览或分段页 |
| `src/renderer/src/pages-react/video-workbench/workbench.css`(改) | 剧栏/总览新类 |
| `src/renderer/src/features/agent-chat/AgentToolExecutor.ts`(改) | 工具按当前剧过滤;三个新工具的渲染端实现 |
| `src/main/mcp/tools/videoWorkbenchTools.ts`(改) | 三个新工具注册;status/export/apply 描述 |
| `src/main/mcp/tools/__tests__/toolAnnotations.test.ts`(改) | 新工具注解 |

---

### Task 1: 类型 + 统计纯函数

**Files:**
- Modify: `src/types/videoWorkbench.ts:188-206`(`VideoWorkbenchBoard` 附近)
- Create: `src/renderer/src/features/video-workbench/projectStats.ts`
- Test: `src/renderer/src/features/video-workbench/__tests__/projectStats.test.ts`

**Interfaces:**
- Produces: `VideoWorkbenchProject`、`DEFAULT_PROJECT_ID = 'project-default'`、`DEFAULT_PROJECT_NAME = '默认项目'`;`summarizeBoard(cards): SegmentStats`、`summarizeProject(boards, cards): ProjectStats`、`pickCover(cards): string | null`、`formatDuration(seconds): string`。

- [ ] **Step 1: 写失败测试**

```ts
// src/renderer/src/features/video-workbench/__tests__/projectStats.test.ts
import { describe, expect, it } from 'vitest'
import type { VideoWorkbenchBoard, VideoWorkbenchCard } from '../../../../types/videoWorkbench'
import { buildCard } from '../cardSpec'
import { formatDuration, pickCover, summarizeBoard, summarizeProject } from '../projectStats'

function card(boardId: string, patch: Partial<VideoWorkbenchCard>): VideoWorkbenchCard {
  return { ...buildCard({ prompt: 'p' }, 0, boardId), ...patch }
}
const board = (id: string, projectId: string, order: number): VideoWorkbenchBoard => ({
  id, projectId, name: id, order, createdAt: 1,
})

describe('summarizeBoard', () => {
  it('按状态分桶,时长只算已完成', () => {
    const s = summarizeBoard([
      card('b', { status: 'succeeded', duration: 10 }),
      card('b', { status: 'succeeded', duration: 5 }),
      card('b', { status: 'running', duration: 15 }),
      card('b', { status: 'failed', duration: 15 }),
      card('b', { status: 'draft', duration: 15 }),
    ])
    expect(s.total).toBe(5)
    expect(s.done).toBe(2)
    expect(s.active).toBe(1)
    expect(s.failed).toBe(1)
    expect(s.pending).toBe(1)
    expect(s.doneSeconds).toBe(15)
  })
  it('空分段全为零', () => {
    expect(summarizeBoard([])).toMatchObject({ total: 0, done: 0, active: 0, failed: 0, pending: 0, doneSeconds: 0 })
  })
})

describe('summarizeProject', () => {
  it('只累加属于该剧分段的卡,segments 按 order 排', () => {
    const boards = [board('b2', 'p1', 1), board('b1', 'p1', 0), board('x', 'p2', 0)]
    const cards = [
      card('b1', { status: 'succeeded', duration: 5 }),
      card('b2', { status: 'failed' }),
      card('x', { status: 'succeeded', duration: 99 }),
    ]
    const s = summarizeProject('p1', boards, cards)
    expect(s.segments.map((x) => x.board.id)).toEqual(['b1', 'b2'])
    expect(s.totals.total).toBe(2)
    expect(s.totals.done).toBe(1)
    expect(s.totals.failed).toBe(1)
    expect(s.totals.doneSeconds).toBe(5)
    expect(s.donePercent).toBe(50)
  })
  it('没有卡时完成率为 0 而不是 NaN', () => {
    expect(summarizeProject('p1', [board('b1', 'p1', 0)], []).donePercent).toBe(0)
  })
})

describe('pickCover', () => {
  it('优先最近完成卡的成片海报,其次第一张参考图,否则 null', () => {
    const older = card('b', { status: 'succeeded', updatedAt: 1, posterUrl: 'poster-old' })
    const newer = card('b', { status: 'succeeded', updatedAt: 2, posterUrl: 'poster-new' })
    expect(pickCover([older, newer])).toBe('poster-new')
    const onlyRef = card('b', { referenceImages: [{ name: 'a', src: 'ref-a' }] })
    expect(pickCover([onlyRef])).toBe('ref-a')
    expect(pickCover([card('b', {})])).toBeNull()
  })
})

describe('formatDuration', () => {
  it('m:ss', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(65)).toBe('1:05')
    expect(formatDuration(402)).toBe('6:42')
  })
})
```

> 注意:`posterUrl` 若卡片类型上没有这个字段,把测试改成用现有的成片封面字段(在 `src/types/videoWorkbench.ts` 里 grep `poster|cover|thumbnail`);若一个都没有,`pickCover` 只走参考图分支,并把海报那两行断言删掉。**不要为封面新增字段。**

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run src/renderer/src/features/video-workbench/__tests__/projectStats.test.ts`
Expected: FAIL — `Cannot find module '../projectStats'`,以及 `projectId` 不在 `VideoWorkbenchBoard` 上的类型错误。

- [ ] **Step 3: 加类型**

在 `src/types/videoWorkbench.ts` 的 `VideoWorkbenchBoard` 定义**之前**插入:

```ts
/** 升级时承接全部老页面的那部剧。id 固定,便于迁移幂等与测试。 */
export const DEFAULT_PROJECT_ID = 'project-default'
export const DEFAULT_PROJECT_NAME = '默认项目'

/**
 * 「剧」(project):一部片子/一个项目,是分段(board)的容器。不同剧之间在界面上
 * 完全隔离,工作台任意时刻只呈现一部剧。
 */
export interface VideoWorkbenchProject {
  id: string
  name: string
  /** 剧栏排序(小在上)。 */
  order: number
  createdAt: number
  /** 只在改名时更新;「最近活动」由卡片的 updatedAt 派生,见 projectStats。 */
  updatedAt: number
  /**
   * 仅升级生成的「默认项目」带此标记:总览顶部显示迁移提示条。用户关闭提示或
   * 改名后清除。不影响任何数据语义。
   */
  legacy?: true
}
```

在 `VideoWorkbenchBoard` 里 `id: string` 之后加:

```ts
  /** 所属剧。v3 起必填;老数据在升级/水合时归入 DEFAULT_PROJECT_ID。 */
  projectId: string
```

- [ ] **Step 4: 写 projectStats.ts**

```ts
// src/renderer/src/features/video-workbench/projectStats.ts
/**
 * 剧 / 分段 的统计与封面 —— 纯函数,剧栏、总览、MCP status 都从这里取数,
 * 保证口径唯一。花费复用 pricing.summarizeCostUsd(事后口径,非账单)。
 */
import type { VideoWorkbenchBoard, VideoWorkbenchCard } from '../../../../types/videoWorkbench'
import { isActiveStatus } from './cardSpec'
import { summarizeCostUsd, type CostSummary } from './pricing'
import { cardHasVideoInput } from './store'

export interface SegmentStats {
  total: number
  done: number
  active: number
  failed: number
  pending: number
  /** 已完成卡片的规格时长之和(秒)。 */
  doneSeconds: number
  cost: CostSummary
  /** 卡片最近一次 updatedAt;没有卡时为 null。 */
  lastActivityAt: number | null
}

export interface SegmentWithStats {
  board: VideoWorkbenchBoard
  stats: SegmentStats
  cover: string | null
}

export interface ProjectStats {
  segments: SegmentWithStats[]
  totals: SegmentStats
  /** 0–100 的整数;没有卡时为 0。 */
  donePercent: number
  cover: string | null
}

export function summarizeBoard(cards: readonly VideoWorkbenchCard[]): SegmentStats {
  let done = 0
  let active = 0
  let failed = 0
  let pending = 0
  let doneSeconds = 0
  let lastActivityAt: number | null = null
  for (const c of cards) {
    if (c.status === 'succeeded') {
      done += 1
      doneSeconds += c.duration ?? 0
    } else if (isActiveStatus(c.status)) active += 1
    else if (c.status === 'failed') failed += 1
    else pending += 1
    if (lastActivityAt === null || c.updatedAt > lastActivityAt) lastActivityAt = c.updatedAt
  }
  return {
    total: cards.length,
    done,
    active,
    failed,
    pending,
    doneSeconds,
    cost: summarizeCostUsd(cards, cardHasVideoInput),
    lastActivityAt,
  }
}

/** 成片海报优先(最近完成的一张),其次第一张参考图。 */
export function pickCover(cards: readonly VideoWorkbenchCard[]): string | null {
  let best: VideoWorkbenchCard | null = null
  for (const c of cards) {
    if (c.status === 'succeeded' && c.posterUrl && (!best || c.updatedAt > best.updatedAt)) best = c
  }
  if (best?.posterUrl) return best.posterUrl
  for (const c of cards) {
    const ref = c.referenceImages[0]
    if (ref) return ref.previewUrl ?? ref.src
  }
  return null
}

export function summarizeProject(
  projectId: string,
  boards: readonly VideoWorkbenchBoard[],
  cards: readonly VideoWorkbenchCard[],
): ProjectStats {
  const own = boards.filter((b) => b.projectId === projectId).sort((a, b) => a.order - b.order)
  const segments = own.map((board) => {
    const bc = cards.filter((c) => c.boardId === board.id).sort((a, b) => a.order - b.order)
    return { board, stats: summarizeBoard(bc), cover: pickCover(bc) }
  })
  const ownBoardIds = new Set(own.map((b) => b.id))
  const ownCards = cards.filter((c) => c.boardId && ownBoardIds.has(c.boardId))
  const totals = summarizeBoard(ownCards)
  return {
    segments,
    totals,
    donePercent: totals.total === 0 ? 0 : Math.round((totals.done / totals.total) * 100),
    cover: pickCover(ownCards),
  }
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
```

> `posterUrl`:按 Step 1 的注意事项对齐真实字段名;`CostSummary` 若 `pricing.ts` 没有导出该类型名,改成 `ReturnType<typeof summarizeCostUsd>`。

- [ ] **Step 5: 运行通过**

Run: `pnpm exec vitest run src/renderer/src/features/video-workbench/__tests__/projectStats.test.ts`
Expected: PASS(7 tests)。`pnpm typecheck` 会因 `projectId` 必填在 `store.ts` / `cardSpec.ts` / 测试里报「缺少属性」——这是预期,Task 3 收口;先记下错误数,Task 3 结束时必须回到基线。

- [ ] **Step 6: Commit**

```bash
git add src/types/videoWorkbench.ts src/renderer/src/features/video-workbench/projectStats.ts src/renderer/src/features/video-workbench/__tests__/projectStats.test.ts
git commit -m "feat(workbench): project type + segment/project stats pure functions"
```

---

### Task 2: WorkbenchDb v3 —— projects store、索引、升级迁移

**Files:**
- Modify: `src/renderer/src/features/video-workbench/WorkbenchDb.ts`
- Test: `src/renderer/src/features/video-workbench/__tests__/WorkbenchDb.upgrade.test.ts`(新)
- devDependency: `fake-indexeddb`

**Interfaces:**
- Produces: `WorkbenchDb.putProject(p)`, `removeProject(id)`, `listProjects()`;`export function assignDefaultProject(boards): { boards; changed: boolean }`;常量 `PROJECT_STORE = 'projects'`。
- 升级后的不变量:每个 board 都有 `projectId`;`projects` 里存在 `DEFAULT_PROJECT_ID`(仅当升级前有 board 或库为空时才需要——空库也建,简单一致)。

- [ ] **Step 1: 安装 fake-indexeddb**

Run: `pnpm add -D fake-indexeddb`
Expected: `package.json` devDependencies 出现 `fake-indexeddb`。

- [ ] **Step 2: 写失败测试**

```ts
// src/renderer/src/features/video-workbench/__tests__/WorkbenchDb.upgrade.test.ts
// v2 → v3 升级:老 board 归入默认项目;projects store 与索引就位;幂等。
// 用 fake-indexeddb 在 jsdom 里提供真 IndexedDB;每个用例新建独立数据库实例。
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_PROJECT_ID } from '../../../../types/videoWorkbench'
import { assignDefaultProject, getWorkbenchDb, resetWorkbenchDbForTest } from '../WorkbenchDb'

const DB_NAME = 'catimation-video-workbench'

/** 手工造一个 v2 库:cards + boards 两个 store,boards 没有 projectId。 */
function seedV2(boards: Array<{ id: string; name: string; order: number }>): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2)
    req.onupgradeneeded = () => {
      const db = req.result
      db.createObjectStore('cards', { keyPath: 'id' }).createIndex('order', 'order')
      db.createObjectStore('boards', { keyPath: 'id' })
    }
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction('boards', 'readwrite')
      for (const b of boards) tx.objectStore('boards').put({ ...b, createdAt: 1 })
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = () => reject(tx.error)
    }
    req.onerror = () => reject(req.error)
  })
}

function openRaw(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

beforeEach(() => {
  // 每个用例一个全新的 IndexedDB 世界
  ;(globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  resetWorkbenchDbForTest()
})

describe('assignDefaultProject(纯函数)', () => {
  it('缺 projectId 的补默认项目,已有的不动,并报告是否有改动', () => {
    const r = assignDefaultProject([
      { id: 'a', name: 'A', order: 0, createdAt: 1 } as never,
      { id: 'b', name: 'B', order: 1, createdAt: 1, projectId: 'p9' },
    ])
    expect(r.changed).toBe(true)
    expect(r.boards.map((b) => b.projectId)).toEqual([DEFAULT_PROJECT_ID, 'p9'])
    expect(assignDefaultProject(r.boards).changed).toBe(false)
  })
})

describe('v2 → v3', () => {
  it('老 board 全部归入默认项目,projects 里有默认项目', async () => {
    await seedV2([{ id: 'b1', name: '页面 1', order: 0 }, { id: 'b2', name: '页面 2', order: 1 }])
    const db = getWorkbenchDb()
    const boards = await db.listBoards()
    expect(boards.map((b) => b.projectId)).toEqual([DEFAULT_PROJECT_ID, DEFAULT_PROJECT_ID])
    const projects = await db.listProjects()
    expect(projects).toHaveLength(1)
    expect(projects[0]).toMatchObject({ id: DEFAULT_PROJECT_ID, name: '默认项目', legacy: true })
  })

  it('索引与 store 就位', async () => {
    await seedV2([])
    await getWorkbenchDb().listProjects()
    const raw = await openRaw()
    expect(raw.version).toBe(3)
    expect(Array.from(raw.objectStoreNames)).toEqual(expect.arrayContaining(['cards', 'boards', 'projects']))
    expect(raw.transaction('boards').objectStore('boards').indexNames.contains('by-project')).toBe(true)
    expect(raw.transaction('cards').objectStore('cards').indexNames.contains('by-board')).toBe(true)
    raw.close()
  })

  it('全新库直接建 v3,也带默认项目', async () => {
    const projects = await getWorkbenchDb().listProjects()
    expect(projects.map((p) => p.id)).toEqual([DEFAULT_PROJECT_ID])
  })

  it('putProject / removeProject 往返', async () => {
    const db = getWorkbenchDb()
    await db.putProject({ id: 'p1', name: '追车戏', order: 1, createdAt: 1, updatedAt: 1 })
    expect((await db.listProjects()).map((p) => p.id)).toEqual([DEFAULT_PROJECT_ID, 'p1'])
    await db.removeProject('p1')
    expect((await db.listProjects()).map((p) => p.id)).toEqual([DEFAULT_PROJECT_ID])
  })
})
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm exec vitest run src/renderer/src/features/video-workbench/__tests__/WorkbenchDb.upgrade.test.ts`
Expected: FAIL — `assignDefaultProject` / `listProjects` 不存在。

- [ ] **Step 4: 实现**

在 `WorkbenchDb.ts` 里:

1. 顶部 import 加 `DEFAULT_PROJECT_ID, DEFAULT_PROJECT_NAME, type VideoWorkbenchProject`。
2. 常量:`DB_VERSION = 3`,`const PROJECT_STORE = 'projects'`。把 v2 那行注释改为「v3:projects store + boards.by-project / cards.by-board 索引;升级时老 board 归入默认项目」。
3. 类上加 `private memoryProjects = new Map<string, VideoWorkbenchProject>()`。
4. 导出纯函数(放在类之前):

```ts
export function defaultProject(now = Date.now()): VideoWorkbenchProject {
  return { id: DEFAULT_PROJECT_ID, name: DEFAULT_PROJECT_NAME, order: 0, createdAt: now, updatedAt: now, legacy: true }
}

/** 缺 projectId 的 board 归入默认项目。纯函数,升级与水合两处共用。 */
export function assignDefaultProject(
  boards: readonly VideoWorkbenchBoard[],
): { boards: VideoWorkbenchBoard[]; changed: boolean } {
  let changed = false
  const next = boards.map((b) => {
    if (b.projectId) return b
    changed = true
    return { ...b, projectId: DEFAULT_PROJECT_ID }
  })
  return { boards: next, changed }
}
```

5. 替换 `req.onupgradeneeded`:

```ts
        req.onupgradeneeded = (ev) => {
          const db = req.result
          // 升级事务:给已有 store 加索引只能通过它取 store(MDN:索引只在 versionchange 里建)
          const tx = req.transaction!
          if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE, { keyPath: 'id' }).createIndex('order', 'order')
          }
          if (!db.objectStoreNames.contains(BOARD_STORE)) {
            db.createObjectStore(BOARD_STORE, { keyPath: 'id' })
          }
          if (!db.objectStoreNames.contains(PROJECT_STORE)) {
            db.createObjectStore(PROJECT_STORE, { keyPath: 'id' })
          }
          const boards = tx.objectStore(BOARD_STORE)
          if (!boards.indexNames.contains('by-project')) boards.createIndex('by-project', 'projectId')
          const cards = tx.objectStore(STORE)
          if (!cards.indexNames.contains('by-board')) cards.createIndex('by-board', 'boardId')

          if (ev.oldVersion < 3) {
            // 老 board 归入默认项目;默认项目不存在则建。都在同一个升级事务里,原子。
            tx.objectStore(PROJECT_STORE).put(defaultProject())
            const cursorReq = boards.openCursor()
            cursorReq.onsuccess = () => {
              const cursor = cursorReq.result
              if (!cursor) return
              const b = cursor.value as VideoWorkbenchBoard
              if (!b.projectId) cursor.update({ ...b, projectId: DEFAULT_PROJECT_ID })
              cursor.continue()
            }
          }
        }
        req.onblocked = () => {
          console.warn('[WorkbenchDb] 升级被其它连接阻塞,请重启应用')
        }
```

6. 类尾部加:

```ts
  // ==================== 「剧」(project) ====================

  async putProject(project: VideoWorkbenchProject): Promise<void> {
    const db = await this.openDb()
    if (!db) {
      this.memoryProjects.set(project.id, project)
      return
    }
    await this.request(this.tx(db, 'readwrite', PROJECT_STORE).put(project))
  }

  async removeProject(id: string): Promise<void> {
    const db = await this.openDb()
    if (!db) {
      this.memoryProjects.delete(id)
      return
    }
    await this.request(this.tx(db, 'readwrite', PROJECT_STORE).delete(id))
  }

  /** 全部剧,按 order 升序。内存降级模式下若为空则返回一个默认项目(与 v3 库一致)。 */
  async listProjects(): Promise<VideoWorkbenchProject[]> {
    const db = await this.openDb()
    if (!db) {
      if (this.memoryProjects.size === 0) this.memoryProjects.set(DEFAULT_PROJECT_ID, defaultProject())
      return [...this.memoryProjects.values()].sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)
    }
    const items = await this.request<VideoWorkbenchProject[]>(this.tx(db, 'readonly', PROJECT_STORE).getAll())
    return items.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)
  }
```

7. `listBoards()` 返回前套一层 `assignDefaultProject(items).boards`(读到的老数据在内存里立刻合法;写回由 store 的 hydrate 负责)。

- [ ] **Step 5: 运行通过**

Run: `pnpm exec vitest run src/renderer/src/features/video-workbench/__tests__/WorkbenchDb.upgrade.test.ts`
Expected: PASS(5 tests)。再跑 `pnpm exec vitest run src/renderer/src/features/video-workbench/__tests__/storeBoards.test.ts` 确认既有 board 测试仍绿(jsdom 下走内存降级)。

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/renderer/src/features/video-workbench/WorkbenchDb.ts src/renderer/src/features/video-workbench/__tests__/WorkbenchDb.upgrade.test.ts
git commit -m "feat(workbench): IndexedDB v3 — projects store, indexes, migrate boards into default project"
```

---

### Task 3: projects slice + store 接线(水合、addBoard/removeBoard/switchBoard 感知剧)

**Files:**
- Create: `src/renderer/src/features/video-workbench/projects.ts`
- Modify: `src/renderer/src/features/video-workbench/store.ts`(`VideoWorkbenchState` 接口 319 行起;`nextBoardName` 768;`initialBoard` 1047;`create()` 1049;`ensureHydrated` 1082;`addBoard` 1163;`switchBoard` 1187;`removeBoard` 1283;`resetWorkbenchStoreForTest` 2323)
- Modify: `src/renderer/src/features/video-workbench/cardSpec.ts:267`(`createDefaultBoard` 加 `projectId`)
- Test: `src/renderer/src/features/video-workbench/__tests__/storeProjects.test.ts`(新)

**Interfaces:**
- Consumes: Task 1 类型与常量;Task 2 `getWorkbenchDb().putProject/removeProject/listProjects`、`assignDefaultProject`、`defaultProject`。
- Produces(后续任务依赖的精确签名):

```ts
export type WorkbenchViewMode = 'overview' | 'board'
export interface ProjectView { mode: WorkbenchViewMode; boardId?: string }
export interface ProjectsSlice {
  projects: VideoWorkbenchProject[]
  activeProjectId: string
  viewByProject: Record<string, ProjectView>
  railCollapsed: boolean
  addProject: (name?: string) => string
  renameProject: (id: string, name: string) => boolean
  reorderProjects: (ids: string[]) => boolean
  switchProject: (id: string) => void
  openOverview: () => void
  openBoard: (boardId: string) => void
  moveBoardToProject: (boardId: string, projectId: string) => boolean
  duplicateProject: (id: string) => string | null
  removeProject: (id: string) => { ok: boolean; reason?: string }
  dismissLegacyNotice: (id: string) => void
  setRailCollapsed: (collapsed: boolean) => void
}
export const ACTIVE_PROJECT_KEY = 'vw-active-project'
export const RAIL_COLLAPSED_KEY = 'vw-rail-collapsed'
export function nextProjectName(projects: readonly VideoWorkbenchProject[]): string   // 「未命名剧 N」
export function nextSegmentName(boards: readonly VideoWorkbenchBoard[]): string       // 「分段 N」(同剧内)
```

- [ ] **Step 1: 写失败测试**

```ts
// src/renderer/src/features/video-workbench/__tests__/storeProjects.test.ts
// 剧(project)层:默认项目、新建/切换/改名/删除、分段归属、跨剧移动、水合回填、隔离。
// jsdom 无 IndexedDB → WorkbenchDb 内存降级;每个用例 reset store + db。
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_PROJECT_ID } from '../../../../types/videoWorkbench'
import { ACTIVE_PROJECT_KEY } from '../projects'
import { ACTIVE_BOARD_KEY, resetWorkbenchStoreForTest, useVideoWorkbenchStore } from '../store'
import { getWorkbenchDb, resetWorkbenchDbForTest } from '../WorkbenchDb'

const S = () => useVideoWorkbenchStore.getState()
const boardsOf = (projectId: string) => S().boards.filter((b) => b.projectId === projectId)

beforeEach(() => {
  localStorage.removeItem(ACTIVE_BOARD_KEY)
  localStorage.removeItem(ACTIVE_PROJECT_KEY)
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
  delete (window as any).electronAPI
})

describe('初始与默认项目', () => {
  it('初始有默认项目,初始页归它,视图为分段页', () => {
    expect(S().projects.map((p) => p.id)).toEqual([DEFAULT_PROJECT_ID])
    expect(S().activeProjectId).toBe(DEFAULT_PROJECT_ID)
    expect(S().boards[0].projectId).toBe(DEFAULT_PROJECT_ID)
    expect(S().viewByProject[DEFAULT_PROJECT_ID]?.mode ?? 'board').toBe('board')
  })
})

describe('addProject / switchProject', () => {
  it('新建剧自带「分段 1」、切过去、停在总览、活动页指向新分段', () => {
    const before = S().revision
    const id = S().addProject()
    const p = S().projects.find((x) => x.id === id)!
    expect(p.name).toBe('未命名剧 2')
    expect(S().activeProjectId).toBe(id)
    expect(boardsOf(id).map((b) => b.name)).toEqual(['分段 1'])
    expect(S().activeBoardId).toBe(boardsOf(id)[0].id)
    expect(S().viewByProject[id]).toEqual({ mode: 'overview' })
    expect(S().revision).toBe(before + 1)
    expect(localStorage.getItem(ACTIVE_PROJECT_KEY)).toBe(id)
  })

  it('切回旧剧恢复它上次的视图与分段', () => {
    const p1 = S().activeProjectId
    const b1 = S().activeBoardId
    S().openBoard(b1)
    const p2 = S().addProject('第二部')
    S().switchProject(p1)
    expect(S().activeProjectId).toBe(p1)
    expect(S().activeBoardId).toBe(b1)
    expect(S().viewByProject[p1]).toEqual({ mode: 'board', boardId: b1 })
    S().switchProject(p2)
    expect(S().viewByProject[p2]).toEqual({ mode: 'overview' })
  })

  it('addCards 落在当前剧的活动分段,别的剧看不到', () => {
    const p1 = S().activeProjectId
    S().addCards([{ prompt: 'A' }])
    const p2 = S().addProject()
    S().addCards([{ prompt: 'B' }])
    const cardsOf = (pid: string) => {
      const ids = new Set(boardsOf(pid).map((b) => b.id))
      return S().cards.filter((c) => c.boardId && ids.has(c.boardId)).map((c) => c.prompt)
    }
    expect(cardsOf(p1)).toEqual(['A'])
    expect(cardsOf(p2)).toEqual(['B'])
  })
})

describe('addBoard / removeBoard 在剧内', () => {
  it('addBoard 归当前剧,命名「分段 N」按剧内计数;删到本剧仅剩一段时拒绝', () => {
    const p2 = S().addProject()
    const b = S().addBoard()
    expect(S().boards.find((x) => x.id === b)!.projectId).toBe(p2)
    expect(boardsOf(p2).map((x) => x.name)).toEqual(['分段 1', '分段 2'])
    expect(S().removeBoard(b)).toBe(true)
    expect(S().removeBoard(boardsOf(p2)[0].id)).toBe(false)
    // 默认项目那边还是可以有一页,不受影响
    expect(boardsOf(DEFAULT_PROJECT_ID)).toHaveLength(1)
  })

  it('switchBoard 到别的剧的分段会把当前剧也切过去', () => {
    const p1 = S().activeProjectId
    const b1 = S().activeBoardId
    S().addProject()
    S().switchBoard(b1)
    expect(S().activeProjectId).toBe(p1)
    expect(S().viewByProject[p1]).toEqual({ mode: 'board', boardId: b1 })
  })
})

describe('moveBoardToProject / renameProject / reorderProjects', () => {
  it('分段搬到另一部剧后 order 两边各自压实,源剧若空出则拒绝', () => {
    const p1 = S().activeProjectId
    const b1a = S().activeBoardId
    const b1b = S().addBoard()
    const p2 = S().addProject()
    expect(S().moveBoardToProject(b1b, p2)).toBe(true)
    expect(boardsOf(p1).map((b) => b.id)).toEqual([b1a])
    expect(boardsOf(p2).map((b) => b.order)).toEqual([0, 1])
    // p1 只剩一段,再搬就会空出 → 拒绝
    expect(S().moveBoardToProject(b1a, p2)).toBe(false)
  })

  it('改名 trim 后为空拒绝;同名不涨版本;reorder 要给全集', () => {
    const p1 = S().activeProjectId
    const p2 = S().addProject()
    expect(S().renameProject(p1, '   ')).toBe(false)
    const rev = S().revision
    expect(S().renameProject(p1, S().projects[0].name)).toBe(true)
    expect(S().revision).toBe(rev)
    expect(S().reorderProjects([p2])).toBe(false)
    expect(S().reorderProjects([p2, p1])).toBe(true)
    expect(S().projects.map((p) => p.id)).toEqual([p2, p1])
    expect(S().projects.map((p) => p.order)).toEqual([0, 1])
  })
})

describe('removeProject', () => {
  it('删剧连带分段和卡片;唯一一部剧拒删;有生成中卡片拒删', async () => {
    const p1 = S().activeProjectId
    expect(S().removeProject(p1).ok).toBe(false)
    const p2 = S().addProject()
    S().addCards([{ prompt: 'x' }])
    const cardId = S().cards.find((c) => c.prompt === 'x')!.id
    useVideoWorkbenchStore.setState((s) => ({
      cards: s.cards.map((c) => (c.id === cardId ? { ...c, status: 'running', taskId: 't' } : c)),
    }))
    expect(S().removeProject(p2)).toMatchObject({ ok: false })
    useVideoWorkbenchStore.setState((s) => ({
      cards: s.cards.map((c) => (c.id === cardId ? { ...c, status: 'succeeded' } : c)),
    }))
    expect(S().removeProject(p2).ok).toBe(true)
    expect(S().projects.map((p) => p.id)).toEqual([p1])
    expect(boardsOf(p2)).toHaveLength(0)
    expect(S().cards.some((c) => c.id === cardId)).toBe(false)
    expect(S().activeProjectId).toBe(p1)
    expect((await getWorkbenchDb().listProjects()).map((p) => p.id)).toEqual([p1])
  })
})

describe('水合回填', () => {
  it('库里的老 board 没有 projectId → 归默认项目并写回;activeProjectId 从 localStorage 恢复', async () => {
    const db = getWorkbenchDb()
    await db.putBoard({ id: 'old-1', name: '页面 1', order: 0, createdAt: 1 } as never)
    await db.putBoard({ id: 'old-2', name: '页面 2', order: 1, createdAt: 2 } as never)
    await db.putProject({ id: 'p9', name: '别的剧', order: 1, createdAt: 1, updatedAt: 1 })
    await db.putBoard({ id: 'b9', name: '分段 1', order: 0, createdAt: 3, projectId: 'p9' })
    localStorage.setItem(ACTIVE_PROJECT_KEY, 'p9')
    resetWorkbenchStoreForTest()
    await S().ensureHydrated()
    expect(boardsOf(DEFAULT_PROJECT_ID).map((b) => b.id)).toEqual(['old-1', 'old-2'])
    expect(S().activeProjectId).toBe('p9')
    expect(S().activeBoardId).toBe('b9')
    expect((await db.listBoards()).every((b) => b.projectId)).toBe(true)
  })

  it('localStorage 里的剧不存在 → 回第一部剧', async () => {
    localStorage.setItem(ACTIVE_PROJECT_KEY, 'ghost')
    await S().ensureHydrated()
    expect(S().activeProjectId).toBe(DEFAULT_PROJECT_ID)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run src/renderer/src/features/video-workbench/__tests__/storeProjects.test.ts`
Expected: FAIL — `../projects` 不存在。

- [ ] **Step 3: 写 projects.ts(slice)**

```ts
// src/renderer/src/features/video-workbench/projects.ts
/**
 * 「剧」(project)slice —— zustand slices 模式,合并进 useVideoWorkbenchStore。
 *
 * 这里只管剧的集合、当前剧、每部剧记住的视图;分段/卡片本体仍在 store.ts。
 * 通过 get() 读 boards / cards 做过滤,不复制数据。
 */
import type { StateCreator } from 'zustand'
import type { VideoWorkbenchBoard, VideoWorkbenchProject } from '../../../../types/videoWorkbench'
import { createId, isActiveStatus } from './cardSpec'
import type { VideoWorkbenchState } from './store'
import { getWorkbenchDb } from './WorkbenchDb'

export type WorkbenchViewMode = 'overview' | 'board'
export interface ProjectView { mode: WorkbenchViewMode; boardId?: string }

export interface ProjectsSlice {
  projects: VideoWorkbenchProject[]
  activeProjectId: string
  /** 每部剧上次停在总览还是哪个分段。纯 UI 状态,不进撤销栈。 */
  viewByProject: Record<string, ProjectView>
  railCollapsed: boolean
  /** 新建剧(自带「分段 1」),切过去并停在总览。返回剧 id。 */
  addProject: (name?: string) => string
  renameProject: (id: string, name: string) => boolean
  /** 整体重排,必须给出全集(同 reorderCards)。 */
  reorderProjects: (ids: string[]) => boolean
  switchProject: (id: string) => void
  openOverview: () => void
  /** 打开当前剧的某个分段;不属于当前剧则先切剧。 */
  openBoard: (boardId: string) => void
  /** 把分段搬到另一部剧;源剧会空出、目标不存在、分段不存在 → false。 */
  moveBoardToProject: (boardId: string, projectId: string) => boolean
  /** 深拷贝一部剧(分段 + 卡片,新 id;排队/生成中的卡重置为草稿)。返回新剧 id。 */
  duplicateProject: (id: string) => string | null
  /** 唯一一部剧、或有生成中卡片 → 拒绝。 */
  removeProject: (id: string) => { ok: boolean; reason?: string }
  dismissLegacyNotice: (id: string) => void
  setRailCollapsed: (collapsed: boolean) => void
}

export const ACTIVE_PROJECT_KEY = 'vw-active-project'
export const RAIL_COLLAPSED_KEY = 'vw-rail-collapsed'

export function nextProjectName(projects: readonly VideoWorkbenchProject[]): string {
  const taken = new Set(projects.map((p) => p.name))
  let n = projects.length + 1
  while (taken.has(`未命名剧 ${n}`)) n += 1
  return `未命名剧 ${n}`
}

/** 同一部剧内的「分段 N」;传入的 boards 必须已按剧过滤。 */
export function nextSegmentName(boards: readonly VideoWorkbenchBoard[]): string {
  const taken = new Set(boards.map((b) => b.name))
  let n = boards.length + 1
  while (taken.has(`分段 ${n}`)) n += 1
  return `分段 ${n}`
}

export function writeActiveProject(id: string): void {
  try {
    globalThis.localStorage?.setItem(ACTIVE_PROJECT_KEY, id)
  } catch {
    // localStorage 不可用时仅内存生效
  }
}

export function readRailCollapsed(): boolean {
  try {
    return globalThis.localStorage?.getItem(RAIL_COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

/** 一部剧下的第一个分段(按 order);没有则 undefined。 */
export function firstBoardOf(boards: readonly VideoWorkbenchBoard[], projectId: string): VideoWorkbenchBoard | undefined {
  return boards.filter((b) => b.projectId === projectId).sort((a, b) => a.order - b.order)[0]
}

function compactOrders<T extends { order: number }>(items: T[]): T[] {
  return items.map((it, i) => (it.order === i ? it : { ...it, order: i }))
}

export const createProjectsSlice: StateCreator<VideoWorkbenchState, [], [], ProjectsSlice> = (set, get) => ({
  projects: [],
  activeProjectId: '',
  viewByProject: {},
  railCollapsed: readRailCollapsed(),

  addProject: (name) => {
    const now = Date.now()
    const { projects, boards } = get()
    const project: VideoWorkbenchProject = {
      id: createId(),
      name: name?.trim() || nextProjectName(projects),
      order: projects.length,
      createdAt: now,
      updatedAt: now,
    }
    const board: VideoWorkbenchBoard = { id: createId(), projectId: project.id, name: '分段 1', order: 0, createdAt: now }
    set((s) => ({
      projects: [...s.projects, project],
      boards: [...s.boards, board],
      activeProjectId: project.id,
      activeBoardId: board.id,
      viewByProject: { ...s.viewByProject, [project.id]: { mode: 'overview' } },
      selectedCardIds: [],
      selectionAnchorId: undefined,
      revision: s.revision + 1,
      structureRevision: s.structureRevision + 1,
    }))
    writeActiveProject(project.id)
    const db = getWorkbenchDb()
    void db.putProject(project).catch(() => {})
    void db.putBoard(board).catch(() => {})
    void boards // 仅为 lint:boards 在这里没用到
    return project.id
  },

  renameProject: (id, name) => {
    const trimmed = name.trim()
    if (!trimmed) return false
    const cur = get().projects.find((p) => p.id === id)
    if (!cur) return false
    if (cur.name === trimmed) return true
    const { legacy: _drop, ...rest } = cur
    const next: VideoWorkbenchProject = { ...rest, name: trimmed, updatedAt: Date.now() }
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? next : p)),
      revision: s.revision + 1,
      structureRevision: s.structureRevision + 1,
    }))
    void getWorkbenchDb().putProject(next).catch(() => {})
    return true
  },

  reorderProjects: (ids) => {
    const cur = get().projects
    if (ids.length !== cur.length || new Set(ids).size !== ids.length) return false
    const byId = new Map(cur.map((p) => [p.id, p]))
    if (!ids.every((id) => byId.has(id))) return false
    if (ids.every((id, i) => cur[i]?.id === id)) return true
    const next = compactOrders(ids.map((id) => byId.get(id)!))
    set((s) => ({ projects: next, revision: s.revision + 1, structureRevision: s.structureRevision + 1 }))
    const db = getWorkbenchDb()
    for (const p of next) void db.putProject(p).catch(() => {})
    return true
  },

  switchProject: (id) => {
    const { projects, boards, viewByProject } = get()
    if (!projects.some((p) => p.id === id)) return
    const view = viewByProject[id]
    const remembered = view?.boardId && boards.some((b) => b.id === view.boardId && b.projectId === id)
      ? view.boardId
      : firstBoardOf(boards, id)?.id
    set({
      activeProjectId: id,
      ...(remembered ? { activeBoardId: remembered } : {}),
      viewByProject: { ...viewByProject, [id]: view ?? { mode: 'overview' } },
      selectedCardIds: [],
      selectionAnchorId: undefined,
    })
    writeActiveProject(id)
  },

  openOverview: () => {
    const id = get().activeProjectId
    set((s) => ({ viewByProject: { ...s.viewByProject, [id]: { mode: 'overview' } }, selectedCardIds: [], selectionAnchorId: undefined }))
  },

  openBoard: (boardId) => {
    const board = get().boards.find((b) => b.id === boardId)
    if (!board) return
    set((s) => ({
      activeProjectId: board.projectId,
      activeBoardId: boardId,
      viewByProject: { ...s.viewByProject, [board.projectId]: { mode: 'board', boardId } },
      selectedCardIds: [],
      selectionAnchorId: undefined,
    }))
    writeActiveProject(board.projectId)
  },

  moveBoardToProject: (boardId, projectId) => {
    const { boards, projects, activeBoardId } = get()
    const board = boards.find((b) => b.id === boardId)
    if (!board || board.projectId === projectId || !projects.some((p) => p.id === projectId)) return false
    const sourceRest = boards.filter((b) => b.projectId === board.projectId && b.id !== boardId)
    if (sourceRest.length === 0) return false // 源剧不能空出(每部剧至少一段)
    const targetCount = boards.filter((b) => b.projectId === projectId).length
    const moved: VideoWorkbenchBoard = { ...board, projectId, order: targetCount }
    const sourceCompacted = compactOrders(sourceRest.sort((a, b) => a.order - b.order))
    const changed = new Map<string, VideoWorkbenchBoard>([[moved.id, moved], ...sourceCompacted.map((b) => [b.id, b] as const)])
    set((s) => ({
      boards: s.boards.map((b) => changed.get(b.id) ?? b),
      ...(activeBoardId === boardId ? { activeBoardId: sourceCompacted[0].id, viewByProject: { ...s.viewByProject, [board.projectId]: { mode: 'overview' } } } : {}),
      selectedCardIds: [],
      selectionAnchorId: undefined,
      revision: s.revision + 1,
      structureRevision: s.structureRevision + 1,
    }))
    const db = getWorkbenchDb()
    for (const b of changed.values()) void db.putBoard(b).catch(() => {})
    return true
  },

  duplicateProject: (id) => {
    const { projects, boards, cards } = get()
    const src = projects.find((p) => p.id === id)
    if (!src) return null
    const now = Date.now()
    const { legacy: _drop, ...srcRest } = src
    const project: VideoWorkbenchProject = { ...srcRest, id: createId(), name: `${src.name} 副本`, order: projects.length, createdAt: now, updatedAt: now }
    const boardIdMap = new Map<string, string>()
    const newBoards = boards
      .filter((b) => b.projectId === id)
      .map((b) => {
        const nid = createId()
        boardIdMap.set(b.id, nid)
        return { ...b, id: nid, projectId: project.id, createdAt: now }
      })
    const newCards = cards
      .filter((c) => c.boardId && boardIdMap.has(c.boardId))
      .map((c) => ({
        ...c,
        id: createId(),
        boardId: boardIdMap.get(c.boardId!)!,
        clientId: undefined,
        ...(isActiveStatus(c.status) ? { status: 'draft' as const, taskId: undefined, error: undefined } : {}),
        createdAt: now,
        updatedAt: now,
      }))
    set((s) => ({
      projects: [...s.projects, project],
      boards: [...s.boards, ...newBoards],
      cards: [...s.cards, ...newCards],
      revision: s.revision + 1,
      structureRevision: s.structureRevision + 1,
    }))
    const db = getWorkbenchDb()
    void db.putProject(project).catch(() => {})
    for (const b of newBoards) void db.putBoard(b).catch(() => {})
    for (const c of newCards) void db.put(c).catch(() => {})
    return project.id
  },

  removeProject: (id) => {
    const { projects, boards, cards, activeProjectId } = get()
    if (!projects.some((p) => p.id === id)) return { ok: false, reason: '剧不存在' }
    if (projects.length <= 1) return { ok: false, reason: '至少保留一部剧' }
    const boardIds = new Set(boards.filter((b) => b.projectId === id).map((b) => b.id))
    const own = cards.filter((c) => c.boardId && boardIds.has(c.boardId))
    if (own.some((c) => isActiveStatus(c.status))) return { ok: false, reason: '这部剧有卡片正在生成,请先取消' }
    const nextProjects = compactOrders(projects.filter((p) => p.id !== id))
    const nextBoards = boards.filter((b) => !boardIds.has(b.id))
    const nextActive = activeProjectId === id ? nextProjects[0].id : activeProjectId
    const nextActiveBoard = activeProjectId === id ? firstBoardOf(nextBoards, nextActive)?.id : undefined
    set((s) => {
      const { [id]: _drop, ...restViews } = s.viewByProject
      return {
        projects: nextProjects,
        boards: nextBoards,
        cards: s.cards.filter((c) => !(c.boardId && boardIds.has(c.boardId))),
        activeProjectId: nextActive,
        ...(nextActiveBoard ? { activeBoardId: nextActiveBoard } : {}),
        viewByProject: restViews,
        selectedCardIds: [],
        selectionAnchorId: undefined,
        revision: s.revision + 1,
        structureRevision: s.structureRevision + 1,
      }
    })
    writeActiveProject(nextActive)
    const db = getWorkbenchDb()
    void db.removeProject(id).catch(() => {})
    for (const p of nextProjects) void db.putProject(p).catch(() => {})
    for (const bid of boardIds) void db.removeBoard(bid).catch(() => {})
    for (const c of own) void db.remove(c.id).catch(() => {})
    return { ok: true }
  },

  dismissLegacyNotice: (id) => {
    const cur = get().projects.find((p) => p.id === id)
    if (!cur?.legacy) return
    const { legacy: _drop, ...next } = cur
    set((s) => ({ projects: s.projects.map((p) => (p.id === id ? next : p)) }))
    void getWorkbenchDb().putProject(next).catch(() => {})
  },

  setRailCollapsed: (collapsed) => {
    set({ railCollapsed: collapsed })
    try {
      globalThis.localStorage?.setItem(RAIL_COLLAPSED_KEY, collapsed ? '1' : '0')
    } catch {
      // 仅内存生效
    }
  },
})
```

> `removeProject` 里被删卡片若有防抖持久化定时器,要像 `removeBoard`(store.ts 1304–1311)那样清 `persistTimers`。`persistTimers` 是 store.ts 的模块级 Map —— 在 store.ts 里导出一个 `cancelPendingPersist(cardId)` 函数,slice 里调它,不要把 Map 搬家。

- [ ] **Step 4: 接线 store.ts**

1. `cardSpec.ts:267` `createDefaultBoard`:签名改为 `createDefaultBoard(order = 0, name?: string, projectId = DEFAULT_PROJECT_ID)`,返回值加 `projectId`;顶部 import `DEFAULT_PROJECT_ID`。
2. `store.ts` 顶部:`import { createProjectsSlice, firstBoardOf, nextSegmentName, writeActiveProject, ACTIVE_PROJECT_KEY, type ProjectsSlice } from './projects'`、`import { assignDefaultProject, defaultProject } from './WorkbenchDb'`、`import { DEFAULT_PROJECT_ID, type VideoWorkbenchProject } from '../../../../types/videoWorkbench'`。
3. `export interface VideoWorkbenchState extends ProjectsSlice { ... }`。
4. 导出 `export function cancelPendingPersist(cardId: string): void { const t = persistTimers.get(cardId); if (t) { clearTimeout(t); persistTimers.delete(cardId) } }`,并让 `removeBoard` 也改用它。
5. 删掉 `nextBoardName`(768–773),改用 `nextSegmentName(boards.filter((b) => b.projectId === activeProjectId))`。**老 board 名字不动**,只有新建才叫「分段 N」。
6. `create()` 初始 state:在 `cards: []` 之前展开 slice —— `...createProjectsSlice(set, get, api)`(`create<VideoWorkbenchState>()((set, get, api) => ({ ...createProjectsSlice(set, get, api), cards: [], ... }))`),并把 `projects: [defaultProject()]`、`activeProjectId: DEFAULT_PROJECT_ID`、`viewByProject: { [DEFAULT_PROJECT_ID]: { mode: 'board', boardId: initialBoard.id } }` 写在 slice 展开之后覆盖初值。
7. `addBoard`:

```ts
  addBoard: (name) => {
    const { boards, activeProjectId } = get()
    const own = boards.filter((b) => b.projectId === activeProjectId)
    const trimmed = name?.trim()
    const board: VideoWorkbenchBoard = {
      id: createId(),
      projectId: activeProjectId,
      name: trimmed || nextSegmentName(own),
      order: own.length,
      createdAt: Date.now(),
    }
    set((state) => ({
      boards: [...state.boards, board],
      activeBoardId: board.id,
      viewByProject: { ...state.viewByProject, [activeProjectId]: { mode: 'board', boardId: board.id } },
      selectedCardIds: [],
      selectionAnchorId: undefined,
      revision: state.revision + 1,
      structureRevision: state.structureRevision + 1,
    }))
    writeActiveBoard(board.id)
    void getWorkbenchDb().putBoard(board).catch((e) => {
      console.warn('[VideoWorkbench] 分段持久化失败(忽略):', e)
    })
    return board.id
  },
```

8. `switchBoard`:找到 board 后 `set({ activeBoardId: id, activeProjectId: board.projectId, viewByProject: { ...s.viewByProject, [board.projectId]: { mode: 'board', boardId: id } }, selectedCardIds: [], selectionAnchorId: undefined })`,并 `writeActiveProject(board.projectId)`。
9. `removeBoard`:`const own = state.boards.filter((b) => b.projectId === target.projectId)`;`if (own.length <= 1) return false`;order 压实只在同剧内做;`activeBoardId` 若被删 → 该剧剩余第一段,且 `viewByProject[projectId] = { mode: 'overview' }`。
10. `ensureHydrated`:

```ts
        const [stored, storedBoardsRaw, storedProjects] = await Promise.all([db.list(), db.listBoards(), db.listProjects()])
        // 剧:库里有则以库为准;全新/内存降级时 listProjects 已保证至少有默认项目
        let projects = storedProjects.length > 0 ? storedProjects : [defaultProject()]
        if (storedProjects.length === 0) void db.putProject(projects[0]).catch(() => {})
        // 分段:缺 projectId 的归默认项目并写回;指向不存在的剧的也归默认项目
        const projectIds = new Set(projects.map((p) => p.id))
        let boards = storedBoardsRaw
        if (boards.length === 0) {
          boards = get().boards.map((b) => ({ ...b, projectId: projectIds.has(b.projectId) ? b.projectId : DEFAULT_PROJECT_ID }))
          for (const b of boards) void db.putBoard(b).catch(() => {})
        }
        const assigned = assignDefaultProject(boards)
        boards = assigned.boards.map((b) => (projectIds.has(b.projectId) ? b : { ...b, projectId: DEFAULT_PROJECT_ID }))
        if (!projectIds.has(DEFAULT_PROJECT_ID) && boards.some((b) => b.projectId === DEFAULT_PROJECT_ID)) {
          const dp = defaultProject()
          projects = [dp, ...projects]
          void db.putProject(dp).catch(() => {})
        }
        for (const b of boards) if (b !== storedBoardsRaw.find((x) => x.id === b.id)) void db.putBoard(b).catch(() => {})
        // 每部剧至少一段:没有分段的剧补一段
        for (const p of projects) {
          if (!boards.some((b) => b.projectId === p.id)) {
            const filler: VideoWorkbenchBoard = { id: createId(), projectId: p.id, name: '分段 1', order: 0, createdAt: Date.now() }
            boards = [...boards, filler]
            void db.putBoard(filler).catch(() => {})
          }
        }
```

然后 `firstBoardId` 改为「当前剧的第一段」:先解析 `activeProjectId`(`localStorage[ACTIVE_PROJECT_KEY]` 存在于 `projectIds` 则用,否则 `projects[0].id`),再 `activeBoardId`:`localStorage[ACTIVE_BOARD_KEY]` 若属于当前剧则用,否则 `firstBoardOf(boards, activeProjectId)!.id`。最终 `set` 里带上 `projects, activeProjectId, viewByProject: { ...state.viewByProject, [activeProjectId]: state.viewByProject[activeProjectId] ?? { mode: 'board', boardId: activeBoardId } }`。卡片的 boardId 兜底(1110 行)改为「不在 boardIds 里 → 当前剧第一段」。

11. `resetWorkbenchStoreForTest`(2323):重置时也恢复 `projects: [defaultProject()]`、`activeProjectId: DEFAULT_PROJECT_ID`、`viewByProject`、新的 `initialBoard`(带 `projectId`)。

- [ ] **Step 5: 运行通过 + 回归**

Run: `pnpm exec vitest run src/renderer/src/features/video-workbench/__tests__/storeProjects.test.ts`
Expected: PASS(全部用例)。
Run: `pnpm exec vitest run src/renderer/src/features/video-workbench`
Expected: 既有 `storeBoards` / `store` / `workbenchIR` / `storeHistoryStack` 套件全绿;若某个断言写死了「页面 2」这种新建页名,把期望改成「分段 2」(只改新建命名,不改老数据)。
Run: `pnpm typecheck`
Expected: 错误数回到 Task 1 之前的基线。

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/features/video-workbench/projects.ts src/renderer/src/features/video-workbench/store.ts src/renderer/src/features/video-workbench/cardSpec.ts src/renderer/src/features/video-workbench/__tests__/
git commit -m "feat(workbench): projects slice — add/rename/reorder/switch/move/duplicate/remove, hydrate backfill into default project"
```

---

### Task 4: 撤销快照含剧(removeProject / renameProject 可撤销)

**Files:**
- Modify: `src/renderer/src/features/video-workbench/workbenchHistory.ts:120-180`(`WorkbenchIntent`、`RestorePlan`、`captureIntent`)与 `planRestore`(214 起)
- Modify: `src/renderer/src/features/video-workbench/store.ts`(`undo`/`redo` 里应用 `plan.next` / `plan.persist` 的位置;grep `planRestore(`)
- Test: `src/renderer/src/features/video-workbench/__tests__/workbenchHistory.test.ts`(追加)、`storeHistoryStack.test.ts`(追加)

**Interfaces:**
- `WorkbenchIntent` 新增 `projects: VideoWorkbenchProject[]`、`activeProjectId: string`;`RestorePlan.next` 新增同名两字段;`RestorePlan.persist` 新增 `projects: VideoWorkbenchProject[]`、`removeProjectIds: string[]`。
- 兼容:快照缺 `projects` 时(理论上不会,栈不持久化)视为 `source.projects`。

- [ ] **Step 1: 写失败测试(纯函数)**

在 `workbenchHistory.test.ts` 末尾追加:

```ts
describe('planRestore · 剧', () => {
  const project = (id: string, order: number, name = id) => ({ id, name, order, createdAt: 1, updatedAt: 1 })
  const board = (id: string, projectId: string, order: number) => ({ id, projectId, name: id, order, createdAt: 1 })

  it('快照里有、现在没有的剧被复活,连同它的分段;现在有、快照没有的剧被删', () => {
    const snapshot = {
      projects: [project('p1', 0), project('p2', 1)],
      boards: [board('b1', 'p1', 0), board('b2', 'p2', 0)],
      cards: [],
      activeBoardId: 'b1',
      activeProjectId: 'p2',
    }
    const source = {
      projects: [project('p1', 0), project('p3', 1)],
      boards: [board('b1', 'p1', 0), board('b3', 'p3', 0)],
      cards: [],
      activeBoardId: 'b1',
      activeProjectId: 'p1',
      revision: 5,
      structureRevision: 5,
    }
    const plan = planRestore(source, snapshot)
    expect(plan.result.ok).toBe(true)
    expect(plan.next!.projects.map((p) => p.id)).toEqual(['p1', 'p2'])
    expect(plan.next!.activeProjectId).toBe('p2')
    expect(plan.next!.boards.map((b) => b.id)).toEqual(['b1', 'b2'])
    expect(plan.persist!.projects.map((p) => p.id)).toEqual(['p2'])
    expect(plan.persist!.removeProjectIds).toEqual(['p3'])
    expect(plan.persist!.removeBoardIds).toEqual(['b3'])
  })

  it('剧改名回滚:名字不同的剧进 persist', () => {
    const snapshot = { projects: [project('p1', 0, '旧名')], boards: [board('b1', 'p1', 0)], cards: [], activeBoardId: 'b1', activeProjectId: 'p1' }
    const source = { ...snapshot, projects: [project('p1', 0, '新名')], revision: 1, structureRevision: 1 }
    const plan = planRestore(source, snapshot)
    expect(plan.next!.projects[0].name).toBe('旧名')
    expect(plan.persist!.projects.map((p) => p.name)).toEqual(['旧名'])
  })

  it('快照的 activeProjectId 已不存在于快照 projects → 回第一部', () => {
    const snapshot = { projects: [project('p1', 0)], boards: [board('b1', 'p1', 0)], cards: [], activeBoardId: 'b1', activeProjectId: 'ghost' }
    const source = { ...snapshot, revision: 1, structureRevision: 1 }
    expect(planRestore(source, snapshot).next!.activeProjectId).toBe('p1')
  })
})
```

在 `storeHistoryStack.test.ts` 末尾追加(店面级):

```ts
describe('撤销删剧', () => {
  it('removeProject 后 undo 复活剧、分段、卡片,redo 再删', async () => {
    const S = () => useVideoWorkbenchStore.getState()
    const p2 = S().addProject('第二部')
    S().addCards([{ prompt: 'in-p2' }])
    expect(S().removeProject(p2).ok).toBe(true)
    expect(S().projects.some((p) => p.id === p2)).toBe(false)
    const r = await S().undo()
    expect(r.ok).toBe(true)
    expect(S().projects.some((p) => p.id === p2)).toBe(true)
    expect(S().boards.some((b) => b.projectId === p2)).toBe(true)
    expect(S().cards.some((c) => c.prompt === 'in-p2')).toBe(true)
    await S().redo()
    expect(S().projects.some((p) => p.id === p2)).toBe(false)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run src/renderer/src/features/video-workbench/__tests__/workbenchHistory.test.ts src/renderer/src/features/video-workbench/__tests__/storeHistoryStack.test.ts`
Expected: FAIL — `projects` 不在 `WorkbenchIntent` 上;`plan.next.projects` undefined。

- [ ] **Step 3: 实现**

`workbenchHistory.ts`:

```ts
export interface WorkbenchIntent {
  projects: VideoWorkbenchProject[]
  activeProjectId: string
  boards: VideoWorkbenchBoard[]
  cards: VideoWorkbenchCard[]
  activeBoardId: string
}
```

`RestorePlan.next` 加 `projects: VideoWorkbenchProject[]; activeProjectId: string`;`RestorePlan.persist` 加 `projects: VideoWorkbenchProject[]; removeProjectIds: string[]`。

`captureIntent` 复制 `projects: [...source.projects]`、`activeProjectId: source.activeProjectId`。

`planRestore` 在「页」段之前加「剧」段:

```ts
  // ---- 剧:快照说了算(缺则视为当前),order 重新压实 ----
  const snapProjects = Array.isArray(snapshot.projects) && snapshot.projects.length > 0 ? snapshot.projects : source.projects
  const curProjectById = new Map(source.projects.map((p) => [p.id, p]))
  const finalProjects = [...snapProjects].sort(byOrder).map((p, i) => (p.order === i ? p : { ...p, order: i }))
  const finalProjectIds = new Set(finalProjects.map((p) => p.id))
  const removeProjectIds = source.projects.filter((p) => !finalProjectIds.has(p.id)).map((p) => p.id)
  const projectsToPersist = finalProjects.filter((p) => {
    const cur = curProjectById.get(p.id)
    return !cur || cur.name !== p.name || cur.order !== p.order || cur.legacy !== p.legacy
  })
  const activeProjectId = finalProjectIds.has(snapshot.activeProjectId) ? snapshot.activeProjectId : finalProjects[0].id
```

「页」段里,`finalBoards` 过滤掉 `projectId` 不在 `finalProjectIds` 的 board(快照自洽时不会发生,防御);`boardsToPersist` 的比较加 `cur.projectId !== b.projectId`。`next` 与 `persist` 带上新字段;`activeBoardId` 的解析不变。

`store.ts` 的 `undo` / `redo`(以及任何消费 `plan.persist` 的地方):

```ts
      const db = getWorkbenchDb()
      for (const p of plan.persist.projects) void db.putProject(p).catch(() => {})
      for (const id of plan.persist.removeProjectIds) void db.removeProject(id).catch(() => {})
```

并在 `set(plan.next)` 时把 `viewByProject` 清理成只含仍存在的剧(`Object.fromEntries(Object.entries(s.viewByProject).filter(([id]) => finalIds.has(id)))`),并写 `writeActiveProject(plan.next.activeProjectId)`。撤销栈入栈处 `captureIntent(get())` 自动带上 projects,不需要改。

- [ ] **Step 4: 运行通过 + 回归**

Run: `pnpm exec vitest run src/renderer/src/features/video-workbench`
Expected: 全绿(含 `workbenchIR.test.ts` —— IR 不含 projects,不受影响)。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/features/video-workbench/workbenchHistory.ts src/renderer/src/features/video-workbench/store.ts src/renderer/src/features/video-workbench/__tests__/
git commit -m "feat(workbench): undo/redo snapshots carry projects; removeProject is undoable"
```

---

### Task 5: 剧栏 + 页面两栏布局 + 页签只显示本剧分段

**Files:**
- Create: `src/renderer/src/pages-react/video-workbench/ProjectRail.tsx`
- Modify: `src/renderer/src/pages-react/VideoWorkbenchPage.tsx:139-160`(外层容器与标题行)
- Modify: `src/renderer/src/pages-react/video-workbench/BoardTabs.tsx`(数据源过滤 + 单行滚动 + 面包屑)
- Modify: `src/renderer/src/pages-react/video-workbench/workbench.css`(追加)
- Test: `src/renderer/src/pages-react/video-workbench/__tests__/ProjectRail.test.tsx`(新)、`BoardTabs.test.tsx`(追加)

**Interfaces:**
- Consumes: `useVideoWorkbenchStore` 的 `projects / activeProjectId / boards / cards / railCollapsed / addProject / switchProject / renameProject / removeProject / duplicateProject / setRailCollapsed`;`summarizeProject` / `pickCover` / `formatDuration`。
- Produces: `<ProjectRail onRequestImport?: () => void; onRequestExport?: () => void />`(两个回调本计划里只渲染按钮、`disabled` + title「计划 3 接入」;不要造假实现)。

- [ ] **Step 1: 写失败测试**

```tsx
// src/renderer/src/pages-react/video-workbench/__tests__/ProjectRail.test.tsx
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { resetWorkbenchStoreForTest, useVideoWorkbenchStore } from '../../../features/video-workbench/store'
import { resetWorkbenchDbForTest } from '../../../features/video-workbench/WorkbenchDb'
import { ProjectRail } from '../ProjectRail'

const S = () => useVideoWorkbenchStore.getState()

beforeEach(() => {
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
  localStorage.clear()
})

describe('ProjectRail', () => {
  it('列出全部剧,当前剧带 aria-current,行里有段/镜/花费统计', () => {
    const p2 = S().addProject('追车戏')
    S().addCards([{ prompt: 'a' }, { prompt: 'b' }])
    render(<ProjectRail />)
    const rows = screen.getAllByRole('button', { name: /切换到剧/ })
    expect(rows).toHaveLength(2)
    const active = rows.find((r) => r.getAttribute('aria-current') === 'true')!
    expect(within(active).getByText('追车戏')).toBeInTheDocument()
    expect(within(active).getByText(/1 段 · 2 镜/)).toBeInTheDocument()
    expect(S().activeProjectId).toBe(p2)
  })

  it('点行切剧;点 + 新建并聚焦改名输入框', () => {
    S().addProject('第二部')
    render(<ProjectRail />)
    fireEvent.click(screen.getByRole('button', { name: '切换到剧 默认项目' }))
    expect(S().activeProjectId).toBe('project-default')
    fireEvent.click(screen.getByRole('button', { name: '新建剧' }))
    expect(S().projects).toHaveLength(3)
    expect(document.activeElement).toHaveAttribute('aria-label', '剧名')
  })

  it('有生成中卡片的剧显示黄点计数', () => {
    S().addCards([{ prompt: 'x' }])
    const id = S().cards[0].id
    useVideoWorkbenchStore.setState((s) => ({ cards: s.cards.map((c) => (c.id === id ? { ...c, status: 'running', taskId: 't' } : c)) }))
    render(<ProjectRail />)
    expect(screen.getByTitle('1 镜生成中')).toBeInTheDocument()
  })

  it('折叠后只剩封面,按钮文案变「展开剧栏」', () => {
    render(<ProjectRail />)
    fireEvent.click(screen.getByRole('button', { name: '折叠剧栏' }))
    expect(S().railCollapsed).toBe(true)
    expect(screen.getByRole('button', { name: '展开剧栏' })).toBeInTheDocument()
    expect(screen.queryByText('默认项目')).not.toBeInTheDocument()
  })
})
```

`BoardTabs.test.tsx` 追加:

```tsx
  it('只显示当前剧的分段;面包屑「‹ 总览」回总览', () => {
    const S = () => useVideoWorkbenchStore.getState()
    S().addProject('A 剧')
    const other = S().addBoard('别剧的段')
    S().switchProject('project-default')
    render(<BoardTabs />)
    expect(screen.queryByText('别剧的段')).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /页面 1/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '返回总览' }))
    expect(S().viewByProject['project-default']).toEqual({ mode: 'overview' })
    void other
  })
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run src/renderer/src/pages-react/video-workbench/__tests__/ProjectRail.test.tsx src/renderer/src/pages-react/video-workbench/__tests__/BoardTabs.test.tsx`
Expected: FAIL — `../ProjectRail` 不存在;BoardTabs 仍渲染所有 board。

- [ ] **Step 3: 写 ProjectRail.tsx**

```tsx
// src/renderer/src/pages-react/video-workbench/ProjectRail.tsx
// 左侧「剧栏」:所有剧的常驻列表。行 = 封面 · 名 · 段/镜/花费 · 时间 · 三色条;
// 黄点 = 有卡生成中,红点 = 有失败。当前剧黄色左条。可折叠到 48px。
// 视觉只用 workbench.css 的 .vw-rail-* 类与既有 token。
import { useEffect, useRef, useState } from 'react'
import { formatDuration, summarizeProject } from '../../features/video-workbench/projectStats'
import { formatCostParts } from '../../features/video-workbench/pricing'
import { useVideoWorkbenchStore } from '../../features/video-workbench/store'

function relativeTime(ts: number | null): string {
  if (ts === null) return ''
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60_000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d} 天前`
  return `${Math.floor(d / 7)} 周前`
}

export interface ProjectRailProps {
  onRequestImport?: () => void
  onRequestExport?: () => void
}

export function ProjectRail({ onRequestImport, onRequestExport }: ProjectRailProps) {
  const projects = useVideoWorkbenchStore((s) => s.projects)
  const boards = useVideoWorkbenchStore((s) => s.boards)
  const cards = useVideoWorkbenchStore((s) => s.cards)
  const activeProjectId = useVideoWorkbenchStore((s) => s.activeProjectId)
  const collapsed = useVideoWorkbenchStore((s) => s.railCollapsed)
  const setRailCollapsed = useVideoWorkbenchStore((s) => s.setRailCollapsed)
  const addProject = useVideoWorkbenchStore((s) => s.addProject)
  const switchProject = useVideoWorkbenchStore((s) => s.switchProject)
  const renameProject = useVideoWorkbenchStore((s) => s.renameProject)

  const [query, setQuery] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const nameInputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (editingId) nameInputRef.current?.focus()
  }, [editingId])

  const rows = projects
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((p) => ({ project: p, stats: summarizeProject(p.id, boards, cards) }))
    .filter(({ project }) => !query.trim() || project.name.toLowerCase().includes(query.trim().toLowerCase()))

  const beginRename = (id: string, current: string) => {
    setEditingId(id)
    setDraft(current)
  }
  const commitRename = () => {
    if (editingId) renameProject(editingId, draft)
    setEditingId(null)
  }
  const handleAdd = () => {
    const id = addProject()
    beginRename(id, useVideoWorkbenchStore.getState().projects.find((p) => p.id === id)?.name ?? '')
  }

  return (
    <aside className={`vw-rail ${collapsed ? 'vw-rail-collapsed' : ''}`} aria-label="剧栏">
      <div className="vw-rail-head">
        {!collapsed && <div className="vw-rail-title">SERIES · 剧</div>}
        <button
          type="button"
          className="vw-rail-iconbtn"
          aria-label={collapsed ? '展开剧栏' : '折叠剧栏'}
          title={collapsed ? '展开剧栏' : '折叠剧栏'}
          onClick={() => setRailCollapsed(!collapsed)}
        >
          {collapsed ? '»' : '«'}
        </button>
      </div>
      {!collapsed && (
        <div className="vw-rail-tools">
          <input
            className="vw-rail-search"
            placeholder="搜索剧"
            aria-label="搜索剧"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="button" className="vw-rail-add" aria-label="新建剧" title="新建剧" onClick={handleAdd}>+</button>
        </div>
      )}
      <div className="vw-rail-list" role="list">
        {rows.map(({ project, stats }) => {
          const isActive = project.id === activeProjectId
          const cost = formatCostParts(stats.totals.cost.usd, stats.totals.cost.cny)
          return (
            <div key={project.id} role="listitem" className={`vw-rail-row ${isActive ? 'vw-rail-row-active' : ''}`}>
              <button
                type="button"
                className="vw-rail-rowbtn"
                aria-label={`切换到剧 ${project.name}`}
                aria-current={isActive ? 'true' : undefined}
                title={collapsed ? project.name : undefined}
                onClick={() => switchProject(project.id)}
                onDoubleClick={() => !collapsed && beginRename(project.id, project.name)}
              >
                <div className="vw-rail-cover" aria-hidden="true">
                  {stats.cover ? <img src={stats.cover} alt="" /> : null}
                </div>
                {!collapsed && (
                  <div className="vw-rail-meta">
                    <div className="vw-rail-name">
                      {editingId === project.id ? (
                        <input
                          ref={nameInputRef}
                          aria-label="剧名"
                          className="vw-rail-nameinput"
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onBlur={commitRename}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitRename()
                            if (e.key === 'Escape') setEditingId(null)
                          }}
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (
                        <span>{project.name}</span>
                      )}
                      {stats.totals.active > 0 && (
                        <span className="vw-dot vw-dot-yellow" title={`${stats.totals.active} 镜生成中`}>{stats.totals.active}</span>
                      )}
                      {stats.totals.failed > 0 && (
                        <span className="vw-dot vw-dot-red" title={`${stats.totals.failed} 镜失败`}>{stats.totals.failed}</span>
                      )}
                    </div>
                    <div className="vw-rail-sub">
                      {stats.segments.length} 段 · {stats.totals.total} 镜{cost ? ` · ${cost}` : ''}
                      {stats.totals.doneSeconds > 0 ? ` · ${formatDuration(stats.totals.doneSeconds)}` : ''}
                    </div>
                    <div className="vw-strip" aria-hidden="true">
                      {stats.totals.done > 0 && <div style={{ flex: stats.totals.done, background: '#22c55e' }} />}
                      {stats.totals.active > 0 && <div style={{ flex: stats.totals.active, background: '#FCE300' }} />}
                      {stats.totals.failed > 0 && <div style={{ flex: stats.totals.failed, background: '#f87171' }} />}
                    </div>
                  </div>
                )}
                {!collapsed && <div className="vw-rail-time">{relativeTime(stats.totals.lastActivityAt)}</div>}
              </button>
            </div>
          )
        })}
      </div>
      {!collapsed && (
        <div className="vw-rail-foot">
          <button type="button" className="vw-ghost" disabled={!onRequestImport} title={onRequestImport ? '导入工程' : '导入工程(即将推出)'} onClick={onRequestImport}>导入工程</button>
          <button type="button" className="vw-ghost" disabled={!onRequestExport} title={onRequestExport ? '导出当前剧' : '导出工程(即将推出)'} onClick={onRequestExport}>导出当前剧</button>
        </div>
      )}
    </aside>
  )
}
```

- [ ] **Step 4: 追加 workbench.css**

```css
/* ---------- 剧栏(ProjectRail) ---------- */
.vw-rail { width: 220px; flex: none; display: flex; flex-direction: column; border-right: 1px solid #3f3f46; background: #111113; min-height: 70vh; }
.vw-rail-collapsed { width: 48px; }
.vw-rail-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 10px 8px; }
.vw-rail-title { font-family: 'Orbitron', 'Exo 2', sans-serif; font-size: 10px; letter-spacing: 0.25em; color: #71717a; }
.vw-rail-iconbtn { width: 22px; height: 22px; border: 1px solid #3f3f46; color: #a1a1aa; background: transparent; font-size: 12px; }
.vw-rail-iconbtn:hover { border-color: #fce300; color: #fff; }
.vw-rail-tools { display: flex; gap: 6px; padding: 0 10px 10px; border-bottom: 1px solid #3f3f46; }
.vw-rail-search { flex: 1; height: 28px; background: #09090b; border: 1px solid #3f3f46; color: #fafafa; font-size: 11px; padding: 0 8px; }
.vw-rail-search:focus { outline: none; border-color: #fce300; }
.vw-rail-add { width: 28px; height: 28px; background: #fce300; color: #000; font-weight: 700; font-size: 16px; line-height: 1; }
.vw-rail-add:hover { background: #ffe500; box-shadow: 0 0 10px rgba(252, 227, 0, 0.3); }
.vw-rail-list { flex: 1; overflow: auto; padding: 6px 0; }
.vw-rail-row { border-left: 2px solid transparent; }
.vw-rail-row:hover { background: #18181b; }
.vw-rail-row-active { border-left-color: #fce300; background: #18181b; }
.vw-rail-rowbtn { width: 100%; display: flex; align-items: flex-start; gap: 10px; padding: 8px 10px; text-align: left; background: transparent; color: inherit; }
.vw-rail-cover { width: 56px; height: 32px; flex: none; border: 1px solid #3f3f46; background: #18181b repeating-linear-gradient(90deg, #27272a 0 1px, transparent 1px 33.33%); overflow: hidden; }
.vw-rail-collapsed .vw-rail-cover { width: 26px; height: 26px; }
.vw-rail-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.vw-rail-meta { min-width: 0; flex: 1; }
.vw-rail-name { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #e4e4e7; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vw-rail-row-active .vw-rail-name { color: #fff; font-weight: 700; }
.vw-rail-nameinput { width: 100%; background: #09090b; border: 1px solid #fce300; color: #fff; font-size: 12px; padding: 1px 4px; }
.vw-rail-sub { font-size: 10px; color: #71717a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vw-rail-time { font-size: 10px; color: #52525b; flex: none; padding-top: 2px; }
.vw-strip { display: flex; gap: 1px; height: 2px; margin-top: 4px; }
.vw-dot { display: inline-flex; align-items: center; gap: 3px; font-size: 10px; }
.vw-dot::before { content: ''; width: 6px; height: 6px; display: inline-block; }
.vw-dot-yellow { color: #fce300; } .vw-dot-yellow::before { background: #fce300; }
.vw-dot-red { color: #f87171; } .vw-dot-red::before { background: #f87171; }
.vw-rail-foot { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding: 10px; border-top: 1px solid #3f3f46; }
.vw-ghost { height: 28px; border: 1px solid #3f3f46; color: #e4e4e7; font-size: 11px; background: transparent; }
.vw-ghost:hover:not(:disabled) { border-color: #fce300; color: #fff; }
.vw-ghost:disabled { opacity: 0.45; cursor: not-allowed; }
```

- [ ] **Step 5: 改 BoardTabs.tsx**

数据源:

```tsx
  const activeProjectId = useVideoWorkbenchStore((s) => s.activeProjectId)
  const openOverview = useVideoWorkbenchStore((s) => s.openOverview)
  const allBoards = useVideoWorkbenchStore((s) => s.boards)
  const boards = allBoards.filter((b) => b.projectId === activeProjectId).sort((a, b) => a.order - b.order)
  const projectName = useVideoWorkbenchStore((s) => s.projects.find((p) => p.id === s.activeProjectId)?.name ?? '')
```

渲染:最外层 `flex items-start gap-3 flex-wrap` 改为两行结构 —— 第一行面包屑 `<button type="button" aria-label="返回总览" className="vw-crumb" onClick={openOverview}>‹ {projectName}</button><span className="vw-crumb-sep">›</span><span className="vw-crumb-cur">{activeBoard?.name}</span>`;第二行页签容器加 `className="vw-tabs-scroll"`(`display:flex; gap:6px; overflow-x:auto; white-space:nowrap; scrollbar-width:thin`,**去掉 `flex-wrap`**),页签本身的 JSX、双击改名、删除确认逻辑不动;`removeBoard` 被拒时的提示文案改为「本剧至少保留一个分段」。新建「+」按钮的 title 改「新建分段」。

- [ ] **Step 6: 改 VideoWorkbenchPage.tsx**

外层 `<div className="bg-[#09090B] border ...">` 内部改为两栏:

```tsx
      <div className="relative z-10 flex" style={{ minHeight: '70vh' }}>
        <ProjectRail />
        <div className="flex-1 min-w-0 p-4 md:p-6 space-y-4">
          {/* 原来的 max-w-4xl 内容整体搬进来:标题行 + 页签 + 统计 + 工具条 + 卡片卷轴 */}
        </div>
      </div>
```

标题行的 `<BoardTabs />` 位置不变;统计文案 `{cards.length} 张卡片` 改为 `本段 {cards.length} 镜`;`boardCost` 的 title 里「本页」改「本段」、「全部页合计」改「全剧合计」并把 `totalCost` 的输入改为**当前剧**的卡片(`allCards.filter((c) => projectBoardIds.has(c.boardId))`)。import `ProjectRail`。

- [ ] **Step 7: 运行通过 + 回归**

Run: `pnpm exec vitest run src/renderer/src/pages-react/video-workbench`
Expected: 全绿(含 `VideoWorkbenchPage.cost.test.tsx`;若它断言「张卡片」文案,改为「镜」)。
Run: `pnpm build:vite`
Expected: 构建通过。

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/pages-react/video-workbench/ProjectRail.tsx src/renderer/src/pages-react/video-workbench/BoardTabs.tsx src/renderer/src/pages-react/video-workbench/workbench.css src/renderer/src/pages-react/VideoWorkbenchPage.tsx src/renderer/src/pages-react/video-workbench/__tests__/
git commit -m "feat(workbench): project rail, two-column layout, board tabs scoped to active project"
```

---

### Task 6: 剧总览(头部汇总 + 分段网格)+ 迁移提示条 + 视图切换

**Files:**
- Create: `src/renderer/src/pages-react/video-workbench/ProjectOverview.tsx`
- Create: `src/renderer/src/pages-react/video-workbench/SegmentCard.tsx`
- Create: `src/renderer/src/pages-react/video-workbench/MigrationNotice.tsx`
- Modify: `src/renderer/src/pages-react/VideoWorkbenchPage.tsx`(右栏按 `viewByProject[activeProjectId].mode` 渲染总览或分段页)
- Modify: `src/renderer/src/pages-react/video-workbench/workbench.css`(追加)
- Test: `src/renderer/src/pages-react/video-workbench/__tests__/ProjectOverview.test.tsx`(新)

**Interfaces:**
- Consumes: Task 3 的 `openBoard / openOverview / addBoard / renameProject / dismissLegacyNotice / removeBoard`;Task 1 的 `summarizeProject / formatDuration`。
- Produces: `<ProjectOverview />`(读 store,无 props);`<SegmentCard board stats cover index onOpen onRename onRemove draggable onDragStart />`;`<MigrationNotice project />`。

- [ ] **Step 1: 写失败测试**

```tsx
// src/renderer/src/pages-react/video-workbench/__tests__/ProjectOverview.test.tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { resetWorkbenchStoreForTest, useVideoWorkbenchStore } from '../../../features/video-workbench/store'
import { resetWorkbenchDbForTest } from '../../../features/video-workbench/WorkbenchDb'
import { ProjectOverview } from '../ProjectOverview'

const S = () => useVideoWorkbenchStore.getState()

beforeEach(() => {
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
  localStorage.clear()
})

describe('ProjectOverview', () => {
  it('头部汇总 + 每个分段一张卡,点卡进分段页', () => {
    S().addProject('追车戏')
    S().addBoard('隧道')
    S().addCards([{ prompt: 'a' }])
    const id = S().cards[0].id
    useVideoWorkbenchStore.setState((s) => ({ cards: s.cards.map((c) => (c.id === id ? { ...c, status: 'succeeded', duration: 10 } : c)) }))
    render(<ProjectOverview />)
    expect(screen.getByRole('heading', { name: '追车戏' })).toBeInTheDocument()
    expect(screen.getByText('2 段')).toBeInTheDocument()
    expect(screen.getByText('1 镜')).toBeInTheDocument()
    expect(screen.getByText('总时长 0:10')).toBeInTheDocument()
    expect(screen.getByText('已完成 100%')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /打开分段 隧道/ }))
    expect(S().viewByProject[S().activeProjectId]).toMatchObject({ mode: 'board' })
    expect(S().boards.find((b) => b.id === S().activeBoardId)!.name).toBe('隧道')
  })

  it('「新建分段」在当前剧下加一段并进入它', () => {
    render(<ProjectOverview />)
    fireEvent.click(screen.getByRole('button', { name: '新建分段' }))
    expect(S().boards.filter((b) => b.projectId === S().activeProjectId)).toHaveLength(2)
    expect(S().viewByProject[S().activeProjectId]?.mode).toBe('board')
  })

  it('默认项目显示迁移提示条,关闭后不再出现且 legacy 被清', () => {
    render(<ProjectOverview />)
    expect(screen.getByRole('status')).toHaveTextContent(/升级前/)
    fireEvent.click(screen.getByRole('button', { name: '知道了' }))
    expect(S().projects[0].legacy).toBeUndefined()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('剧名就地改名:Enter 提交,Esc 放弃', () => {
    render(<ProjectOverview />)
    fireEvent.click(screen.getByRole('button', { name: '重命名剧' }))
    const input = screen.getByRole('textbox', { name: '剧名' })
    fireEvent.change(input, { target: { value: '新名字' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(S().projects[0].name).toBe('新名字')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run src/renderer/src/pages-react/video-workbench/__tests__/ProjectOverview.test.tsx`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 写 SegmentCard.tsx**

```tsx
// src/renderer/src/pages-react/video-workbench/SegmentCard.tsx
// 剧总览网格里的一张分段卡:封面 · 序号 · 时长 · 状态角标 · 名 · 镜/花费/时间 · 三色条。
import type { VideoWorkbenchBoard } from '../../../../types/videoWorkbench'
import { formatDuration, type SegmentStats } from '../../features/video-workbench/projectStats'
import { formatCostParts } from '../../features/video-workbench/pricing'

export interface SegmentCardProps {
  board: VideoWorkbenchBoard
  stats: SegmentStats
  cover: string | null
  index: number
  onOpen: () => void
  onDragStart?: (e: React.DragEvent) => void
}

export function SegmentCard({ board, stats, cover, index, onOpen, onDragStart }: SegmentCardProps) {
  const cost = formatCostParts(stats.cost.usd, stats.cost.cny)
  return (
    <button
      type="button"
      className="vw-seg"
      aria-label={`打开分段 ${board.name}`}
      onClick={onOpen}
      draggable={Boolean(onDragStart)}
      onDragStart={onDragStart}
    >
      <div className="vw-seg-cover">
        {cover ? <img src={cover} alt="" /> : <span className="vw-seg-play" aria-hidden="true">▷</span>}
        <span className="vw-seg-badge vw-seg-badge-tl">{String(index + 1).padStart(2, '0')}</span>
        {stats.doneSeconds > 0 && <span className="vw-seg-badge vw-seg-badge-br">{formatDuration(stats.doneSeconds)}</span>}
        {stats.active > 0 && <span className="vw-seg-badge vw-seg-badge-bl vw-dot vw-dot-yellow">{stats.active} 镜生成中</span>}
        {stats.active === 0 && stats.failed > 0 && <span className="vw-seg-badge vw-seg-badge-bl vw-dot vw-dot-red">{stats.failed} 镜失败</span>}
      </div>
      <div className="vw-seg-body">
        <div className="vw-seg-name">{board.name}</div>
        <div className="vw-seg-sub">{stats.total} 镜{cost ? ` · ${cost}` : ''}</div>
        <div className="vw-strip" style={{ height: 3, marginTop: 8 }} aria-hidden="true">
          {stats.done > 0 && <div style={{ flex: stats.done, background: '#22c55e' }} />}
          {stats.active > 0 && <div style={{ flex: stats.active, background: '#FCE300' }} />}
          {stats.failed > 0 && <div style={{ flex: stats.failed, background: '#f87171' }} />}
          {stats.total === 0 && <div style={{ flex: 1, background: '#27272a' }} />}
        </div>
      </div>
    </button>
  )
}
```

- [ ] **Step 4: 写 MigrationNotice.tsx**

```tsx
// src/renderer/src/pages-react/video-workbench/MigrationNotice.tsx
// 升级首启:老页面已归入「默认项目」的一次性提示。只对 legacy 剧显示。
import type { VideoWorkbenchProject } from '../../../../types/videoWorkbench'
import { useVideoWorkbenchStore } from '../../features/video-workbench/store'

export function MigrationNotice({ project, segmentCount, onRename }: { project: VideoWorkbenchProject; segmentCount: number; onRename: () => void }) {
  const dismiss = useVideoWorkbenchStore((s) => s.dismissLegacyNotice)
  const addProject = useVideoWorkbenchStore((s) => s.addProject)
  if (!project.legacy) return null
  return (
    <div role="status" className="vw-notice">
      <span className="vw-notice-icon" aria-hidden="true">i</span>
      <div className="vw-notice-text">
        这是升级前的 {segmentCount} 个页面,已原样放进「{project.name}」这部剧里,没有改动任何内容。
        你可以给这部剧改个名,或者把分段拖到左侧剧栏新建一部剧并移入。
      </div>
      <div className="vw-notice-actions">
        <button type="button" className="vw-ghost" onClick={onRename}>重命名这部剧</button>
        <button type="button" className="vw-ghost" onClick={() => addProject()}>新建剧</button>
        <button type="button" className="vw-ghost" aria-label="知道了" onClick={() => dismiss(project.id)}>知道了</button>
      </div>
    </div>
  )
}
```

- [ ] **Step 5: 写 ProjectOverview.tsx**

```tsx
// src/renderer/src/pages-react/video-workbench/ProjectOverview.tsx
// 剧总览:面包屑 · 剧名(就地改名)· 汇总芯片 · 操作 · 分段网格。进入一部剧默认到这里。
import { useEffect, useRef, useState } from 'react'
import { formatDuration, summarizeProject } from '../../features/video-workbench/projectStats'
import { formatCostParts } from '../../features/video-workbench/pricing'
import { useVideoWorkbenchStore } from '../../features/video-workbench/store'
import { MigrationNotice } from './MigrationNotice'
import { SegmentCard } from './SegmentCard'

export const SEGMENT_DRAG_MIME = 'application/x-catimation-segment'

export function ProjectOverview() {
  const project = useVideoWorkbenchStore((s) => s.projects.find((p) => p.id === s.activeProjectId))
  const boards = useVideoWorkbenchStore((s) => s.boards)
  const cards = useVideoWorkbenchStore((s) => s.cards)
  const openBoard = useVideoWorkbenchStore((s) => s.openBoard)
  const addBoard = useVideoWorkbenchStore((s) => s.addBoard)
  const renameProject = useVideoWorkbenchStore((s) => s.renameProject)

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  if (!project) return null
  const stats = summarizeProject(project.id, boards, cards)
  const cost = formatCostParts(stats.totals.cost.usd, stats.totals.cost.cny)

  const beginRename = () => {
    setDraft(project.name)
    setEditing(true)
  }
  const commit = () => {
    renameProject(project.id, draft)
    setEditing(false)
  }

  return (
    <section className="space-y-4" aria-label="剧总览">
      <MigrationNotice project={project} segmentCount={stats.segments.length} onRename={beginRename} />
      <div className="text-[11px] text-[#71717a]">剧 › <span className="text-[#e4e4e7]">{project.name}</span> › <span className="text-[#e4e4e7]">总览</span></div>
      <div className="flex items-start justify-between gap-4 border-b border-[#3F3F46] pb-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {editing ? (
              <input
                ref={inputRef}
                aria-label="剧名"
                className="vw-title-input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commit()
                  if (e.key === 'Escape') setEditing(false)
                }}
              />
            ) : (
              <h2 className="font-orb text-2xl font-bold text-white leading-none">{project.name}</h2>
            )}
            {project.legacy && <span className="vw-chip">旧数据</span>}
            <button type="button" className="vw-rail-iconbtn" aria-label="重命名剧" title="重命名" onClick={beginRename}>✎</button>
          </div>
          <div className="flex items-center gap-1.5 mt-3 flex-wrap">
            <span className="vw-chip">{stats.segments.length} 段</span>
            <span className="vw-chip">总时长 {formatDuration(stats.totals.doneSeconds)}</span>
            <span className="vw-chip">{stats.totals.total} 镜</span>
            <span className="vw-chip vw-chip-ok">已完成 {stats.donePercent}%</span>
            {stats.totals.active > 0 && <span className="vw-chip vw-chip-warn">{stats.totals.active} 镜生成中</span>}
            {stats.totals.failed > 0 && <span className="vw-chip vw-chip-bad">{stats.totals.failed} 镜失败</span>}
            {cost && <span className="vw-chip">已花费 {cost}</span>}
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-none pt-1">
          <button type="button" className="vw-primary" onClick={() => addBoard()}>+ 新建分段</button>
        </div>
      </div>
      <div className="text-[11px] text-[#71717a]">分段按剧中顺序排列;点进分段编辑镜头;把分段卡拖到左侧剧栏可移到别的剧。</div>
      <div className="vw-seg-grid">
        {stats.segments.map(({ board, stats: s, cover }, i) => (
          <SegmentCard
            key={board.id}
            board={board}
            stats={s}
            cover={cover}
            index={i}
            onOpen={() => openBoard(board.id)}
            onDragStart={(e) => {
              e.dataTransfer.setData(SEGMENT_DRAG_MIME, board.id)
              e.dataTransfer.effectAllowed = 'move'
            }}
          />
        ))}
        <button type="button" className="vw-seg vw-seg-new" onClick={() => addBoard()} aria-label="新建分段(网格)">
          <span className="text-3xl">+</span>
          <span className="text-[12px] mt-2">新建分段</span>
          <span className="text-[10px] text-[#52525b] mt-1">或从其它剧「移动到…」</span>
        </button>
      </div>
    </section>
  )
}
```

> 测试里 `getByRole('button', { name: '新建分段' })` 要唯一,所以网格末尾那颗用了不同的 aria-label。

- [ ] **Step 6: 追加 workbench.css**

```css
/* ---------- 剧总览 ---------- */
.vw-chip { border: 1px solid #3f3f46; color: #71717a; font-size: 11px; padding: 2px 8px; line-height: 16px; }
.vw-chip-ok { color: #22c55e; border-color: #1f3d2a; }
.vw-chip-warn { color: #fce300; border-color: #4a4300; }
.vw-chip-bad { color: #f87171; border-color: #4a1f1f; }
.vw-primary { background: #fce300; color: #000; font-weight: 700; font-size: 12px; height: 30px; padding: 0 12px; }
.vw-primary:hover { background: #ffe500; box-shadow: 0 0 10px rgba(252, 227, 0, 0.3); }
.vw-title-input { background: #09090b; border: 1px solid #fce300; color: #fff; font-family: 'Orbitron', 'Exo 2', sans-serif; font-size: 22px; font-weight: 700; padding: 2px 6px; }
.vw-notice { display: flex; align-items: flex-start; gap: 12px; border-left: 2px solid #fce300; background: #18181b; padding: 12px 16px; }
.vw-notice-icon { width: 18px; height: 18px; flex: none; border: 1px solid #fce300; color: #fce300; font-size: 11px; display: inline-flex; align-items: center; justify-content: center; }
.vw-notice-text { flex: 1; font-size: 12px; color: #e4e4e7; line-height: 1.6; }
.vw-notice-actions { display: flex; gap: 6px; flex: none; }
.vw-seg-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.vw-seg { display: block; text-align: left; background: #18181b; border: 1px solid #3f3f46; color: inherit; padding: 0; }
.vw-seg:hover { border-color: #fce300; }
.vw-seg-new { display: flex; flex-direction: column; align-items: center; justify-content: center; border-style: dashed; color: #71717a; min-height: 200px; }
.vw-seg-new:hover { color: #fce300; }
.vw-seg-cover { position: relative; aspect-ratio: 16 / 9; border-bottom: 1px solid #3f3f46; background: #18181b repeating-linear-gradient(90deg, #27272a 0 1px, transparent 1px 33.33%); display: flex; align-items: center; justify-content: center; }
.vw-seg-cover img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.vw-seg-play { color: #3f3f46; font-size: 28px; }
.vw-seg-badge { position: absolute; font-family: 'Orbitron', 'Exo 2', sans-serif; font-size: 10px; color: rgba(255, 255, 255, 0.9); background: rgba(0, 0, 0, 0.7); padding: 2px 6px; }
.vw-seg-badge-tl { top: 8px; left: 8px; } .vw-seg-badge-br { bottom: 8px; right: 8px; } .vw-seg-badge-bl { bottom: 8px; left: 8px; }
.vw-seg-body { padding: 10px 12px 12px; }
.vw-seg-name { font-size: 13px; color: #fff; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vw-seg-sub { font-size: 11px; color: #71717a; margin-top: 2px; }
.vw-crumb { font-size: 11px; color: #71717a; background: transparent; } .vw-crumb:hover { color: #fce300; }
.vw-crumb-sep { color: #3f3f46; margin: 0 6px; font-size: 11px; } .vw-crumb-cur { font-size: 11px; color: #e4e4e7; }
.vw-tabs-scroll { display: flex; gap: 6px; overflow-x: auto; white-space: nowrap; scrollbar-width: thin; padding-bottom: 2px; }
```

- [ ] **Step 7: 页面按视图模式切换**

`VideoWorkbenchPage.tsx` 右栏:

```tsx
  const view = useVideoWorkbenchStore((s) => s.viewByProject[s.activeProjectId] ?? { mode: 'board' as const })
  ...
        <div className="flex-1 min-w-0 p-4 md:p-6 space-y-4">
          {view.mode === 'overview' ? <ProjectOverview /> : (<>{/* 原分段页内容 */}</>)}
        </div>
```

分段页内容保持 Task 5 的结构。import `ProjectOverview`。

- [ ] **Step 8: 运行通过 + 回归 + 构建**

Run: `pnpm exec vitest run src/renderer/src/pages-react/video-workbench src/renderer/src/features/video-workbench`
Expected: 全绿。
Run: `pnpm build:vite`
Expected: 通过。

- [ ] **Step 9: Commit**

```bash
git add src/renderer/src/pages-react/video-workbench/ProjectOverview.tsx src/renderer/src/pages-react/video-workbench/SegmentCard.tsx src/renderer/src/pages-react/video-workbench/MigrationNotice.tsx src/renderer/src/pages-react/video-workbench/workbench.css src/renderer/src/pages-react/VideoWorkbenchPage.tsx src/renderer/src/pages-react/video-workbench/__tests__/ProjectOverview.test.tsx
git commit -m "feat(workbench): project overview with segment grid, migration notice, overview/board view switching"
```

---

### Task 7: 拖拽移动分段 + 卡片拖到别的分段 + Ctrl+P 搜索

**Files:**
- Modify: `src/renderer/src/pages-react/video-workbench/ProjectRail.tsx`(行与顶部投放框接受 `SEGMENT_DRAG_MIME`)
- Modify: `src/renderer/src/pages-react/video-workbench/BoardTabs.tsx`(页签接受卡片拖入)
- Create: `src/renderer/src/pages-react/video-workbench/ProjectSearchPalette.tsx`
- Modify: `src/renderer/src/pages-react/VideoWorkbenchPage.tsx`(挂全局 `Ctrl+P` 监听,`keydown` 已在 95–105 行有一个监听可复用)
- Modify: `src/renderer/src/features/video-workbench/store.ts`(新增 `moveCardToBoard(cardId, boardId): boolean`)
- Test: `storeProjects.test.ts`(追加 `moveCardToBoard`)、`ProjectRail.test.tsx`(追加拖放)、`ProjectSearchPalette.test.tsx`(新)

**Interfaces:**
- 卡片拖拽用现有 `WorkbenchCard` 的 dataTransfer 约定:在 `WorkbenchCard.tsx` 里 grep `setData(` 找到卡片拖动时写入的 MIME 与载荷(卡片文件不改,只**读**它已经写出的类型)。若卡片当前只在同页排序时写 `text/plain` 的 cardId,就按那个读。
- Produces: `store.moveCardToBoard(cardId, boardId)`:目标 board 必须存在;卡片挪到目标末尾;源页 order 用 `reorderBoard` 压实;`revision`/`structureRevision` +1。

- [ ] **Step 1: 写失败测试**

`storeProjects.test.ts` 追加:

```ts
describe('moveCardToBoard', () => {
  it('卡片挪到另一段末尾,两边 order 压实;目标不存在返回 false', () => {
    S().addCards([{ prompt: 'a' }, { prompt: 'b' }])
    const [a, b] = S().cards.map((c) => c.id)
    const b2 = S().addBoard('第二段')
    expect(S().moveCardToBoard(a, 'ghost')).toBe(false)
    expect(S().moveCardToBoard(a, b2)).toBe(true)
    expect(S().cards.find((c) => c.id === a)!).toMatchObject({ boardId: b2, order: 0 })
    expect(S().cards.find((c) => c.id === b)!.order).toBe(0)
  })
})
```

`ProjectRail.test.tsx` 追加:

```tsx
  it('把分段拖到另一部剧的行上 → 移入该剧;拖到顶部投放框 → 新建剧并移入', () => {
    const p1 = S().activeProjectId
    const seg = S().addBoard('要搬的段')
    const p2 = S().addProject('目标剧')
    S().switchProject(p1)
    render(<ProjectRail />)
    const dt = { getData: (t: string) => (t === 'application/x-catimation-segment' ? seg : ''), types: ['application/x-catimation-segment'], dropEffect: 'move' }
    fireEvent.drop(screen.getByRole('button', { name: '切换到剧 目标剧' }), { dataTransfer: dt })
    expect(S().boards.find((b) => b.id === seg)!.projectId).toBe(p2)
    const seg2 = S().addBoard('再搬一段')
    fireEvent.dragEnter(screen.getByRole('list'), { dataTransfer: dt })
    fireEvent.drop(screen.getByRole('button', { name: '放到这里:新建一部剧并移入' }), { dataTransfer: { ...dt, getData: () => seg2 } })
    expect(S().projects).toHaveLength(3)
    const newest = S().projects[S().projects.length - 1]
    expect(S().boards.filter((b) => b.projectId === newest.id).map((b) => b.name)).toEqual(['分段 1', '再搬一段'])
  })
```

`ProjectSearchPalette.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetWorkbenchStoreForTest, useVideoWorkbenchStore } from '../../../features/video-workbench/store'
import { resetWorkbenchDbForTest } from '../../../features/video-workbench/WorkbenchDb'
import { ProjectSearchPalette } from '../ProjectSearchPalette'

const S = () => useVideoWorkbenchStore.getState()
beforeEach(() => { resetWorkbenchStoreForTest(); resetWorkbenchDbForTest(); localStorage.clear() })

describe('ProjectSearchPalette', () => {
  it('同时搜剧名与分段名,回车打开命中项', () => {
    S().addProject('追车戏')
    S().addBoard('隧道 灯带')
    S().switchProject('project-default')
    const onClose = vi.fn()
    render(<ProjectSearchPalette open onClose={onClose} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '隧道' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' })
    expect(S().boards.find((b) => b.id === S().activeBoardId)!.name).toBe('隧道 灯带')
    expect(onClose).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run src/renderer/src/features/video-workbench/__tests__/storeProjects.test.ts src/renderer/src/pages-react/video-workbench/__tests__/ProjectRail.test.tsx src/renderer/src/pages-react/video-workbench/__tests__/ProjectSearchPalette.test.tsx`
Expected: FAIL。

- [ ] **Step 3: store 加 moveCardToBoard**

紧挨 `moveCard` 之后:

```ts
  moveCardToBoard: (cardId, boardId) => {
    const { cards, boards } = get()
    const card = cards.find((c) => c.id === cardId)
    if (!card || !boards.some((b) => b.id === boardId) || card.boardId === boardId) return false
    if (isActiveStatus(card.status)) return false // 生成中不挪页:任务回流按 boardId 找不到会丢进度
    const from = card.boardId
    const targetCount = cards.filter((c) => c.boardId === boardId).length
    set((state) => {
      let next = state.cards.map((c) => (c.id === cardId ? { ...c, boardId, order: targetCount, updatedAt: Date.now() } : c))
      if (from) next = reorderBoard(next, from)
      return {
        cards: next,
        selectedCardIds: [],
        selectionAnchorId: undefined,
        revision: state.revision + 1,
        structureRevision: state.structureRevision + 1,
      }
    })
    const db = getWorkbenchDb()
    for (const c of get().cards) if (c.id === cardId || c.boardId === from) void db.put(c).catch(() => {})
    return true
  },
```

接口声明加到 `VideoWorkbenchState`:`moveCardToBoard: (cardId: string, boardId: string) => boolean`。

- [ ] **Step 4: 剧栏接受分段拖放**

`ProjectRail.tsx`:import `SEGMENT_DRAG_MIME` from `./ProjectOverview`、`moveBoardToProject`、`addProject`。加 `const [dragOver, setDragOver] = useState(false)`;`vw-rail-list` 上 `onDragEnter/onDragOver={(e) => { if (e.dataTransfer.types.includes(SEGMENT_DRAG_MIME)) { e.preventDefault(); setDragOver(true) } }}`、`onDragLeave={() => setDragOver(false)}`;列表顶部在 `dragOver` 时渲染:

```tsx
          {dragOver && (
            <button
              type="button"
              className="vw-rail-drop"
              aria-label="放到这里:新建一部剧并移入"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                const boardId = e.dataTransfer.getData(SEGMENT_DRAG_MIME)
                setDragOver(false)
                if (!boardId) return
                const id = addProject()
                moveBoardToProject(boardId, id)
              }}
            >
              ⊞ 放到这里:新建一部剧并移入
            </button>
          )}
```

每个 `vw-rail-rowbtn` 加 `onDragOver={(e) => { if (e.dataTransfer.types.includes(SEGMENT_DRAG_MIME)) e.preventDefault() }}` 与 `onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData(SEGMENT_DRAG_MIME); setDragOver(false); if (id) moveBoardToProject(id, project.id) }}`。CSS:`.vw-rail-drop { margin: 6px 8px; padding: 10px 12px; width: calc(100% - 16px); border: 1px dashed #fce300; background: rgba(252,227,0,.06); color: #fce300; font-size: 11px; text-align: left; }`。

> `moveBoardToProject` 对「源剧会空出」返回 false;新建剧时目标已有「分段 1」,所以搬进去后它有两段——测试期望 `['分段 1', '再搬一段']` 就是这个含义。

- [ ] **Step 5: 页签接受卡片拖入**

`BoardTabs.tsx` 每个页签 `<button role="tab">` 加:

```tsx
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes(CARD_DRAG_MIME)) e.preventDefault()
              }}
              onDrop={(e) => {
                const cardId = e.dataTransfer.getData(CARD_DRAG_MIME)
                if (!cardId) return
                e.preventDefault()
                moveCardToBoard(cardId, board.id)
              }}
```

`CARD_DRAG_MIME` = 在 `WorkbenchCard.tsx` 里找到的卡片拖拽 MIME 字符串(grep `setData(`),在 BoardTabs 里以常量复述;若卡片写的是 `text/plain`,常量就是 `'text/plain'`。

- [ ] **Step 6: 写 ProjectSearchPalette.tsx 并挂 Ctrl+P**

```tsx
// src/renderer/src/pages-react/video-workbench/ProjectSearchPalette.tsx
// Ctrl+P:同时搜剧名与分段名,↑↓ 选、Enter 打开、Esc 关。
import { useEffect, useMemo, useRef, useState } from 'react'
import { useVideoWorkbenchStore } from '../../features/video-workbench/store'

interface Hit { kind: 'project' | 'board'; id: string; label: string; sub: string }

export function ProjectSearchPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const projects = useVideoWorkbenchStore((s) => s.projects)
  const boards = useVideoWorkbenchStore((s) => s.boards)
  const switchProject = useVideoWorkbenchStore((s) => s.switchProject)
  const openBoard = useVideoWorkbenchStore((s) => s.openBoard)
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (open) {
      setQ('')
      setIdx(0)
      inputRef.current?.focus()
    }
  }, [open])

  const hits = useMemo<Hit[]>(() => {
    const needle = q.trim().toLowerCase()
    const nameOf = new Map(projects.map((p) => [p.id, p.name]))
    const ps: Hit[] = projects.map((p) => ({ kind: 'project', id: p.id, label: p.name, sub: '剧' }))
    const bs: Hit[] = boards.map((b) => ({ kind: 'board', id: b.id, label: b.name, sub: nameOf.get(b.projectId) ?? '' }))
    const all = [...ps, ...bs]
    return needle ? all.filter((h) => h.label.toLowerCase().includes(needle) || h.sub.toLowerCase().includes(needle)) : all.slice(0, 12)
  }, [q, projects, boards])

  if (!open) return null
  const choose = (h: Hit) => {
    if (h.kind === 'project') switchProject(h.id)
    else openBoard(h.id)
    onClose()
  }
  return (
    <div className="vw-palette-backdrop" onMouseDown={onClose}>
      <div className="vw-palette" role="dialog" aria-label="搜索剧与分段" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded="true"
          aria-controls="vw-palette-list"
          className="vw-palette-input"
          placeholder="搜索剧 / 分段…"
          value={q}
          onChange={(e) => { setQ(e.target.value); setIdx(0) }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(i + 1, hits.length - 1)) }
            if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)) }
            if (e.key === 'Enter' && hits[idx]) choose(hits[idx])
            if (e.key === 'Escape') onClose()
          }}
        />
        <ul id="vw-palette-list" role="listbox" className="vw-palette-list">
          {hits.map((h, i) => (
            <li key={`${h.kind}:${h.id}`} role="option" aria-selected={i === idx} className={`vw-palette-item ${i === idx ? 'vw-palette-item-active' : ''}`} onMouseEnter={() => setIdx(i)} onClick={() => choose(h)}>
              <span>{h.label}</span><span className="vw-palette-sub">{h.sub}</span>
            </li>
          ))}
          {hits.length === 0 && <li className="vw-palette-empty">没有匹配的剧或分段</li>}
        </ul>
      </div>
    </div>
  )
}
```

CSS:

```css
.vw-palette-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.55); z-index: 60; display: flex; justify-content: center; padding-top: 12vh; }
.vw-palette { width: 480px; max-height: 60vh; background: #111113; border: 1px solid #3f3f46; box-shadow: 0 0 14px rgba(252,227,0,.18); display: flex; flex-direction: column; }
.vw-palette-input { height: 40px; background: #09090b; border: 0; border-bottom: 1px solid #3f3f46; color: #fff; font-size: 13px; padding: 0 12px; }
.vw-palette-input:focus { outline: none; border-bottom-color: #fce300; }
.vw-palette-list { overflow: auto; padding: 4px 0; }
.vw-palette-item { display: flex; justify-content: space-between; padding: 8px 12px; font-size: 12px; color: #e4e4e7; cursor: pointer; }
.vw-palette-item-active { background: #18181b; color: #fff; box-shadow: inset 2px 0 0 #fce300; }
.vw-palette-sub { color: #71717a; font-size: 11px; }
.vw-palette-empty { padding: 12px; font-size: 12px; color: #71717a; }
```

`VideoWorkbenchPage.tsx`:`const [paletteOpen, setPaletteOpen] = useState(false)`;在 95–105 行那个 `keydown` 监听里加 `if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') { e.preventDefault(); setPaletteOpen(true) }`;渲染 `<ProjectSearchPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />`。

- [ ] **Step 7: 运行通过 + 回归 + 构建**

Run: `pnpm exec vitest run src/renderer/src/pages-react/video-workbench src/renderer/src/features/video-workbench && pnpm build:vite`
Expected: 全绿,构建通过。

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/pages-react/video-workbench/ src/renderer/src/pages-react/VideoWorkbenchPage.tsx src/renderer/src/features/video-workbench/store.ts src/renderer/src/features/video-workbench/__tests__/storeProjects.test.ts
git commit -m "feat(workbench): drag segments between projects, drag cards between segments, Ctrl+P search palette"
```

---

### Task 8: Agent / MCP —— 工具按当前剧隔离 + 三个新工具

**Files:**
- Modify: `src/renderer/src/features/agent-chat/AgentToolExecutor.ts`(333–345 的工具名白名单;649 起 `video_workbench_status`;`snapshotWorkbench` / `pickCards` 两个 helper;`video_workbench_export` / `video_workbench_apply` 分支)
- Modify: `src/renderer/src/features/video-workbench/workbenchIR.ts:138`(`exportWorkbenchIR` 带 `projectId`)与 `planApplyIR`(350)
- Modify: `src/types/videoWorkbench.ts:471`(`WorkbenchIR.projectId?: string`)
- Modify: `src/main/mcp/tools/videoWorkbenchTools.ts`(577 `registerVideoWorkbenchTools` 内新增三个 `registerTool`;947 `status` 描述)
- Modify: `src/main/mcp/tools/__tests__/toolAnnotations.test.ts`、`src/main/mcp/tools/__tests__/videoWorkbenchTools.test.ts`
- Test: `src/renderer/src/features/agent-chat/__tests__/AgentToolExecutor.videoWorkbench.test.ts`(追加)、`src/renderer/src/features/video-workbench/__tests__/workbenchIR.test.ts`(追加)

**Interfaces:**
- 新工具(main 注册名 = renderer case 名):
  - `video_workbench_list_projects` → `{ activeProjectId, projects: Array<{ id, name, segments, cards, active, failed, done, doneSeconds, legacy? }> }`
  - `video_workbench_switch_project` `{ projectId: string }` → `{ activeProjectId, project: { id, name }, boards: 同 status 的 boards 目录 }`
  - `video_workbench_create_project` `{ name?: string }` → `{ projectId, boardId, name }`(自带的「分段 1」的 id 一并回,agent 可以直接往里加卡)
- `WorkbenchIR.projectId`:export 时写入当前剧 id;apply 时若给了且 ≠ 当前剧 → 整份拒绝 `conflict: { reason: 'project-mismatch' }`(沿用 `WorkbenchApplyResult.conflict`,在类型上把它扩成 `{ expected: number; actual: number } | { reason: 'project-mismatch'; expected: string; actual: string }`)。
- `status.boards` 只含当前剧的分段;返回头部多 `project: { id, name, segments, cards }`。

- [ ] **Step 1: 写失败测试**

`workbenchIR.test.ts` 追加:

```ts
describe('IR · projectId', () => {
  it('export 带当前剧 id;apply 时剧对不上整份拒绝', () => {
    const source = makeSource() // 该文件已有的构造器;补上 activeProjectId: 'p1' 与 boards[].projectId: 'p1'
    const ir = exportWorkbenchIR(source)
    expect(ir.projectId).toBe('p1')
    const plan = planApplyIR({ ...source, activeProjectId: 'p2' }, ir, {})
    expect(plan.result.ok).toBe(false)
    expect(plan.result.conflict).toEqual({ reason: 'project-mismatch', expected: 'p1', actual: 'p2' })
  })
  it('老 IR 没有 projectId 照常 apply', () => {
    const source = makeSource()
    const { projectId: _drop, ...legacy } = exportWorkbenchIR(source)
    expect(planApplyIR(source, legacy as WorkbenchIR, {}).result.ok).toBe(true)
  })
})
```

`AgentToolExecutor.videoWorkbench.test.ts` 追加(沿用该文件已有的 `execute(name, params)` 辅助):

```ts
describe('按当前剧隔离', () => {
  it('status 只回当前剧的分段与卡,并带 project 头', async () => {
    const S = () => useVideoWorkbenchStore.getState()
    S().addCards([{ prompt: 'in-default' }])
    const p2 = S().addProject('第二部')
    S().addCards([{ prompt: 'in-p2' }])
    const r = await execute('video_workbench_status', { allBoards: true })
    expect(r.project).toMatchObject({ id: p2, name: '第二部', segments: 1, cards: 1 })
    expect(r.boards.every((b: { id: string }) => S().boards.find((x) => x.id === b.id)!.projectId === p2)).toBe(true)
    expect(r.cards.map((c: { prompt: string }) => c.prompt)).toEqual(['in-p2'])
  })

  it('list / switch / create 三个工具', async () => {
    const S = () => useVideoWorkbenchStore.getState()
    const created = await execute('video_workbench_create_project', { name: '新剧' })
    expect(S().activeProjectId).toBe(created.projectId)
    expect(S().boards.find((b) => b.id === created.boardId)!.projectId).toBe(created.projectId)
    const list = await execute('video_workbench_list_projects', {})
    expect(list.projects.map((p: { name: string }) => p.name)).toEqual(['默认项目', '新剧'])
    expect(list.activeProjectId).toBe(created.projectId)
    const sw = await execute('video_workbench_switch_project', { projectId: 'project-default' })
    expect(sw.activeProjectId).toBe('project-default')
    await expect(execute('video_workbench_switch_project', { projectId: 'ghost' })).rejects.toThrow(/project not found/)
  })
})
```

`toolAnnotations.test.ts`:在只读工具列表加 `video_workbench_list_projects`;在写工具列表加 `video_workbench_switch_project`、`video_workbench_create_project`(照该文件现有断言格式)。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run src/renderer/src/features/video-workbench/__tests__/workbenchIR.test.ts src/renderer/src/features/agent-chat/__tests__/AgentToolExecutor.videoWorkbench.test.ts src/main/mcp/tools/__tests__/toolAnnotations.test.ts`
Expected: FAIL。

- [ ] **Step 3: IR 带 projectId**

`src/types/videoWorkbench.ts` `WorkbenchIR` 加:

```ts
  /**
   * 导出时的当前剧。apply 时若给了且与当前剧不同 → 整份拒绝:用户中途切了剧,
   * 这份 IR 描述的是另一部剧的看板。省略(老 IR)= 不校验。
   */
  projectId?: string
```

`WorkbenchApplyResult.conflict` 类型改为 `{ expected: number; actual: number } | { reason: 'project-mismatch'; expected: string; actual: string }`。

`workbenchIR.ts`:`WorkbenchIRSource` 加 `activeProjectId: string`;`exportWorkbenchIR` 返回对象加 `projectId: source.activeProjectId`,且 `boards` 只导出 `b.projectId === source.activeProjectId` 的;`planApplyIR` 开头:

```ts
  if (ir.projectId && ir.projectId !== source.activeProjectId) {
    return {
      result: {
        ok: false,
        conflict: { reason: 'project-mismatch', expected: ir.projectId, actual: source.activeProjectId },
        boards: { created: [], renamed: [], removed: [] },
        cards: { created: [], updated: [], moved: [], removed: [] },
        skipped: [{ reason: `IR 属于剧 ${ir.projectId},当前剧是 ${source.activeProjectId};请重新 export` }],
        revision: source.revision,
      },
      // 其余字段按该函数现有的「拒绝」返回形状补齐
    }
  }
```

`planApplyIR` 的 `replace` 模式「IR 未列出的页删掉」只作用于当前剧的分段(过滤 `b.projectId === source.activeProjectId`),别的剧的分段不能被一份 IR 顺手删掉;新建的 board 写 `projectId: source.activeProjectId`。store 的 `exportIR: () => exportWorkbenchIR(get())` 不用改(get() 已含 `activeProjectId`)。

- [ ] **Step 4: 渲染端工具实现(AgentToolExecutor.ts)**

白名单(333–345)加三个新名字。`snapshotWorkbench(state)` 里 `boards` 只取 `state.boards.filter((b) => b.projectId === state.activeProjectId)`;`pickCards` 默认范围同样先按当前剧的 boardIds 过滤(显式 `cardIds` 除外)。`video_workbench_status` 返回对象加:

```ts
          project: (() => {
            const p = state.projects.find((x) => x.id === state.activeProjectId)!
            const st = summarizeProject(p.id, state.boards, state.cards)
            return { id: p.id, name: p.name, segments: st.segments.length, cards: st.totals.total, active: st.totals.active, failed: st.totals.failed }
          })(),
```

三个新 case:

```ts
      case 'video_workbench_list_projects': {
        const state = useVideoWorkbenchStore.getState()
        return {
          activeProjectId: state.activeProjectId,
          projects: state.projects.slice().sort((a, b) => a.order - b.order).map((p) => {
            const st = summarizeProject(p.id, state.boards, state.cards)
            return {
              id: p.id, name: p.name, segments: st.segments.length, cards: st.totals.total,
              active: st.totals.active, failed: st.totals.failed, done: st.totals.done, doneSeconds: st.totals.doneSeconds,
              ...(p.legacy ? { legacy: true } : {}),
            }
          }),
        }
      }
      case 'video_workbench_switch_project': {
        const projectId = typeof params.projectId === 'string' ? params.projectId : ''
        const state = useVideoWorkbenchStore.getState()
        const project = state.projects.find((p) => p.id === projectId)
        if (!project) {
          throw new Error(`video_workbench_switch_project: project not found: ${projectId} (existing: ${state.projects.map((p) => p.id).join(', ')})`)
        }
        state.switchProject(projectId)
        const after = useVideoWorkbenchStore.getState()
        return { activeProjectId: after.activeProjectId, project: { id: project.id, name: project.name }, boards: snapshotWorkbench(after).boards }
      }
      case 'video_workbench_create_project': {
        const name = typeof params.name === 'string' ? params.name : undefined
        const state = useVideoWorkbenchStore.getState()
        const projectId = state.addProject(name)
        const after = useVideoWorkbenchStore.getState()
        const board = after.boards.find((b) => b.projectId === projectId)!
        return { projectId, boardId: board.id, name: after.projects.find((p) => p.id === projectId)!.name }
      }
```

import `summarizeProject` from `../video-workbench/projectStats`。

- [ ] **Step 5: 主进程注册(videoWorkbenchTools.ts)**

在 `registerVideoWorkbenchTools` 末尾追加(照 947–1017 `status` 的写法,`router.call(name, params, extractCodexThreadId(ctx))`,成功用 `okResult`,失败 `errorResult`):

```ts
  server.registerTool('video_workbench_list_projects', {
    title: 'List workbench projects (剧)',
    description:
      'List every project (剧 — a series/film that groups segments/boards). Returns id, name and counts '
      + '(segments, cards, active, failed, done, doneSeconds). All other video_workbench_* tools act on the '
      + 'ACTIVE project only; call video_workbench_switch_project to change it.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (_params, ctx) => {
    try {
      const result = await router.call('video_workbench_list_projects', {}, extractCodexThreadId(ctx))
      return okResult(['✓ video_workbench_list_projects'], result)
    } catch (error) {
      return errorResult('video_workbench_list_projects', error)
    }
  })

  server.registerTool('video_workbench_switch_project', {
    title: 'Switch active project (剧)',
    description:
      'Make a project the ACTIVE one. Every subsequent video_workbench_* call (status/add_tasks/apply/start…) '
      + 'operates inside it, and the user sees the switch immediately. Get ids from video_workbench_list_projects.',
    inputSchema: { projectId: z.string().min(1).describe('Project id from video_workbench_list_projects.') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (params, ctx) => {
    try {
      const result = await router.call('video_workbench_switch_project', params as Record<string, unknown>, extractCodexThreadId(ctx))
      return okResult(['✓ video_workbench_switch_project'], result)
    } catch (error) {
      return errorResult('video_workbench_switch_project', error)
    }
  })

  server.registerTool('video_workbench_create_project', {
    title: 'Create a project (剧)',
    description:
      'Create a new project (剧) with one empty segment, switch to it, and return { projectId, boardId, name }. '
      + 'Use when the user starts a new film/series; add cards with video_workbench_add_tasks afterwards.',
    inputSchema: { name: z.string().max(80).optional().describe('Project name; omitted = 未命名剧 N.') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (params, ctx) => {
    try {
      const result = await router.call('video_workbench_create_project', params as Record<string, unknown>, extractCodexThreadId(ctx))
      return okResult(['✓ video_workbench_create_project'], result)
    } catch (error) {
      return errorResult('video_workbench_create_project', error)
    }
  })
```

`status` 的 description 开头加一句:`'Scoped to the ACTIVE project (剧). '`;`apply` 的 description 加:`'The IR carries projectId; if the user switched project since export the whole apply is rejected with conflict.reason="project-mismatch" — re-export.'`。凡描述里的「page/board」保留词,但补一句 `(a board is a 分段/segment of the active project)`。

- [ ] **Step 6: 批次完成推送带「剧 › 分段」**

grep `批次渲染完成`(渲染端组装推送文案的地方),把分段名前加剧名:`${projectName} › ${boardName}`。

- [ ] **Step 7: skill 文案同步**

`resources/plugins/*/skills/catimation-video-workbench/SKILL.md`(权威源)里「页面」→「分段」、加「剧」概念与三个新工具一段;然后跑既有生成链:`node scripts/generate-first-party-skills.mjs && node scripts/sync-top-level-skills.mjs`(**不手改** `src/main/agent/generated/firstPartySkills.generated.ts` 与顶层 `skills/` 镜像)。`npm run audit:skill-arch` 必须 0 违规。

- [ ] **Step 8: 运行通过 + 回归**

Run: `pnpm exec vitest run src/renderer/src/features/agent-chat/__tests__/AgentToolExecutor.videoWorkbench.test.ts src/renderer/src/features/video-workbench src/main/mcp/tools && npm run audit:skill-arch`
Expected: 全绿,审计 0 违规。

- [ ] **Step 9: Commit**

```bash
git add src/types/videoWorkbench.ts src/renderer/src/features/video-workbench/workbenchIR.ts src/renderer/src/features/agent-chat/AgentToolExecutor.ts src/main/mcp/tools/videoWorkbenchTools.ts src/main/mcp/tools/__tests__/ src/renderer/src/features/agent-chat/__tests__/ src/renderer/src/features/video-workbench/__tests__/workbenchIR.test.ts resources/plugins/ src/main/agent/generated/firstPartySkills.generated.ts skills/
git commit -m "feat(workbench): MCP tools scoped to active project; list/switch/create project tools; IR carries projectId"
```

---

### Task 9: 文档收口

**Files:**
- Modify: `docs/superpowers/specs/2026-09-04-video-workbench-projects-design.md`(§4.1 空态一段、§2 非目标)
- Create: `docs/releases/v4.8.0.md`

- [ ] **Step 1: spec 记录偏离**

§4.1 总览的「空态」一句改为:「每部剧至少一个分段:新建剧自带『分段 1』,不存在空态。」§2 非目标追加:「不做零分段的剧。」

- [ ] **Step 2: 发布说明**

`docs/releases/v4.8.0.md` 按 `docs/releases/v4.7.8.md` 的格式写:剧/分段两层、左侧剧栏、剧总览、迁移说明(老页面进「默认项目」)、Agent 三个新工具、`Ctrl+P`。工程文件导入/导出与 `data:` 落盘属于后续版本,不写。

- [ ] **Step 3: 全量验证**

Run: `pnpm exec vitest run src/renderer/src/features/video-workbench src/renderer/src/pages-react/video-workbench src/renderer/src/features/agent-chat src/main/mcp && pnpm typecheck && pnpm build:vite`
Expected: 全绿;typecheck 不高于基线;构建通过。

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-09-04-video-workbench-projects-design.md docs/releases/v4.8.0.md
git commit -m "docs(workbench): spec deviation (one segment minimum) + v4.8.0 release notes"
```

---

## Self-Review(已做)

- **Spec 覆盖**:§3 术语(T1)、§4.1 三屏(T5/T6)、§4.2 生成不中断(store 本就全量持卡,T3 未引入按剧卸载)、新建零表单(T5 `handleAdd` 立即聚焦改名)、删除可撤销(T4)、生成中拒删(T3)、移动(T3 `moveBoardToProject`、T7 `moveCardToBoard` + 拖放)、迁移提示条(T6)、花费口径(T1 `projectStats`)、视图记忆(T3 `viewByProject`)、§5 数据模型与 v3 迁移(T1/T2/T3)、§8 MCP(T8)。§6 工程文件、§7 `data:` 落盘属计划 2/3。剧栏「⋯ 菜单:复制/删除」——`duplicateProject`/`removeProject` 动作已有(T3),菜单 UI 放进 T5 的行右键:实现者在 `vw-rail-rowbtn` 上加 `onContextMenu` 弹出含「重命名 / 复制 / 删除」三项的小菜单,删除时用 `window.confirm` 之外的两步确认(照 `BoardTabs` 现有的 3.5s 确认态模式),并 toast 撤销提示。
- **占位扫描**:无 TBD/TODO;每个代码步骤给了代码;T7 的 `CARD_DRAG_MIME` 要求实现者从 `WorkbenchCard.tsx` 读现有常量而非发明——这是有意为之(卡片文件不改)。
- **类型一致性**:`ProjectsSlice` 方法名在 T3/T5/T6/T7/T8 一致(`addProject/switchProject/openBoard/openOverview/moveBoardToProject/removeProject/dismissLegacyNotice/setRailCollapsed`);`summarizeProject(projectId, boards, cards)` 参数顺序在 T1/T5/T6/T8 一致;`SEGMENT_DRAG_MIME` 由 T6 导出、T7 消费;`moveCardToBoard` 由 T7 定义并在同任务消费。

## Execution Handoff

计划已保存到 `docs/superpowers/plans/2026-09-04-video-workbench-projects-layer.md`。两种执行方式:

1. **Subagent-Driven(推荐)** —— 每个任务派一个新子代理,任务间做两阶段审查。**注意:本会话里 Cursor 子代理因区域限制不可用(Model not available),若仍不可用则退到方式 2。**
2. **Inline Execution** —— 在本会话按 executing-plans 逐任务执行,任务间设检查点。

计划 2(`data:` 落盘与清理)与计划 3(工程文件导入/导出 + 两个确认页)在本计划落地后另写。
