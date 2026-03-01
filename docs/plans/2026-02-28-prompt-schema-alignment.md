# Prompt-Schema 对齐 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 删除 prompt 文件中与 Zod schema 冲突的 JSON Schema 部分，修正示例格式，让 Zod `.describe()` 成为结构唯一权威。

**Architecture:** 仅修改 prompt 文件，不改 TypeScript 代码。删除 JSON Schema 代码块，修正 `objs[].m` 和 `cont` 示例从 object 格式改为 string 格式。

**Tech Stack:** Markdown prompt file, electron-vite build

---

### Task 1: 删除 JSON Schema 部分

**Files:**
- Modify: `src/renderer/public/data/prompts/sora-storyboard-pro.md`

**Step 1: 删除 `## JSON Schema` 整节**

删除从 `## JSON Schema` 标题到 ` ``` ` 闭合标签之间的所有内容（包括标题本身）。当前为第 37-82 行左右的内容：

```markdown
## JSON Schema

```json
{
  "scene": {
  ...全部删除...
}
```
```

**Step 2: Build 验证**

Run: `npm run build:vite 2>&1 | Select-String "error|built in"`
Expected: built in Xs, no errors

**Step 3: 验证 dist 文件不含 JSON Schema**

Run: `Select-String "## JSON Schema" dist/renderer/data/prompts/sora-storyboard-pro.md`
Expected: 无匹配

**Step 4: Commit**

```bash
git add src/renderer/public/data/prompts/sora-storyboard-pro.md
git commit -m "refactor: remove competing JSON Schema from storyboard-pro prompt"
```

---

### Task 2: 修正 objs[].m 示例格式（object → string）

**Files:**
- Modify: `src/renderer/public/data/prompts/sora-storyboard-pro.md`

**Step 1: 找到 `### objs[].m` 示例，改为 string 格式**

将当前的 object 格式示例：

```json
{
  "head": "pan-R 25° slow|M",
  "torso": "forward lean 10° sustained|L",
  "limbs": "R-hand lift 40cm to face|M",
  "face": "brow furrow deepens 2mm, lip corners drop 3mm|L"
}
```

替换为 string 格式（与 Zod schema `m: z.string()` 一致）：

```
"head:pan-R25°|M, torso:lean10°|L, limbs:R-hand lift 40cm|M, face:brow furrow 2mm+lip drop 3mm|L"
```

同时更新该小节的说明文字，表明 `m` 是单行字符串格式。

**Step 2: Build 验证**

Run: `npm run build:vite 2>&1 | Select-String "error|built in"`

**Step 3: Commit**

```bash
git add src/renderer/public/data/prompts/sora-storyboard-pro.md
git commit -m "fix: align objs[].m example with Zod string schema"
```

---

### Task 3: 修正 cont 示例格式（object → string）

**Files:**
- Modify: `src/renderer/public/data/prompts/sora-storyboard-pro.md`

**Step 1: 找到 `### cont` 示例，改为 string 格式**

将当前的 object 格式示例：

```json
{
  "S1-S2": "shirt wrinkle pattern, ring on left index, scar above right brow, glass position",
  "S2-S3": "tear track path, hair strand across forehead, ambient shadow angle"
}
```

替换为 string 格式（与 Zod schema `cont: z.string()` 一致）：

```
"S1-S2: shirt wrinkle pattern, ring on left index, scar above right brow; S2-S3: tear track path, hair strand across forehead, ambient shadow angle"
```

同时更新说明文字。

**Step 2: Build 验证**

Run: `npm run build:vite 2>&1 | Select-String "error|built in"`

**Step 3: Commit**

```bash
git add src/renderer/public/data/prompts/sora-storyboard-pro.md
git commit -m "fix: align cont example with Zod string schema"
```

---

### Task 4: 最终验证

**Step 1: 全量 Build**

Run: `npm run build:vite`

**Step 2: 验证 dist prompt 文件**

检查清单：
1. 不含 `## JSON Schema` 节
2. `objs[].m` 示例是 string 格式
3. `cont` 示例是 string 格式
4. 台词相关修改完整保留（11 Hard Rules、5段 seq 示例、dialogue slot rules）
5. 所有领域知识完整（Hard Rules、示例、反模式表、Output Constraints）
