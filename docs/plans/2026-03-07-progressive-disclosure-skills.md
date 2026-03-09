# Progressive Disclosure Skill 系统改造

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 skill 系统从"全量加载 body → 全部注入 system prompt"改为"只加载 frontmatter → LLM 选择后才注入 body"的 Progressive Disclosure 模式，减少 system prompt token 消耗。

**Architecture:** 
1. `PipelineSkill` 接口新增 `bodyLoaded` 标志，初始只加载 frontmatter（id, description, appliesTo, priority），body 设为空字符串
2. `selectSkillsFn` 使用 description 列表让 LLM 选择（已有此行为）
3. `matchSkillsForPhase` 中，被选中的 skill 在首次匹配时按需加载 body（lazy load）
4. 未被选中的 skill 永远不加载 body → 显著减少 system prompt 长度

**Tech Stack:** TypeScript, Vite `import.meta.glob`

**当前问题:**
- 19 个 skill 的完整 body 全部加载进内存（~15KB 文本）
- `buildSystemPrompt` 将被选中 skill 的 body 全部拼入 system prompt
- selectSkillsFn 已经只用 description 做选择（不需要 body），但 body 已经被解析并加载了
- 未来 skill 增长会让 system prompt 越来越长

**改造后的流程:**
```
编译时: import.meta.glob 加载所有 SKILL.md 原始文本
         ↓
启动时: parseSkillFromMarkdown 只解析 frontmatter → body 存为原始文本但不放入 skill.rules
         ↓
Pass 0: selectSkillsFn 用 description 列表让 LLM 选择（不变）
         ↓
Pass 1-6: matchSkillsForPhase 命中时 → 检查 bodyLoaded → 首次命中时加载 body → 注入 system prompt
```

---

### Task 1: PipelineSkill 接口新增 lazyBody 支持

**文件:**
- 修改: `src/renderer/src/services/pipeline/types.ts` — PipelineSkill 接口

**Step 1: 运行现有测试确认基线**

```bash
npx vitest run src/renderer/src/services/pipeline/
```
预期: 全部 PASS

**Step 2: 修改 PipelineSkill 接口**

在 `types.ts` 约行 32-39，添加可选字段:

```typescript
export interface PipelineSkill {
  id: string
  description: string
  rules: string | ((context: Record<string, unknown>) => string)
  appliesTo: string[]
  priority: number
  condition?: (context: Record<string, unknown>) => boolean
  /** Raw body text, loaded lazily on first match. Empty string means not yet loaded. */
  _rawBody?: string
  /** Whether body has been loaded into rules. */
  _bodyLoaded?: boolean
}
```

**Step 3: 运行测试**

```bash
npx vitest run src/renderer/src/services/pipeline/
```
预期: 全部 PASS（新增可选字段不破坏现有代码）

**Step 4: 提交**

```bash
git add src/renderer/src/services/pipeline/types.ts
git commit -m "feat(pipeline): PipelineSkill 接口新增 _rawBody/_bodyLoaded 支持 Progressive Disclosure"
```

---

### Task 2: prompt-loader 改为只解析 frontmatter，body 延迟加载

**文件:**
- 修改: `src/renderer/src/services/pipeline/prompt-loader.ts` — parseSkillFromMarkdown 函数

**Step 1: 修改 parseSkillFromMarkdown**

将约行 61-92 的函数修改为只解析 frontmatter，body 存入 `_rawBody` 而非 `rules`:

```typescript
function parseSkillFromMarkdown(raw: string): PipelineSkill | null {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/^\uFEFF/, '')
  const match = normalized.match(/^\s*---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return null

  const yaml = match[1]
  const body = match[2].trim()

  const name = yaml.match(/^name:\s*(.+)$/m)?.[1]?.trim() || ''
  const appliesToInlineRaw = yaml.match(/^appliesTo:\s*\[([^\]]*)\]\s*$/m)?.[1]
  const appliesToBlockRaw = yaml.match(/^appliesTo:\s*\n((?:\s*-\s*.+\n?)*)/m)?.[1]
  const appliesTo = appliesToInlineRaw
    ? appliesToInlineRaw
      .split(',')
      .map(s => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean)
    : (appliesToBlockRaw
      ? appliesToBlockRaw
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith('- '))
        .map(line => line.slice(2).trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
      : [])
  if (!name || appliesTo.length === 0) return null

  const description = yaml.match(/^description:\s*(.+)$/m)?.[1]?.trim() || ''
  const priorityStr = yaml.match(/^priority:\s*(\d+)$/m)?.[1]
  const priority = priorityStr ? parseInt(priorityStr, 10) : 50

  // Progressive Disclosure: store body as raw text, don't load into rules yet
  return {
    id: name,
    description,
    rules: '',          // Empty — will be loaded on first match
    appliesTo,
    priority,
    _rawBody: body,     // Raw body stored for lazy loading
    _bodyLoaded: false, // Not yet loaded
  }
}
```

