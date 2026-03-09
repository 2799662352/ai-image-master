# StoryboardProPipeline sceneDecompose 持续失败修复

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复 sceneDecompose 双层（L1+L2）均失败的问题，使场景分解与角色提取达到同等可靠性。

**Architecture:** 三个独立修复：(1) L2 补传 `jsonMode`；(2) falsy 检查放宽；(3) L1 用扁平化 scene schema 替代嵌套 timeline schema + 加诊断日志。

**Tech Stack:** `@langchain/openai` ^1.2.10, `zod` ^4.3.6, `vitest` ^4.0.18

**根因分析:**
- characterExtract L1 `jsonMode` 成功 → L2 永远不被执行
- sceneDecompose L1 `jsonMode` 失败（`StoryboardSceneSchema` 有 5 必填字段 + 嵌套 `timeline` 数组太复杂）
- sceneDecompose L2 退回默认 `functionCalling` → 这就是最初要修的 proxy bug → 也失败
- 即使 L2 返回了 `{ d: "" }`，`if (simpleResult?.d)` 空字符串被 JS falsy 规则误判为失败

---

## 修复总览

| 优先级 | 任务 | 改动 | 预计耗时 |
|--------|------|------|----------|
| P0 | Task 1: L2 补传 jsonMode + falsy 检查修复 | `StoryboardProPipeline.ts` 4 处 | 5 min |
| P1 | Task 2: L1 用扁平化 scene schema | `StoryboardProPipeline.ts` schema + sceneDecomposeFn | 10 min |
| P1 | Task 3: 添加诊断日志 | `StoryboardProPipeline.ts` L1/L2 关键路径 | 5 min |

---

### Task 1: L2 补传 jsonMode + falsy 检查修复 (P0)

**文件:**
- 修改: `src/renderer/src/services/storyboard-pipeline/StoryboardProPipeline.ts`

**问题 1 — sceneDecompose L2 没传 jsonMode:**

行 274:
```typescript
// BEFORE (退回 functionCalling — 就是最初的 bug):
const simpleStructured = self.createStructuredLLM(SimpleSceneSchema)
// AFTER:
const simpleStructured = self.createStructuredLLM(SimpleSceneSchema, undefined, 4096, 'jsonMode')
```

**问题 2 — characterExtract L2 也没传 jsonMode（防御性修复）:**

行 354:
```typescript
// BEFORE:
const simpleStructured = self.createStructuredLLM(SimpleObjArraySchema)
// AFTER:
const simpleStructured = self.createStructuredLLM(SimpleObjArraySchema, undefined, 4096, 'jsonMode')
```

**问题 3 — sceneDecompose L2 的 falsy 检查过严:**

行 276:
```typescript
// BEFORE (空字符串 "" 被误判为失败):
if (simpleResult?.d) {
// AFTER:
if (simpleResult && typeof simpleResult.d === 'string') {
```

**问题 4 — characterExtract L2 同样加固（防御性修复）:**

行 356:
```typescript
// BEFORE:
if (simpleResult?.objs?.length) {
// AFTER (这个本身没问题因为 length > 0 不会是 falsy，但确保一致性):
if (simpleResult?.objs?.length) {  // 保持不变，length 检查本身是安全的
```

**Step 1: 运行现有测试确认基线**

```bash
npx vitest run src/renderer/src/services/storyboard-pipeline/
```
预期: 全部 PASS

**Step 2: 修改代码（共 3 处改动）**

文件 `src/renderer/src/services/storyboard-pipeline/StoryboardProPipeline.ts`:

改动 1 — sceneDecompose L2 加 jsonMode（约行 274）:
```typescript
const simpleStructured = self.createStructuredLLM(SimpleSceneSchema, undefined, 4096, 'jsonMode')
```

改动 2 — sceneDecompose L2 falsy 检查放宽（约行 276）:
```typescript
if (simpleResult && typeof simpleResult.d === 'string') {
```

改动 3 — characterExtract L2 加 jsonMode（约行 354）:
```typescript
const simpleStructured = self.createStructuredLLM(SimpleObjArraySchema, undefined, 4096, 'jsonMode')
```

**Step 3: 运行测试确认无回归**

```bash
npx vitest run src/renderer/src/services/storyboard-pipeline/
npx vitest run src/renderer/src/services/pipeline/
```
预期: 全部 PASS

**Step 4: 提交**

```bash
git add src/renderer/src/services/storyboard-pipeline/StoryboardProPipeline.ts
git commit -m "fix(storyboard-pro): L2 补传 jsonMode + 修复 falsy 检查

sceneDecompose/characterExtract 的 L2 降级没传 jsonMode，
退回了有 bug 的默认 functionCalling 路径。
同时修复 simpleResult?.d 的空字符串 falsy 误判。"
```

---

### Task 2: L1 用扁平化 scene schema (P1)

**问题:** `StoryboardSceneSchema` 有 5 个必填字段 + 嵌套 `timeline` 数组，对 `jsonMode` 来说太复杂。
导演模式的 `SceneAnalysisSchema` 只有 4 字段（env, subjects, style, story[optional]），全部扁平。

**文件:**
- 修改: `src/renderer/src/services/storyboard-pipeline/StoryboardProPipeline.ts`

**Step 1: 新增扁平化 L1 scene schema**

在 `SimpleSceneSchema` 定义之后（约行 52）添加:

