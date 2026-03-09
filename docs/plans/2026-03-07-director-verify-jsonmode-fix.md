# DirectorPipeline verifyConsistency jsonMode 修复

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复导演模式 Pass 5 (一致性校验) 因 `functionCalling` 通过 proxy 崩溃的问题。

**Architecture:** 将 `verifyConsistencyFn` 和 `StoryboardProPipeline.deepVerifyFn` 的 `createStructuredLLM` 调用切换到 `jsonMode`，与分镜 Pro 的成功模式对齐。

**Tech Stack:** `@langchain/openai` ^1.2.10, `vitest` ^4.0.18

**根因:** `createStructuredLLM(VerifySchema)` 默认用 `functionCalling`，proxy 对 Gemini 的 function schema 翻译不稳定，导致 LangChain 内部 `undefined.message` 崩溃。Pass 1-4 不受影响，因为它们用 `createStructuredLLMWithRaw`（有 regex fallback）或 schema 极简。

---

### Task 1: DirectorPipeline verifyConsistency 切换 jsonMode

**文件:**
- 修改: `src/renderer/src/services/pipeline/DirectorPipeline.ts` — 行 1157

**Step 1: 运行现有测试确认基线**

```bash
npx vitest run src/renderer/src/services/pipeline/
```
预期: 全部 PASS

**Step 2: 修改代码（1 行）**

文件 `src/renderer/src/services/pipeline/DirectorPipeline.ts`，约行 1157:

```typescript
// BEFORE:
const structured = self.createStructuredLLM(VerifySchema)
// AFTER:
const structured = self.createStructuredLLM(VerifySchema, undefined, 4096, 'jsonMode')
```

**Step 3: 运行测试确认无回归**

```bash
npx vitest run src/renderer/src/services/pipeline/
```
预期: 全部 PASS

**Step 4: 提交**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts
git commit -m "fix(director): verifyConsistency 切换 jsonMode 修复 proxy 崩溃

Pass 5 用 functionCalling 通过 proxy 路由 Gemini 时 LangChain 内部
undefined.message 崩溃。切换到 jsonMode 与分镜 Pro 的成功模式对齐。
Pass 1-4 不受影响（有 raw fallback 或 schema 极简）。"
```

---

### Task 2: StoryboardProPipeline deepVerify 同步修复

**文件:**
- 修改: `src/renderer/src/services/storyboard-pipeline/StoryboardProPipeline.ts`

分镜 Pro 的 deepVerifyFn 也用了 `createStructuredLLM(VerifySchema)` 无 methodOverride。虽然目前日志没报错（可能还没触发 deepVerify 路径），但同样的隐患存在。

**Step 1: 找到代码位置**

在 `StoryboardProPipeline.ts` 的 `deepVerifyFn` 中搜索 `createStructuredLLM(VerifySchema)`。

**Step 2: 修改代码（1 行）**

```typescript
// BEFORE:
const structured = self.createStructuredLLM(VerifySchema)
// AFTER:
const structured = self.createStructuredLLM(VerifySchema, undefined, 4096, 'jsonMode')
```

**Step 3: 运行测试**

```bash
npx vitest run src/renderer/src/services/storyboard-pipeline/
npx vitest run src/renderer/src/services/pipeline/
```
预期: 全部 PASS

**Step 4: 提交**

```bash
git add src/renderer/src/services/storyboard-pipeline/StoryboardProPipeline.ts
git commit -m "fix(storyboard-pro): deepVerify 同步切换 jsonMode

与 DirectorPipeline verifyConsistency 同样的防御性修复，
避免 functionCalling 通过 proxy 路由 Gemini 时崩溃。"
```

---

## 验证

```bash
# 全部测试
npx vitest run src/renderer/src/services/pipeline/
npx vitest run src/renderer/src/services/storyboard-pipeline/

# 端到端 — 导演模式
npm run dev
# → 导演模式 → 上传图片 → 生成
# → 控制台不应再出现 "Pass 5 (verifyConsistency) failed: Cannot read properties of undefined"
# → 应看到 "一致性校验完成 (score: X/10)"
```
