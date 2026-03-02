# Director Runtime Skill Loading Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 Director 的技能来源从纯构建时静态加载升级为“内置技能 + `userData/skills` 运行时合并”，并支持手动刷新后立即生效。

**Architecture:** 在 `prompt-loader` 内建立统一技能缓存层：内置技能继续由 `import.meta.glob` 提供兜底，用户技能通过 `window.electronAPI.loadSkills()` 异步读取并合并。`DirectorPipeline.execute()` 在执行前确保初始化缓存，UI 暴露“刷新 Skills”触发 reload。冲突按 `id` 处理，用户技能覆盖内置技能。

**Tech Stack:** Electron, React, TypeScript, Zustand, Vitest, electron-vite

---

**Required process skills:** @test-driven-development @verification-before-completion @systematic-debugging  
**Implementation constraints:** DRY / YAGNI / 单步提交 / 一次只做一个行为变化

### Task 1: Prompt Loader Runtime Cache Layer

**Files:**
- Modify: `src/renderer/src/services/pipeline/prompt-loader.ts`
- Create: `src/renderer/src/services/pipeline/__tests__/prompt-loader.runtime-skills.test.ts`
- Test: `src/renderer/src/services/pipeline/__tests__/prompt-loader.runtime-skills.test.ts`

**Step 1: 写失败测试（用户技能覆盖 + 忽略坏格式）**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  initDirectorSkills,
  reloadDirectorSkills,
  getDirectorSkillsFromConfig,
} from '../prompt-loader'

describe('prompt-loader runtime skills', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      electronAPI: {
        isElectron: true,
        loadSkills: vi.fn().mockResolvedValue({
          'director-cinematic-composition': `---\nname: cinematic-composition\nappliesTo: [designAndAssemble]\npriority: 1\ndescription: override\n---\nuser rules`,
          'broken-skill': 'invalid markdown',
        }),
      },
    } as any)
  })

  it('user skill overrides builtin by id and skips invalid entries', async () => {
    await initDirectorSkills()
    const skills = getDirectorSkillsFromConfig()
    const cc = skills.find(s => s.id === 'cinematic-composition')
    expect(cc?.rules).toContain('user rules')
    expect(skills.some(s => s.id === 'broken-skill')).toBe(false)
  })
})
```

**Step 2: 运行测试确认失败**

Run: `npm run test:run -- src/renderer/src/services/pipeline/__tests__/prompt-loader.runtime-skills.test.ts`  
Expected: FAIL，提示 `initDirectorSkills`/`reloadDirectorSkills` 未定义或行为不符。

**Step 3: 最小实现（异步初始化 + 同步读取缓存）**

```ts
let _skillCache: PipelineSkill[] | null = null
let _initPromise: Promise<void> | null = null

export async function initDirectorSkills(): Promise<void> {
  if (_skillCache) return
  if (_initPromise) return _initPromise
  _initPromise = loadAndMergeSkills().finally(() => {
    _initPromise = null
  })
  return _initPromise
}

export async function reloadDirectorSkills(): Promise<{ total: number; user: number }> {
  await loadAndMergeSkills()
  return { total: _skillCache?.length ?? 0, user: _lastUserSkillCount }
}

export function getDirectorSkillsFromConfig(): PipelineSkill[] {
  return [...(_skillCache ?? _builtinSkills)]
}
```

**Step 4: 运行测试确认通过**

Run: `npm run test:run -- src/renderer/src/services/pipeline/__tests__/prompt-loader.runtime-skills.test.ts`  
Expected: PASS。

**Step 5: Commit**

```bash
git add src/renderer/src/services/pipeline/prompt-loader.ts src/renderer/src/services/pipeline/__tests__/prompt-loader.runtime-skills.test.ts
git commit -m "feat(pipeline): add runtime skill cache with builtin and user merge"
```

---

### Task 2: Pipeline Init Barrier Before Execution

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts`
- Create: `src/renderer/src/services/pipeline/__tests__/director-pipeline-skill-init.test.ts`
- Test: `src/renderer/src/services/pipeline/__tests__/director-pipeline-skill-init.test.ts`

**Step 1: 写失败测试（execute 前必须完成技能初始化）**