```typescript
const FlatSceneSchema = z.object({
  d: z.string().describe('Narrative arc: A(initial)→B(trigger)→C(end state)'),
  cap: z.string().describe('Structured caption: subject-action-environment'),
  env: z.string().describe('Environment: lighting, color palette, atmosphere'),
  bgm: z.string().default('').describe('Sound design layers'),
  shotCount: z.number().default(4).describe('Number of shots identified'),
})
```

关键设计：
- 去掉嵌套 `timeline` 数组 → 改为简单的 `shotCount` 数字
- `bgm` 改为 `.default('')` 允许为空
- 描述改为英文（模型更擅长解析英文 schema 指令）

**Step 2: 修改 sceneDecompose L1 用 FlatSceneSchema**

约行 254-265，将 L1 的 schema 改为 `FlatSceneSchema`:

```typescript
// --- L1: Flat scene schema + jsonMode + includeRaw + greedy regex ---
let scene: any = null
try {
  const structuredWithRaw = self.createStructuredLLMWithRaw(FlatSceneSchema, undefined, 4096, 'jsonMode')
  const response = await structuredWithRaw.invoke(userMessages, { signal: config?.signal })
  scene = (response as any)?.parsed
  if (scene && typeof scene.d === 'string') {
    // 补充 timeline 为空数组以兼容下游
    if (!scene.timeline) scene.timeline = []
  }
  if (!scene || typeof scene.d !== 'string') {
    const rawText = typeof (response as any)?.raw?.content === 'string'
      ? (response as any).raw.content : ''
    try {
      const match = rawText.match(/\{[\s\S]*"d"\s*:[\s\S]*\}/)
      if (match) {
        scene = JSON.parse(match[0])
        if (!scene.timeline) scene.timeline = []
      }
    } catch { /* L2 below */ }
  }
} catch (e: unknown) {
  console.warn('[StoryboardProPipeline] sceneDecompose L1 error:', e instanceof Error ? e.message : String(e))
}
```

**Step 3: 运行测试**

```bash
npx vitest run src/renderer/src/services/storyboard-pipeline/
```
预期: 全部 PASS

**Step 4: 提交**

```bash
git add src/renderer/src/services/storyboard-pipeline/StoryboardProPipeline.ts
git commit -m "feat(storyboard-pro): sceneDecompose L1 改用扁平化 FlatSceneSchema

去掉嵌套 timeline 数组，改为简单 shotCount 数字字段。
bgm 改 default('') 允许为空。描述改英文提高 jsonMode 解析率。
下游 shotDesign 不依赖 timeline 数据，只需 d/cap/env。"
```

---

### Task 3: 添加诊断日志 (P1)

**文件:**
- 修改: `src/renderer/src/services/storyboard-pipeline/StoryboardProPipeline.ts`

**Step 1: L1 失败时打印 raw 内容预览**

在 sceneDecompose L1 的 regex fallback 之前（约行 258），添加:

```typescript
if (!scene || typeof scene.d !== 'string') {
  const rawContent = (response as any)?.raw?.content
  const rawText = typeof rawContent === 'string' ? rawContent : ''
  console.warn('[StoryboardProPipeline] sceneDecompose L1 parsed empty.',
    'rawContent type:', typeof rawContent,
    'rawText length:', rawText.length,
    'preview:', rawText.slice(0, 300))
  // ... regex fallback
```

**Step 2: L2 返回后打印结果类型**

在 sceneDecompose L2 的结果检查处（约行 275-276），添加:

```typescript
const simpleResult = await simpleStructured.invoke(userMessages, { signal: config?.signal })
console.log('[StoryboardProPipeline] sceneDecompose L2 result:', 
  simpleResult ? `d="${simpleResult.d}" cap="${(simpleResult.cap || '').slice(0, 50)}"` : 'null')
if (simpleResult && typeof simpleResult.d === 'string') {
```

**Step 3: 运行测试确认无回归**

```bash
npx vitest run src/renderer/src/services/storyboard-pipeline/
```

**Step 4: 提交**

```bash
git add src/renderer/src/services/storyboard-pipeline/StoryboardProPipeline.ts
git commit -m "chore(storyboard-pro): sceneDecompose 添加 L1/L2 诊断日志

打印 rawContent 类型、长度和预览，以及 L2 结果字段值，
便于定位 jsonMode 解析失败的具体原因。"
```

---

## 验证

```bash
# 测试
npx vitest run src/renderer/src/services/storyboard-pipeline/
npx vitest run src/renderer/src/services/pipeline/

# 端到端
npm run dev
# → 图像理解 → 上传图片 → 分镜Pro → 观察控制台:
#   期望看到 "sceneDecompose L2 success" 或 L1 直接成功
#   不应再看到 "all extraction levels failed"
```

## 修复后的完整 sceneDecompose 降级路径

```
L1: jsonMode + FlatSceneSchema (5 字段, 扁平, 英文描述)
  ↓ 失败
L2: jsonMode + SimpleSceneSchema (3 字段, 超简单)
  ↓ 失败
→ scene = { d: '(analysis failed)' }
→ Analysis Gate 根据 objs 决定是否继续
```

**对比修复前:**
```
L1: jsonMode + StoryboardSceneSchema (5 字段 + 嵌套 timeline 数组)  ← 太复杂
  ↓ 失败
L2: functionCalling(默认) + SimpleSceneSchema  ← 原始 bug！
  ↓ 失败
→ 双双失败
```
