# StoryboardProPipeline sceneDecompose 嵌套响应 unwrap 修复

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复 sceneDecompose 中模型返回嵌套 `{ scene: { d, cap, env } }` 而非根级 `{ d, cap, env }` 导致 Zod 解析失败的问题。

**Architecture:** 添加 `unwrapScene` 辅助函数，在 L1 regex fallback 和 L2 解析后自动检测并 unwrap 嵌套的 `scene` 键。L2 从 `createStructuredLLM` 改为 `createStructuredLLMWithRaw` 以获取 raw 内容进行手动 unwrap。

**Tech Stack:** `zod` ^4.3.6, `vitest` ^4.0.18

**根因（已通过诊断日志确认）:**
模型用 `jsonMode` 返回了完整 storyboard 响应 `{ "scene": { "d": "..." }, "objs": [...] }`，
但 `FlatSceneSchema` / `SimpleSceneSchema` 期望 `{ "d": "..." }` 在根级别。
Zod 在根级别找 `d` → `undefined` → 解析失败。

---

### Task 1: 添加 unwrapScene 辅助函数 + 修复 L1 regex fallback

**文件:**
- 修改: `src/renderer/src/services/storyboard-pipeline/StoryboardProPipeline.ts`

**Step 1: 写测试**

在 `src/renderer/src/services/storyboard-pipeline/__tests__/storyboard-regex-fallback.test.ts` 末尾追加：

```typescript
describe('unwrapScene helper', () => {
  function unwrapScene(data: any): any {
    if (data?.scene && typeof data.scene === 'object' && typeof data.scene.d === 'string') return data.scene
    return data
  }

  it('returns scene data when nested inside scene key', () => {
    const wrapped = { scene: { d: 'A→B→C', cap: 'test', env: 'outdoor' }, objs: [{ n: 'Alice' }] }
    const result = unwrapScene(wrapped)
    expect(result.d).toBe('A→B→C')
    expect(result.cap).toBe('test')
  })

  it('returns data as-is when already flat', () => {
    const flat = { d: 'A→B→C', cap: 'test', env: 'outdoor' }
    const result = unwrapScene(flat)
    expect(result.d).toBe('A→B→C')
  })

  it('returns data as-is when scene key has no d field', () => {
    const weird = { scene: { something: 'else' }, d: 'root' }
    const result = unwrapScene(weird)
    expect(result.d).toBe('root')
  })

  it('returns null/undefined as-is', () => {
    expect(unwrapScene(null)).toBeNull()
    expect(unwrapScene(undefined)).toBeUndefined()
  })
})
```

**Step 2: 运行测试验证通过**

```bash
npx vitest run src/renderer/src/services/storyboard-pipeline/__tests__/storyboard-regex-fallback.test.ts
```
预期: 全部 PASS（函数定义在测试内部）

**Step 3: 在 StoryboardProPipeline.ts 中添加 unwrapScene 函数**

在 `shouldRetryStoryboardAnalysis` 函数之后（约行 103 附近），添加：

```typescript
function unwrapScene(data: any): any {
  if (data?.scene && typeof data.scene === 'object' && typeof data.scene.d === 'string') return data.scene
  return data
}
```

**Step 4: 修复 L1 parsed 检查 — 添加 unwrap**

在 sceneDecomposeFn 中，L1 的 `scene = (response as any)?.parsed` 之后（约行 265），添加 unwrap：

```typescript
scene = (response as any)?.parsed
scene = unwrapScene(scene)  // 新增：处理模型返回嵌套 { scene: {...} } 的情况
```

**Step 5: 修复 L1 regex fallback — 添加 unwrap**

在 regex fallback 的 `JSON.parse` 之后（约行 279），添加 unwrap：

```typescript
if (match) {
  scene = JSON.parse(match[0])
  scene = unwrapScene(scene)  // 新增：unwrap 嵌套的 scene 键
  if (!scene.timeline) scene.timeline = []
}
```

**Step 6: 运行测试**

```bash
npx vitest run src/renderer/src/services/storyboard-pipeline/
```
预期: 全部 PASS

**Step 7: 提交**