**Step 2: 运行测试**

```bash
npx vitest run src/renderer/src/services/pipeline/
```
预期: 一些测试可能失败（因为 rules 现在是空字符串）。这是预期的 — Task 3 会修复。

**Step 3: 提交（即使测试暂时失败，因为 Task 3 会修复）**

```bash
git add src/renderer/src/services/pipeline/prompt-loader.ts
git commit -m "refactor(prompt-loader): Progressive Disclosure — 只解析 frontmatter，body 延迟加载

parseSkillFromMarkdown 不再将 body 直接放入 rules，
而是存入 _rawBody 字段等待按需加载。"
```

---

### Task 3: BasePipeline matchSkillsForPhase 实现 lazy body loading

**文件:**
- 修改: `src/renderer/src/services/pipeline/BasePipeline.ts` — matchSkillsForPhase 和 getSkillRulesForPhase

**Step 1: 修改 getSkillRulesForPhase 添加 lazy loading 逻辑**

将约行 86-95 替换为:

```typescript
private getSkillRulesForPhase(phase: string, context: Record<string, unknown>): string {
  return this.matchSkillsForPhase(phase, context)
    .map(s => {
      // Progressive Disclosure: load body on first access
      if (s._bodyLoaded === false && s._rawBody) {
        s.rules = s._rawBody
        s._bodyLoaded = true
      }
      const rules = typeof s.rules === 'function' ? s.rules(context) : s.rules
      if (!rules) return ''
      return `[Skill:${s.id}]\n${rules}`
    })
    .filter(Boolean)
    .join('\n\n')
}
```

**关键**: 只有被 `matchSkillsForPhase` 选中的 skill 才会加载 body。未被选中的 skill 永远保持 `rules: ''`。

**Step 2: 运行测试**

```bash
npx vitest run src/renderer/src/services/pipeline/
```
预期: 全部 PASS（lazy loading 在首次匹配时自动加载 body）

**Step 3: 运行 storyboard 测试确认无回归**

```bash
npx vitest run src/renderer/src/services/storyboard-pipeline/
```
预期: 全部 PASS

**Step 4: 提交**

```bash
git add src/renderer/src/services/pipeline/BasePipeline.ts
git commit -m "feat(pipeline): Progressive Disclosure — skill body 按需加载

getSkillRulesForPhase 中只有被选中的 skill 才在首次匹配时
从 _rawBody 加载 body 到 rules。未选中的 skill 永远不加载
body，减少 system prompt token 消耗。"
```

---

### Task 4: 更新 BasePipeline 测试验证 Progressive Disclosure

**文件:**
- 修改: `src/renderer/src/services/pipeline/__tests__/BasePipeline.test.ts`

**Step 1: 添加测试**

在测试文件末尾追加:

```typescript
describe('Progressive Disclosure', () => {
  it('skill body is not loaded until first phase match', () => {
    const pipeline = new TestPipeline(config)
    pipeline.registerSharedSkill({
      id: 'lazy-skill',
      description: 'A lazy skill',
      rules: '',
      appliesTo: ['myPhase'],
      priority: 1,
      _rawBody: 'Lazy body content here',
      _bodyLoaded: false,
    })
    // Before matching: rules should be empty
    const skillsBefore = (pipeline as any).sharedSkills
    expect(skillsBefore[0].rules).toBe('')
    expect(skillsBefore[0]._bodyLoaded).toBe(false)

    // Trigger matching
    const prompt = pipeline.buildSystemPrompt('myPhase', 'base', {})

    // After matching: body should be loaded
    expect(skillsBefore[0].rules).toBe('Lazy body content here')
    expect(skillsBefore[0]._bodyLoaded).toBe(true)
    expect(prompt).toContain('Lazy body content here')
  })

  it('unmatched skill body remains empty', () => {
    const pipeline = new TestPipeline(config)
    pipeline.registerSharedSkill({
      id: 'unmatched-skill',
      description: 'An unmatched skill',
      rules: '',
      appliesTo: ['otherPhase'],
      priority: 1,
      _rawBody: 'Should not appear',
      _bodyLoaded: false,
    })
    // Match a different phase
    const prompt = pipeline.buildSystemPrompt('myPhase', 'base', {})
    const skills = (pipeline as any).sharedSkills
    expect(skills[0].rules).toBe('')
    expect(skills[0]._bodyLoaded).toBe(false)
    expect(prompt).toBe('base')
  })

  it('already loaded skill body is not reloaded', () => {
    const pipeline = new TestPipeline(config)
    pipeline.registerSharedSkill({
      id: 'preloaded',
      description: 'Already loaded',
      rules: 'Already loaded body',
      appliesTo: ['myPhase'],
      priority: 1,
      _rawBody: 'Raw body that should not override',
      _bodyLoaded: true,
    })
    const prompt = pipeline.buildSystemPrompt('myPhase', 'base', {})
    expect(prompt).toContain('Already loaded body')
    expect(prompt).not.toContain('Raw body that should not override')
  })
})
```

