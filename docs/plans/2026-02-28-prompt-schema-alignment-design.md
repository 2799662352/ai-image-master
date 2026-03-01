# 分镜Pro Prompt-Schema 对齐设计

**Goal:** 消除 prompt 文件与 Zod schema 的结构冲突，让 Zod `.describe()` 成为输出结构的唯一权威，prompt 文件退化为纯领域知识/风格指南。

**Approach:** 选项 A — 保留外部文件，删除其中的 JSON Schema 部分

---

## 问题根因

LangChain `withStructuredOutput(StoryboardResponseSchema)` 使用 Zod schema 约束输出结构，但 prompt 文件中包含一份**不同结构**的 JSON Schema，造成 6 处冲突：

| 维度 | Prompt 文件 | Zod Schema | 影响 |
|------|------------|------------|------|
| `scene.tension` | 有 | 不存在 | 模型生成后被静默丢弃 |
| `objs[].seq` | 有 | 不存在（Zod 用 act/fx/motive） | 模型被引导填错字段 |
| `objs[].m` | Object | String | 结构类型冲突 |
| `seq` | Object {S1: ...} | Array [{id, desc}] | 根本结构不同 |
| `cont` | Object {S1-S2: ...} | String | 结构类型冲突 |
| `timeline` | Object {S1: {...}} | Array [{id, t, dur, ...}] | 结构类型冲突 |

Context7 确认的最佳实践：prompt 应提供语义/质量指导，不应包含竞争性结构定义。`withStructuredOutput` + `.describe()` 是结构的唯一权威。

---

## 设计方案

### 改什么

1. **删除** `## JSON Schema` 整节（约 45 行）— 竞争性结构定义的根源
2. **改写** `objs[].m` 示例 — 从 object 格式改为 string 格式（与 Zod schema 一致）
3. **改写** `cont` 示例 — 从 object 格式改为 string 格式（与 Zod schema 一致）

### 不改什么

- 开头角色定义和核心原则
- `## 13 Dimensions Quick Reference`
- `## 11 Hard Rules`（含已添加的台词规则）
- `## seq.S[n]` 示例（已包含 5 段台词格式）
- `## Common Mistakes to Avoid`
- `## Output Constraints`
- 不改任何 TypeScript 代码

### 改动后的 prompt 文件职责

| 改动前 | 改动后 |
|--------|--------|
| 结构定义 + 风格指南 | **纯风格指南** |
| 告诉模型"输出什么字段" | Zod `.describe()` 负责 |
| 告诉模型"字段里填什么质量内容" | prompt 文件负责 |

---

## 文件位置

- 源文件：`src/renderer/public/data/prompts/sora-storyboard-pro.md`
- 构建后：`dist/renderer/data/prompts/sora-storyboard-pro.md`（由 electron-vite 从 public/ 复制）

---

## 验证标准

1. `npm run build:vite` 构建成功
2. prompt 文件不含 ```` ```json ````JSON Schema 代码块
3. `objs[].m` 和 `cont` 示例格式与 Zod schema 一致
4. 所有领域知识（Hard Rules、示例、反模式）完整保留