```ts
import { describe, it, expect, vi } from 'vitest'
import { DirectorPipeline } from '../DirectorPipeline'
import * as promptLoader from '../prompt-loader'

describe('DirectorPipeline skill init', () => {
  it('awaits initDirectorSkills before graph execution', async () => {
    const initSpy = vi.spyOn(promptLoader, 'initDirectorSkills').mockResolvedValue()
    const pipeline = new DirectorPipeline({} as any)
    await pipeline.execute({} as any)
    expect(initSpy).toHaveBeenCalled()
  })
})
```

**Step 2: 运行测试确认失败**

Run: `npm run test:run -- src/renderer/src/services/pipeline/__tests__/director-pipeline-skill-init.test.ts`  
Expected: FAIL，`initDirectorSkills` 未被调用。

**Step 3: 最小实现（在 execute 入口 await init）**

```ts
import { initDirectorSkills } from './prompt-loader'

async execute(input: DirectorInput, opts?: ExecuteOptions): Promise<DirectorResult> {
  await initDirectorSkills()
  // existing execute logic
}
```

**Step 4: 运行测试确认通过**

Run: `npm run test:run -- src/renderer/src/services/pipeline/__tests__/director-pipeline-skill-init.test.ts`  
Expected: PASS。

**Step 5: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts src/renderer/src/services/pipeline/__tests__/director-pipeline-skill-init.test.ts
git commit -m "fix(pipeline): initialize runtime skills before director execution"
```

---

### Task 3: UI Manual Refresh Entry

**Files:**
- Modify: `src/renderer/src/react-app/DirectorApp.tsx`
- Create: `src/renderer/src/react-app/__tests__/DirectorApp.refresh-skills.test.tsx`
- Test: `src/renderer/src/react-app/__tests__/DirectorApp.refresh-skills.test.tsx`

**Step 1: 写失败测试（点击刷新触发 reload + toast）**

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { vi, it, expect } from 'vitest'
import { DirectorApp } from '../DirectorApp'

it('reloads skills when refresh button clicked', async () => {
  const reloadSpy = vi.fn().mockResolvedValue({ total: 11, user: 1 })
  vi.mock('@/services/pipeline/prompt-loader', () => ({ reloadDirectorSkills: reloadSpy }))
  render(<DirectorApp />)
  fireEvent.click(screen.getByRole('button', { name: /刷新 Skills/i }))
  expect(reloadSpy).toHaveBeenCalled()
})
```

**Step 2: 运行测试确认失败**

Run: `npm run test:run -- src/renderer/src/react-app/__tests__/DirectorApp.refresh-skills.test.tsx`  
Expected: FAIL，找不到按钮或 reload 未触发。

**Step 3: 最小实现（按钮 + 调用 reload + 反馈）**

```tsx
<button onClick={handleRefreshSkills}>刷新 Skills</button>

const handleRefreshSkills = useCallback(async () => {
  try {
    const info = await reloadDirectorSkills()
    toast.success(`Skills 已刷新：${info.total}（用户 ${info.user}）`)
  } catch (e) {
    toast.error('Skills 刷新失败')
  }
}, [])
```

**Step 4: 运行测试确认通过**

Run: `npm run test:run -- src/renderer/src/react-app/__tests__/DirectorApp.refresh-skills.test.tsx`  
Expected: PASS。

**Step 5: Commit**

```bash
git add src/renderer/src/react-app/DirectorApp.tsx src/renderer/src/react-app/__tests__/DirectorApp.refresh-skills.test.tsx
git commit -m "feat(ui): add manual runtime skill reload action in director app"
```

---

### Task 4: Electron API Type Alignment

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/services/ServiceBridge.ts`
- Create: `src/renderer/src/services/__tests__/electron-api-skill-types.test.ts`
- Test: `src/renderer/src/services/__tests__/electron-api-skill-types.test.ts`

**Step 1: 写失败测试（类型/封装存在 loadSkills/saveSkill）**

```ts
import { expectTypeOf, it } from 'vitest'

