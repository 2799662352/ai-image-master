# Pipeline 质量精修 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 Pass 4 校验发现的问题能自动触发 Pass 3 精修，确保遗漏的台词和情节被补全。

**Architecture:** 将重试阈值从 score<6 提高到 score<9，并改进重试逻辑：Pass 4 的 issues 反馈给 Pass 3 时，要求 Pass 3 只修正被指出的问题，保留其他已通过校验的内容。

**Tech Stack:** `@langchain/langgraph`, TypeScript, Zod

---

### Task 1: 提高重试阈值 + 增加重试次数

**Files:**
- Modify: `src/renderer/src/services/storyboard-pipeline/StoryboardPipelineService.ts`

**Step 1: 将 `shouldRetry` 函数的阈值从 6 改为 9，重试次数从 1 改为 2**

将:
```typescript
if (state.report && state.report.score < 6 && state.retryCount < 1) {
```

改为:
```typescript
if (state.report && state.report.score < 9 && state.retryCount < 2) {
```

**Step 2: Build 验证**

Run: `npm run build:vite 2>&1 | Select-String "error|built in"`

**Step 3: Commit**

```bash
git add src/renderer/src/services/storyboard-pipeline/StoryboardPipelineService.ts
git commit -m "feat: raise pipeline retry threshold to score<9, allow 2 retries"
```

---

### Task 2: 改进 Pass 3 重试时的指令（增量修正而非全部重生成）

**Files:**
- Modify: `src/renderer/src/services/storyboard-pipeline/StoryboardPipelineService.ts`

**Step 1: 在 generateShots 函数中，当有 retryFeedback 时，修改指令为增量修正模式**

将现有的:
```typescript
if (state.retryFeedback) {
  userText += `\n\n--- 校验反馈(请修正) ---\n${state.retryFeedback}`
}
```

改为:
```typescript
if (state.retryFeedback) {
  userText += `\n\n--- 校验反馈(增量修正) ---
以下是校验发现的问题，请仅修正被指出的问题，保留其他已通过校验的镜头不变：
${state.retryFeedback}

重要：
- 被指出有问题的镜头：修正该问题
- 如果建议拆分镜头（如S4a/S4b），可以增加镜头数量
- 未被提及的镜头：保持原样不变
- 修正后的台词必须从剧本原文提取`
}
```

**Step 2: Build 验证**

**Step 3: Commit**

```bash
git add src/renderer/src/services/storyboard-pipeline/StoryboardPipelineService.ts
git commit -m "feat: improve retry instruction for incremental shot refinement"
```

---

### Task 3: 进度 UI 显示重试状态

**Files:**
- Modify: `src/renderer/src/pages/UnderstandPage.ts`

**Step 1: 在 onPipelineProgress 中处理重试情况**

当 Pass 3 第二次触发时（重试），在进度 UI 中显示"Pass 3: 分镜精修中..."而非覆盖已完成的标记。

在 `onPipelineProgress` 方法中，检查 pass 3 是否已经完成过：

```typescript
if (nodeName === 'generateShots') {
  const passEl = document.getElementById('pipelinePass3')
  const statusEl = passEl?.querySelector('span:last-child')
  if (statusEl?.textContent === '✓ 完成') {
    // 这是重试
    statusEl.textContent = '🔄 精修中...'
    statusEl.className = 'ml-auto text-orange-400 animate-pulse'
  }
  // ... 正常逻辑
}
```

**Step 2: Build 验证**

**Step 3: Commit**

---

### Task 4: Build + 运行时验证

**Step 1: Full Build**

Run: `npm run build:vite`

**Step 2: 运行时验证**

1. 用剧本（含台词）+ 九宫格图片分析
2. 观察 Pass 4 评分 < 9 时是否触发重试
3. 重试后 Pass 3 应只修正被指出的问题
4. 进度 UI 应显示"精修中"状态

---

## 其他下一步计划（新 session）

1. **UnderstandPage 镜头数选择器 UI** — 让用户手动选 4/6/9/自适应
2. **InMemoryStore 角色复用** — 同一项目多场次分析共享角色锚点
3. **导演模式多 Pass 升级** — LangChainDirectorService 也改为 StateGraph
4. **i18n 完善** — 英文/繁中/俄文的 importSuccess 翻译
