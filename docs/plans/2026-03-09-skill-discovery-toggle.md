# Skill Discovery 开关 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在导演模式 UI 中添加一个开关，允许用户禁用 LLM Skill Discovery（每 Pass 省 1-3 次额外 LLM 调用），同时保留静态 Skill 规则注入。

**Architecture:** 新增 `skipSkillDiscovery` boolean，从 UI store → pipeline input → 每个 Pass 的 `runSkillDiscovery()` 调用前做判断。关闭时 Skill Discovery 跳过，但 skill 规则仍通过 `BasePipeline.buildSystemPrompt()` 的静态 `getSkillRulesForPhase()` 路径注入。

**Tech Stack:** TypeScript, React (Zustand store), Zod, LangGraph

---

## 背景

当前 DirectorPipeline 每个 Pass 都调用 `runSkillDiscovery()`，这是一个 LLM tool-calling 循环（最多 3 次 LLM 调用），用来让 LLM 自己选择要读取哪些 Skill。但 Skill 内容是**构建时已知的静态文件**，`BasePipeline.buildSystemPrompt()` 已经能通过 `getSkillRulesForPhase()` 确定性地注入相关 Skill 规则。

| 模式 | Skill Discovery ON (默认) | Skill Discovery OFF |
|------|--------------------------|---------------------|
| Skill 注入 | LLM 自选 + 读取 (1-3 次 LLM) | 静态匹配注入 (0 次 LLM) |
| 每 Pass 额外耗时 | ~2-5s | 0s |
| 5 个 Pass 总额外耗时 | ~10-25s | 0s |
| Skill 匹配精度 | LLM 判断（可能更智能） | phase-based 匹配（确定性） |

---

### Task 1: DirectorState 添加 skipSkillDiscovery 字段

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts:38-92`

**Step 1: 在 stateSchema 中添加字段**

在 `scoreThreshold` 行（约 line 90）之后添加：

```typescript
  skipSkillDiscovery: z.boolean().default(false),
```

**Step 2: 验证编译**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx vitest run src/renderer/src/services/pipeline/__tests__/assembleCoherentPrompt.test.ts --reporter=verbose`

Expected: PASS (schema change is backward compatible)

---

