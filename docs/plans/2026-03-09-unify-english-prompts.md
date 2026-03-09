# 全管线统一英文 Prompt Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 DirectorPipeline 中所有发给 LLM 的 user message 从中文统一为英文，消除中英混杂导致的模型混乱，与之前 Task Planning 的英文统一改动对齐。

**Architecture:** 逐 Pass 检查 user message 中的中文内容，替换为等义英文。不改 UI 标签（那些是给用户看的），只改发给 LLM 的消息内容。

**Tech Stack:** TypeScript

---

## 需要改的位置

| Pass | 行号 | 当前中文 | 问题 |
|------|------|---------|------|
| Pass 4 designAndAssemble | 1497 | `【创意简报】...请基于该简报为 N 个分镜设计镜头并生成图像提示词...` | LLM 收到中文指令但要输出英文 prompt |
| Pass 4 designAndAssemble | 1498 | `为 N 个分镜设计镜头并生成图像提示词` | 无 sceneDescription 时的中文 fallback |

注：Pass 1/2/3 和 Task Planning 的 user message 已在本 session 早前改为英文。UI 标签（`label: '场景分析'` 等）保留中文不改。

---

### Task 1: Pass 4 user message 改英文

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts:1496-1498`

**Step 1: 替换中文 user message**

找到 (约 line 1496-1498):

```typescript
      const userText = state.sceneDescription
        ? `【创意简报】"${state.sceneDescription}"\n\n请基于该简报为 ${state.layout.panelCount} 个分镜设计镜头并生成图像提示词。\n人物身份锚点（脸、发型、服装、主配色、武器）应优先保持可识别一致；允许人物在故事推进中发生合理演进（情绪、姿态、受损、衣物动态）。\n场景可随叙事节奏推进自然变化，不需要所有分镜固定同一地点。\n叙事方向与节奏以用户简报为主线，可做电影化增强但不反转核心走向。\n每个分镜建议 1 个主动作（anchor action）+ 1~2 个从属动作（satellite actions），避免无因突变。\n导演可自主决定镜头、构图、光影、调度与节奏张弛。`
        : `为 ${state.layout.panelCount} 个分镜设计镜头并生成图像提示词`
```

替换为：

```typescript
      const userText = state.sceneDescription
        ? [
            `CREATIVE BRIEF: "${state.sceneDescription}"`,
            '',
            `Design ${state.layout.panelCount} storyboard panels with shot design and image generation prompts based on the brief above.`,
            'Character identity anchors (face, hairstyle, outfit, primary colors, weapons) MUST remain recognizably consistent across panels.',
            'Characters MAY evolve naturally through the story (emotion, pose, battle damage, clothing dynamics).',
            'Scenes MAY transition with narrative pacing — not all panels need to share the same location.',
            'Narrative direction and rhythm follow the user brief as the main line; cinematic enhancement is encouraged but do not reverse the core story arc.',
            'Each panel: 1 anchor action + 1-2 satellite actions. Avoid unmotivated sudden changes.',
            'The director has full authority over shot design, composition, lighting, staging, and pacing.',
          ].join('\n')
        : `Design ${state.layout.panelCount} storyboard panels with shot design and image generation prompts.`
```

**Step 2: 运行测试**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx vitest run src/renderer/src/services/pipeline/__tests__/ --reporter=verbose`

Expected: All pass

---

### Task 2: 验证无残留中文 LLM 指令

**Step 1: 搜索所有发给 LLM 的中文指令**

排除 UI 标签（`label:` 和 `writer(config)` 中的中文是给 UI 的，不是给 LLM 的）。

需要确认以下位置**不**包含发给 LLM 的中文：
- `role: 'system'` 的 `content`
- `role: 'user'` 的 `content` / `text`
- `role: 'assistant'` 的 `content`

已确认干净的 Pass：
- Pass 0 taskPlanning: ✓ 英文 (本 session 改过)
- Pass 1 analyzeScene: ✓ 英文 (本 session 改过)
- Pass 2 extractCharacterAnchors: ✓ 英文 (本 session 改过)
- Pass 3 extractStyleAnchor: ✓ 英文 (本 session 改过)
- Pass 4 designAndAssemble: Task 1 改
- Pass 5 verifyConsistency: 检查（用 .md 模板，应该是英文）
- Pass 6 generateImages: 检查（contact sheet 模板）

**Step 2: 检查 Pass 5 verify**

Run: `rg "请|验证|校验|一致性" src/renderer/src/services/pipeline/DirectorPipeline.ts` — 排除 label/writer 行，确认 verify 的 system/user message 无中文。

**Step 3: 检查 prompt 模板**

Run: `rg "[\x{4e00}-\x{9fff}]" config/prompts/director/*.md` — 确认所有 .md 模板无中文（它们是系统提示词的一部分）。

---

## 改动总结

| 文件 | 改动 |
|------|------|
| `DirectorPipeline.ts:1496-1498` | Pass 4 user message: 中文 → 英文 |

**不改的：**
- UI 标签 (`label: '场景分析'` 等) — 给用户看的，保留中文
- `writer(config)` emit 的 label — UI 进度显示，保留中文
- `console.log/warn` 中的中文注释 — 开发日志，不影响 LLM