**Step 2: 运行测试**

```bash
npx vitest run src/renderer/src/services/pipeline/__tests__/BasePipeline.test.ts
```
预期: 全部 PASS

**Step 3: 运行全部测试确认无回归**

```bash
npx vitest run src/renderer/src/services/pipeline/
npx vitest run src/renderer/src/services/storyboard-pipeline/
```
预期: 全部 PASS

**Step 4: 提交**

```bash
git add src/renderer/src/services/pipeline/__tests__/BasePipeline.test.ts
git commit -m "test(pipeline): Progressive Disclosure 测试

验证 lazy body loading:
- 未匹配的 skill body 保持为空
- 首次匹配时自动加载 body
- 已加载的 body 不会被重新覆盖"
```

---

### Task 5: storyboard-prompt-loader 同步改造

**文件:**
- 修改: `src/renderer/src/services/storyboard-pipeline/storyboard-prompt-loader.ts`

Storyboard 管线有自己的 skill loader，也需要同步改为 Progressive Disclosure。

**Step 1: 找到 storyboard 的 parseSkillFromMarkdown**

```bash
grep -n "parseSkillFromMarkdown\|_rawBody\|rules.*body" src/renderer/src/services/storyboard-pipeline/storyboard-prompt-loader.ts
```

如果 storyboard-prompt-loader 有独立的 parseSkillFromMarkdown 函数，按照 Task 2 同样的方式修改。如果它复用 prompt-loader 的函数，则不需要改。

**Step 2: 确认并修改**

如果有独立函数，修改为同样的 Progressive Disclosure 模式:
- `rules: ''` 初始为空
- `_rawBody: body` 存储原始文本
- `_bodyLoaded: false`

**Step 3: 运行测试**

```bash
npx vitest run src/renderer/src/services/storyboard-pipeline/
```
预期: 全部 PASS

**Step 4: 提交**

```bash
git add src/renderer/src/services/storyboard-pipeline/storyboard-prompt-loader.ts
git commit -m "refactor(storyboard): storyboard-prompt-loader 同步 Progressive Disclosure"
```

---

## 验证

```bash
# 全部测试
npx vitest run src/renderer/src/services/pipeline/
npx vitest run src/renderer/src/services/storyboard-pipeline/

# 端到端
npm run dev
# → 导演模式 → 选 theatrical 模板 → 生成
# → 控制台 selectSkills 日志正常（应看到 director-anime-quality-boost 被选中）
# → 管线完成无报错
# → 验证: 只有被选中的 skill body 被注入 system prompt

# 可选: 添加日志确认 lazy loading
# 在 getSkillRulesForPhase 的 lazy loading 分支添加:
# console.log(`[Progressive Disclosure] Lazy-loaded body for skill: ${s.id}`)
```

## 技术备注

### 为什么不改 selectSkillsFn?

`selectSkillsFn` 已经只用 `description` 做选择（通过 `buildSkillMenu` 函数只传 `id: description`）。它不需要 body 内容。Progressive Disclosure 的改造完全在 loader + matcher 层面。

### 内存影响

改造后，`_rawBody` 仍然在内存中（import.meta.glob 是编译时加载）。节省的是 **system prompt token 长度**（只有被选中的 skill 的 body 才进入 prompt），不是内存。

### 向后兼容

- `sharedSkills`（通过 `director-skills.ts` 注册的）不受影响，它们的 rules 直接在代码中定义
- `pipelineSkills`（通过 SKILL.md 文件加载的）受影响，但 lazy loading 透明兼容
- 用户自定义 skill 也自动受益