```bash
git add src/renderer/src/services/storyboard-pipeline/
git commit -m "fix(storyboard-pro): sceneDecompose L1 添加 unwrapScene 处理嵌套响应

模型用 jsonMode 返回完整 storyboard 响应 { scene: {d,cap,env}, objs: [...] }
但 FlatSceneSchema 期望 {d,cap,env} 在根级别。
添加 unwrapScene() 自动检测并 unwrap 嵌套的 scene 键。"
```

---

### Task 2: 修复 L2 — 改用 createStructuredLLMWithRaw + unwrap

**文件:**
- 修改: `src/renderer/src/services/storyboard-pipeline/StoryboardProPipeline.ts`

**问题:** L2 用 `createStructuredLLM`（不含 raw），当 Zod 解析失败时直接抛异常，
无法获取 raw 内容做 unwrap。改为 `createStructuredLLMWithRaw` 以获得 raw fallback 能力。

**Step 1: 修改 L2 代码块**

替换 sceneDecomposeFn 中 L2 部分（约行 288-303）为：

```typescript
// --- L2: Simplified schema fallback with raw unwrap ---
if (!scene?.d) {
  console.warn('[StoryboardProPipeline] sceneDecompose L1 failed, trying L2 SimpleSceneSchema')
  try {
    const simpleWithRaw = self.createStructuredLLMWithRaw(SimpleSceneSchema, undefined, 4096, 'jsonMode')
    const simpleResponse = await simpleWithRaw.invoke(userMessages, { signal: config?.signal })
    let simpleResult = (simpleResponse as any)?.parsed
    simpleResult = unwrapScene(simpleResult)

    if (!simpleResult || typeof simpleResult.d !== 'string') {
      const rawText = typeof (simpleResponse as any)?.raw?.content === 'string'
        ? (simpleResponse as any).raw.content : ''
      try {
        let fallback = JSON.parse(rawText)
        fallback = unwrapScene(fallback)
        if (typeof fallback.d === 'string') simpleResult = fallback
      } catch { /* give up */ }
    }

    console.log('[StoryboardProPipeline] sceneDecompose L2 result:',
      simpleResult ? `d="${(simpleResult.d || '').slice(0, 60)}" cap="${(simpleResult.cap || '').slice(0, 50)}"` : 'null')
    if (simpleResult && typeof simpleResult.d === 'string') {
      scene = { ...simpleResult, bgm: simpleResult.bgm || '', timeline: [] }
      console.log('[StoryboardProPipeline] sceneDecompose L2 success via SimpleSceneSchema')
    }
  } catch (e: unknown) {
    console.warn('[StoryboardProPipeline] sceneDecompose L2 error:', e instanceof Error ? e.message : String(e))
  }
}
```

**Step 2: 运行测试**

```bash
npx vitest run src/renderer/src/services/storyboard-pipeline/
```
预期: 全部 PASS

**Step 3: 提交**

```bash
git add src/renderer/src/services/storyboard-pipeline/StoryboardProPipeline.ts
git commit -m "fix(storyboard-pro): sceneDecompose L2 改用 createStructuredLLMWithRaw + unwrap

L2 从 createStructuredLLM 改为 createStructuredLLMWithRaw，
获得 raw 内容后用 unwrapScene() 处理嵌套响应。
即使 Zod 解析失败，仍可从 raw JSON 中提取有效的 scene 数据。"
```

---

## 验证

```bash
# 测试
npx vitest run src/renderer/src/services/storyboard-pipeline/

# 端到端
npm run dev
# → 图像理解 → 上传图片 → 分镜Pro
# → 控制台应看到:
#   sceneDecompose L1/L2 success（不再 all extraction levels failed）
#   或至少 L2 result: d="..." 有值
```

## 修复后的完整降级路径

```
L1: jsonMode + FlatSceneSchema + includeRaw
  → parsed = unwrapScene(parsed)
  → regex fallback: JSON.parse + unwrapScene
  ↓ 失败
L2: jsonMode + SimpleSceneSchema + includeRaw  ← 新增 raw 能力
  → parsed = unwrapScene(parsed)
  → regex fallback: JSON.parse + unwrapScene
  ↓ 失败
→ scene = { d: '(analysis failed)' }
```