### Task 2: DirectorPipeline 各 Pass 增加 skipSkillDiscovery 判断

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts` (5 处 runSkillDiscovery 调用)

**概述：** 每个 Pass 的 `runSkillDiscovery()` 调用前增加 `if (!state.skipSkillDiscovery)` 判断。当 skip 时，改用 `self.buildSystemPrompt()` 的确定性路径（它内部调用 `getSkillRulesForPhase()`）。

**Step 1: Pass 1 analyzeScene (约 line 1030)**

找到：
```typescript
        let discoveredSkillRules = ''
        try {
          const discoveryResult = await skillsMw.runSkillDiscovery({
```

改为：
```typescript
        let discoveredSkillRules = ''
        if (!state.skipSkillDiscovery) {
          try {
            const discoveryResult = await skillsMw.runSkillDiscovery({
              llm: self.createLLM(),
              phase: 'analyzeScene',
              context: state as Record<string, unknown>,
              basePrompt: 'You are an expert scene analyst. Before analyzing, review available skills for relevant techniques.',
              userMessage: 'Read any relevant skills for scene analysis, then confirm you are ready.',
              maxIterations: 3,
              signal: config?.signal,
            })
            discoveredSkillRules = discoveryResult.loadedSkillBodies
          } catch (e: unknown) {
            console.warn('[DirectorPipeline] Pass 1 skill discovery failed:', e instanceof Error ? e.message : String(e))
          }
        }
```

注意闭合大括号的位置 — 只包裹 `try/catch` 块，不影响后续 prompt 拼接逻辑。

**Step 2: Pass 2 extractCharacterAnchors (约 line 1113)**

同样模式 — 在 `runSkillDiscovery` 调用外包一层 `if (!state.skipSkillDiscovery)`。

**Step 3: Pass 3 extractStyleAnchor (约 line 1207)**

同样模式。

**Step 4: Pass 4 designAndAssemble**

Pass 4 已经有 `if (allPhaseSkills.length > 0)` 判断。在此基础上增加 `&& !state.skipSkillDiscovery`：

```typescript
// Before:
if (allPhaseSkills.length > 0) {
  try {
    const discoveryResult = await skillsMw.runSkillDiscovery({...})

// After:
if (allPhaseSkills.length > 0 && !state.skipSkillDiscovery) {
  try {
    const discoveryResult = await skillsMw.runSkillDiscovery({...})
```

**Step 5: Pass 5 verifyConsistency (约 line 1547)**

同样模式。

**Step 6: 当 skipSkillDiscovery=true 时，确保静态 Skill 规则仍注入**

检查每个 Pass：当 `discoveredSkillRules` 为空时，`systemPrompt` 的拼接逻辑应该仍然可用。当前代码：

```typescript
const systemPromptBase = discoveredSkillRules
  ? `${basePrompt}\n\n--- Loaded Skills ---\n${discoveredSkillRules}`
  : basePrompt
```

当 skip 时 `discoveredSkillRules` 为空，所以 `systemPromptBase = basePrompt`。但这样 Skill 规则就完全没有了。

需要在 `discoveredSkillRules` 为空时，走静态注入路径：

```typescript
const systemPromptBase = discoveredSkillRules
  ? `${basePrompt}\n\n--- Loaded Skills ---\n${discoveredSkillRules}`
  : self.buildSystemPrompt('analyzeScene', basePrompt, state as Record<string, unknown>, { skipSkillInjection: false })
```

但 `buildSystemPrompt` 已经把 skill rules 拼在 base prompt 后面了，所以直接用：

```typescript
const systemPromptBase = discoveredSkillRules
  ? `${basePrompt}\n\n--- Loaded Skills ---\n${discoveredSkillRules}`
  : basePrompt
const systemPromptWithSkills = discoveredSkillRules
  ? systemPromptBase
  : self.buildSystemPrompt('analyzeScene', basePrompt, state as Record<string, unknown>)
const systemPrompt = self.injectTaskPlan(systemPromptWithSkills, state.taskPlan)
```

对 5 个 Pass 都做同样的改动。这样：
- Discovery ON: LLM 选择 skill → 手动拼接到 prompt
- Discovery OFF: `buildSystemPrompt()` → `getSkillRulesForPhase()` → 静态注入

**Step 7: 运行测试**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx vitest run src/renderer/src/services/pipeline/__tests__/ --reporter=verbose`

Expected: All pass (schema change backward compatible, existing tests don't set skipSkillDiscovery)

---

### Task 3: useDirectorStore 添加 skipSkillDiscovery 状态

**Files:**
- Modify: `src/renderer/src/react-app/stores/useDirectorStore.ts`

**Step 1: 添加 localStorage key**

在 `DIRECTOR_VISION_DETAIL_VERIFY_CONSISTENCY_STORAGE_KEY` 行之后添加：

```typescript
const DIRECTOR_SKIP_SKILL_DISCOVERY_STORAGE_KEY = 'director.skip-skill-discovery.v1'
```

**Step 2: ConfigSlice 接口添加字段**

在 `scoreThreshold: number` 行之后添加：

```typescript
  skipSkillDiscovery: boolean
```

在 `setScoreThreshold: (val: number) => void` 行之后添加：

```typescript
  setSkipSkillDiscovery: (val: boolean) => void
```

**Step 3: initialConfigState 添加默认值**

在 `createInitialConfigState` 返回对象中，`scoreThreshold` 之后添加：

```typescript
  skipSkillDiscovery: readSkipFlag(DIRECTOR_SKIP_SKILL_DISCOVERY_STORAGE_KEY),
```

**Step 4: createConfigSlice 添加 setter**

在 `setScoreThreshold` 方法之后添加：

```typescript
  setSkipSkillDiscovery: (val) => {
    writeSkipFlag(DIRECTOR_SKIP_SKILL_DISCOVERY_STORAGE_KEY, val)
    set({ skipSkillDiscovery: val })
  },
```

**Step 5: 更新 createInitialConfigState 的 Pick 类型**

在 `createInitialConfigState` 的 `Pick<ConfigSlice, ...>` 中添加 `'skipSkillDiscovery'`。

---

### Task 4: useDirectorGeneration 透传 skipSkillDiscovery

**Files:**
- Modify: `src/renderer/src/react-app/hooks/useDirectorGeneration.ts`

**Step 1: 从 store 解构 skipSkillDiscovery**

在现有的 `useDirectorStore` 解构中添加 `skipSkillDiscovery`。

**Step 2: 传入 pipeline.execute()**

在 `executeSingle` 的 input 对象中，`scoreThreshold` 之后添加：

```typescript
          skipSkillDiscovery,
```

**Step 3: 添加到 useCallback deps**

在 `executeSingle` 的依赖数组中添加 `skipSkillDiscovery`。

---

### Task 5: DirectorApp.tsx 添加 UI 开关

**Files:**
- Modify: `src/renderer/src/react-app/DirectorApp.tsx`

**Step 1: 从 store 解构**

在 `DirectorApp` 组件中从 `useDirectorStore` 解构 `skipSkillDiscovery` 和 `setSkipSkillDiscovery`。

**Step 2: 在看图质量控件之后添加 Skill Discovery 开关**

在看图质量 `</div>` 闭合标签（约 line 338）之后，添加：

```tsx
          <div className="border border-[#27272A] p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-xs text-white/80">Skill 加载</div>
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <label className="relative inline-flex items-center cursor-pointer shrink-0">
                  <input
                    type="checkbox"
                    checked={!skipSkillDiscovery}
                    onChange={() => setSkipSkillDiscovery(!skipSkillDiscovery)}
                    className="sr-only peer"
                    aria-label="启用 Skill Discovery"
                  />
                  <div className="w-7 h-4 bg-[#3F3F46] rounded-full peer peer-checked:bg-yellow-500 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:after:translate-x-3" />
                </label>
                <span className={`text-[11px] ${skipSkillDiscovery ? 'text-white/30' : 'text-white/65'}`}>
                  LLM Skill Discovery
                </span>
              </div>
              <span className="text-[10px] text-white/40">
                {skipSkillDiscovery ? '已关闭 (静态注入)' : '已开启 (LLM 自选)'}
              </span>
            </div>
            <div className="text-[11px] text-white/45">
              关闭后跳过每阶段的 Skill Discovery LLM 调用（省 ~10-25s），Skill 规则仍通过静态匹配注入。
            </div>
            <div className="flex items-center gap-2 mt-1">
              <button
                type="button"
                onClick={handleRefreshSkills}
                disabled={isRefreshingSkills}
                className="px-2.5 py-1.5 text-[11px] border border-[#3F3F46] bg-[#09090B] text-white/70 hover:text-white hover:bg-[#18181B] transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isRefreshingSkills ? '刷新中...' : '刷新 Skills'}
              </button>
              <button
                type="button"
                onClick={handleOpenSkillsFolder}
                className="px-2.5 py-1.5 text-[11px] border border-[#3F3F46] bg-[#09090B] text-white/70 hover:text-white hover:bg-[#18181B] transition-colors cursor-pointer"
              >
                打开 Skills 文件夹
              </button>
            </div>
          </div>
```

注意：「刷新 Skills」和「打开 Skills 文件夹」按钮从原来的位置移到这个新的 Skill 面板中，统一管理。如果原位置还有这两个按钮，需要删除避免重复。

**Step 3: 检查并删除原有的刷新/打开按钮**

搜索 `DirectorApp.tsx` 中其他位置的 `handleRefreshSkills` 和 `handleOpenSkillsFolder` 按钮引用，如果有重复的渲染，删除旧的。

---

### Task 6: 端到端验证

**Step 1: 运行 pipeline 测试**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx vitest run src/renderer/src/services/pipeline/__tests__/ --reporter=verbose`

Expected: All pass

**Step 2: 运行 store 测试**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx vitest run src/renderer/src/react-app/stores/__tests__/ --reporter=verbose`

Expected: All pass

**Step 3: 手动验证 UI**

1. 启动 dev server
2. 打开导演模式页面
3. 确认看到新的 "Skill 加载" 面板
4. 切换开关，确认 localStorage 持久化
5. 运行一次生成，确认 console 中 Pass 1-5 日志体现 skill discovery 是否跳过

---

## 改动总结

| 文件 | 改动 |
|------|------|
| `DirectorPipeline.ts` | +1 state 字段, 5 处 `runSkillDiscovery` 增加 `skipSkillDiscovery` 判断 + 静态 fallback |
| `useDirectorStore.ts` | +1 field + setter + localStorage key + persistence |
| `useDirectorGeneration.ts` | 透传 `skipSkillDiscovery` 到 pipeline input |
| `DirectorApp.tsx` | 新增 Skill 加载面板 (toggle + 刷新 + 打开文件夹) |

**预期效果：** 关闭 Skill Discovery 后，5 个 Pass 省去共 5-15 次额外 LLM 调用（~10-25s），Skill 规则仍通过 `buildSystemPrompt → getSkillRulesForPhase` 静态注入。
