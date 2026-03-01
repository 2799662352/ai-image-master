# 分镜Pro 台词缺失修复计划

**Goal:** 让分镜Pro 的 LangChain 结构化输出在 `seq[].desc` 中包含台词精华，对齐 schema 定义。

**Root Cause:** Prompt-Schema 不对齐

---

## 问题分析

### Schema 有台词槽位

`LangChainStoryboardService.ts` 中 seq 的 schema：

```typescript
seq: z.array(z.object({
  id: z.string().describe('镜头编号 e.g. S1'),
  desc: z.string().describe('景别|动作|台词精华|心理→外化|运镜')
}))
```

system prompt 也提到：

> 台词→嵌入镜头

### Prompt 文件缺少台词指令

`dist/renderer/data/prompts/sora-storyboard-pro.md` 中 seq 格式：

```
S1: shot+lens|mid-action state|psych externalization|camera move
```

**4 个管道分隔段，没有台词槽位。** Schema 期望 5 段（景别|动作|台词精华|心理→外化|运镜），prompt 只给了 4 段。

### 来源文件位置

- Prompt: `dist/renderer/data/prompts/sora-storyboard-pro.md`（仅存在于 dist，无 src 副本）
- Schema: `src/renderer/src/services/LangChainStoryboardService.ts`
- 角色配置: `dist/renderer/data/understand-roles.json`

---

## 修复方案

### Task 1: 修改 prompt 文件中的 seq 格式定义

**File:** `dist/renderer/data/prompts/sora-storyboard-pro.md`

在 `## 13 Dimensions Quick Reference` 表格中，将 D9 行改为：

```
| D9 分镜序列 | seq.S1-S4 | Per-shot: shot｜state｜key dialogue/内心独白｜psych｜cam (2-4s each) |
```

在 `## JSON Schema` 的 seq 部分，添加台词槽位：

```json
"seq": {
  "S1": "shot+lens|mid-action state|dialogue essence(台词精华/内心独白)|psych externalization|camera move",
  ...
}
```

### Task 2: 更新 seq.S[n] 格式说明

在 `### seq.S[n] — Atomic Shot Encoding` 部分，更新示例：

```
S1: CU 85mm f/1.4 | fist mid-slam on table, glass airborne 5cm |
    "我再也受不了了——" (teeth clenched, half-swallowed) |
    suppressed rage externalized through grip force | static locked tripod
S2: MCU 50mm f/2.0 | face muscles fighting composure, single tear at lid edge |
    (内心独白: 如果我松手，一切就完了) |
    control cracking at eye-corner micro-tremor | slow dolly-in 2cm/s
```

### Task 3: 添加台词提取规则到 Hard Rules

在 `## 10 Hard Rules` 中新增一条（或替换一条较弱的规则）：

```
11. **Dialogue embedding** — If screenplay/context provides dialogue, extract key lines
    and embed in seq.S[n] as `"台词..."(delivery manner)`. Inner monologue uses `(内心独白: ...)`.
    If no dialogue source, write `(无台词)` or describe non-verbal vocalization.
```

### Task 4: Build + 验证

Run: `npm run build:vite`

验证清单：
1. 选择分镜Pro角色 → 上传图片 + 包含台词的剧本 → 分析
2. 检查输出 JSON 的 `seq[].desc` 是否包含台词精华段
3. 不提供剧本时，seq 应标注 `(无台词)` 或声效描写

---

## 临时 Workaround

在"剧本/附加要求"中添加：

> 请将台词精华嵌入每个 shot 描述中，格式为 "台词..."(表演方式)。如无台词，标注(无台词)或描写非语言声效。

---

## 关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 台词格式 | `"台词..."(delivery)` | 与 seq 其他段保持管道分隔，括号内标注表演方式 |
| 无台词处理 | `(无台词)` | 保持 schema 槽位完整，避免模型跳过 |
| 内心独白 | `(内心独白: ...)` | 区分外部台词和内心活动 |