it('electron api exposes skill methods', () => {
  expectTypeOf(window.electronAPI?.loadSkills).toBeFunction()
  expectTypeOf(window.electronAPI?.saveSkill).toBeFunction()
})
```

**Step 2: 运行测试确认失败**

Run: `npm run test:run -- src/renderer/src/services/__tests__/electron-api-skill-types.test.ts`  
Expected: FAIL 或 `npm run typecheck` 报类型缺失。

**Step 3: 最小实现（声明与桥接一致）**

```ts
interface ElectronAPI {
  loadSkills: () => Promise<Record<string, string>>
  saveSkill: (skillName: string, content: string) => Promise<{ success: boolean; error?: string }>
}
```

**Step 4: 验证通过（类型 + 单测）**

Run: `npm run typecheck && npm run test:run -- src/renderer/src/services/__tests__/electron-api-skill-types.test.ts`  
Expected: 全部 PASS。

**Step 5: Commit**

```bash
git add src/types/index.ts src/preload/index.ts src/renderer/src/services/ServiceBridge.ts src/renderer/src/services/__tests__/electron-api-skill-types.test.ts
git commit -m "chore(types): align electron skill IPC typing and bridge wrappers"
```

---

### Task 5: Regression Matrix for Runtime Skills

**Files:**
- Create: `src/renderer/src/services/pipeline/__tests__/runtime-skills-regression.test.ts`
- Modify: `docs/plans/2026-03-03-director-runtime-skill-loading.md`（补充测试结果记录区）
- Test: `src/renderer/src/services/pipeline/__tests__/runtime-skills-regression.test.ts`

**Step 1: 写失败测试（A/B/C/D 四场景）**

```ts
describe('runtime skills regression', () => {
  it('A: builtin only still works', () => {})
  it('B: new user skill is picked after reload', () => {})
  it('C: same id user skill overrides builtin', () => {})
  it('D: invalid markdown is skipped without crash', () => {})
})
```

**Step 2: 运行测试确认失败**

Run: `npm run test:run -- src/renderer/src/services/pipeline/__tests__/runtime-skills-regression.test.ts`  
Expected: FAIL（空断言或行为不符）。

**Step 3: 完成最小实现断言并补齐 fixture**

```ts
expect(result.skills.length).toBeGreaterThan(0)
expect(result.overrideSkill.rules).toContain('user override')
expect(result.errors).toContain('invalid skill markdown')
```

**Step 4: 全量验证**

Run: `npm run test:run -- src/renderer/src/services/pipeline/__tests__/prompt-loader.runtime-skills.test.ts src/renderer/src/services/pipeline/__tests__/director-pipeline-skill-init.test.ts src/renderer/src/react-app/__tests__/DirectorApp.refresh-skills.test.tsx src/renderer/src/services/pipeline/__tests__/runtime-skills-regression.test.ts && npm run typecheck && npm run build:vite`  
Expected: 全部 PASS；构建成功。

**Step 5: Commit**

```bash
git add src/renderer/src/services/pipeline/__tests__/runtime-skills-regression.test.ts docs/plans/2026-03-03-director-runtime-skill-loading.md
git commit -m "test(pipeline): add runtime skill loading regression matrix"
```

---

## Final Verification Checklist (Before PR)

- [ ] `npm run test:run -- src/renderer/src/services/pipeline/__tests__/prompt-loader.runtime-skills.test.ts`
- [ ] `npm run test:run -- src/renderer/src/services/pipeline/__tests__/director-pipeline-skill-init.test.ts`
- [ ] `npm run test:run -- src/renderer/src/react-app/__tests__/DirectorApp.refresh-skills.test.tsx`
- [ ] `npm run test:run -- src/renderer/src/services/pipeline/__tests__/runtime-skills-regression.test.ts`
- [ ] `npm run typecheck`
- [ ] `npm run build:vite`

## Risk Notes

- 如果 `vitest` 在当前仓库未配置 JSX transform，需要先补充最小 `vitest` 配置（仅作为测试基础设施，不改变业务逻辑）。
- 若 `window.electronAPI` 在测试环境不可用，统一通过 `vi.stubGlobal('window', ...)` 注入 mock。
- 若 `DirectorPipeline.execute()` 测试依赖过重，优先抽 `ensureSkillsReady()` 小函数后单测该函数调用链。

