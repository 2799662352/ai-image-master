# 分镜反推 Pro 模板 + 通用附加上下文输入 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在图像理解页面新增「分镜反推 Pro」模板（基于 image-to-storyboard SKILL.md 的完整 10 维度 prompt），并为所有模板添加通用「剧本/附加要求」输入区域。

**Architecture:** 扩展现有角色模板系统（`understand-roles.json` + `UnderstandPage.ts`），在 HTML 中新增可折叠的 context textarea，通过 `selectRole` 动态切换 placeholder，分析时将 context 文本拼接到 prompt 末尾。

**Tech Stack:** TypeScript, HTML/Tailwind CSS, JSON 配置

---

### Task 1: 新增 `sora-storyboard-pro` 模板到 `understand-roles.json`

**Files:**
- Modify: `src/renderer/public/data/understand-roles.json`

**Step 1: 在 `sora-storyboard` 之后新增 Pro 版模板**

新增 role 对象，id 为 `sora-storyboard-pro`，使用 SKILL.md 的完整 10 维度 JSON Schema 作为 prompt。

prompt 核心内容（从 SKILL.md 提取）：
- 10 Hard Rules 精简版
- 完整 JSON Schema（scene/objs/seq/cont/notes）
- Field-by-field rules 的关键约束
- 总输出限制 ≤ 3000 字符

模板额外属性：
- `contextPlaceholder`: "请输入剧本大纲、角色设定、风格要求、目标视频平台（可灵/即梦/Sora）..."
- `defaultModel`: "gemini-3-pro-preview"

**Step 2: 为所有现有模板添加可选 `contextPlaceholder` 属性**

其他模板的 contextPlaceholder 可以不设置（使用默认值）。

**Step 3: Commit**

```bash
git add src/renderer/public/data/understand-roles.json
git commit -m "feat: add sora-storyboard-pro template with full 10-dimension prompt"
```

---

### Task 2: 在 HTML 中添加「附加上下文」输入区域

**Files:**
- Modify: `src/renderer/index.html`

**Step 1: 在提问 textarea 上方添加可折叠的 context 区域**

在 `understandPrompt` textarea 之前，角色按钮之后，添加：

```html
<!-- 附加上下文/剧本输入 -->
<div id="understandContextSection" class="mb-3">
  <button id="understandContextToggle" type="button" 
    class="flex items-center gap-1 text-sm text-white opacity-60 hover:opacity-100 transition-opacity mb-2">
    <span id="understandContextArrow">▶</span>
    <span data-i18n="understand.labels.contextToggle">📋 剧本 / 附加要求</span>
  </button>
  <div id="understandContextWrapper" class="hidden">
    <textarea id="understandContext" rows="4" 
      class="w-full px-3 py-2 bg-white bg-opacity-5 border border-white border-opacity-10 rounded-md text-white placeholder-white placeholder-opacity-30 focus:outline-none focus:ring-1 focus:ring-purple-400 resize-y text-sm"
      data-i18n-placeholder="understand.placeholders.context"
      placeholder="补充说明、剧本大纲、特殊要求..."></textarea>
  </div>
</div>
```

**Step 2: Commit**

```bash
git add src/renderer/index.html
git commit -m "feat: add collapsible context textarea to understand page"
```

---

### Task 3: 在 `UnderstandPage.ts` 中实现 context 逻辑

**Files:**
- Modify: `src/renderer/src/pages/UnderstandPage.ts`

**Step 1: 添加 context 折叠/展开事件绑定**

在 `bindEvents()` 方法中添加 toggle 逻辑：

```typescript
this.addEventListenerSafe('understandContextToggle', 'click', () => {
  const wrapper = document.getElementById('understandContextWrapper')
  const arrow = document.getElementById('understandContextArrow')
  if (wrapper && arrow) {
    const isHidden = wrapper.classList.contains('hidden')
    wrapper.classList.toggle('hidden')
    arrow.textContent = isHidden ? '▼' : '▶'
  }
})
```

**Step 2: 在 `selectRole()` 方法中动态更新 context placeholder**

当角色切换时，如果 role 配置有 `contextPlaceholder`，更新 textarea 的 placeholder：

```typescript
const contextEl = document.getElementById('understandContext') as HTMLTextAreaElement
if (contextEl) {
  contextEl.placeholder = role.contextPlaceholder || this.t('understand.placeholders.context')
}
```

**Step 3: 在 `AnalysisRole` 接口中添加 `contextPlaceholder` 可选属性**

```typescript
export interface AnalysisRole {
  id: string
  name: string
  shortName?: string
  icon: string
  prompt: string
  default?: boolean
  defaultModel?: string
  contextPlaceholder?: string  // 新增
}
```

**Step 4: 在发送分析请求时拼接 context 内容**

找到构建分析 prompt 的地方，在最终 prompt 后追加用户的 context 内容：

```typescript
const contextEl = document.getElementById('understandContext') as HTMLTextAreaElement
const contextText = contextEl?.value?.trim()
if (contextText) {
  finalPrompt += `\n\n--- 用户附加要求 ---\n${contextText}`
}
```

**Step 5: 在状态保存/恢复中包含 context 内容**

确保 context textarea 的值在页面切换时不丢失。

**Step 6: Commit**

```bash
git add src/renderer/src/pages/UnderstandPage.ts
git commit -m "feat: implement context textarea logic with role-aware placeholder"
```

---

### Task 4: 添加 i18n 翻译

**Files:**
- Modify: `src/renderer/public/i18n/zh-CN.json`
- Modify: `src/renderer/public/i18n/en.json`
- Modify: `src/renderer/public/i18n/zh-TW.json`
- Modify: `src/renderer/public/i18n/ru.json`

**Step 1: 添加翻译 key**

在 `understand` 节下添加：

```json
// zh-CN
"labels": {
  "contextToggle": "📋 剧本 / 附加要求"
},
"placeholders": {
  "context": "补充说明、剧本大纲、特殊要求..."
}

// en
"labels": {
  "contextToggle": "📋 Script / Additional Requirements"
},
"placeholders": {
  "context": "Additional notes, script outline, special requirements..."
}

// zh-TW
"labels": {
  "contextToggle": "📋 劇本 / 附加要求"
},
"placeholders": {
  "context": "補充說明、劇本大綱、特殊要求..."
}

// ru
"labels": {
  "contextToggle": "📋 Сценарий / Доп. требования"
},
"placeholders": {
  "context": "Дополнительные заметки, сценарий, требования..."
}
```

**Step 2: 添加新模板名称翻译**

```json
// zh-CN
"understand.roleData.sora-storyboard-pro.name": "分镜反推 Pro",
"understand.roleData.sora-storyboard-pro.shortName": "分镜Pro"

// en
"understand.roleData.sora-storyboard-pro.name": "Storyboard Pro",
"understand.roleData.sora-storyboard-pro.shortName": "StoryPro"
```

**Step 3: Commit**

```bash
git add src/renderer/public/i18n/*.json
git commit -m "feat(i18n): add translations for context textarea and storyboard pro template"
```

---

### Task 5: 构建验证

**Step 1: 编译检查**

Run: `npm run build:vite 2>&1 | Select-Object -Last 5`
Expected: 构建成功

**Step 2: JSON 验证**

验证 understand-roles.json 和 4 个 i18n 文件语法正确。

**Step 3: Commit（如有修复）**

```bash
git add -A
git commit -m "chore: build verification and cleanup"
```

---

## 注意事项

1. **prompt 长度**：分镜 Pro 的 prompt 较长（~2000 字符），确保不超出 textarea/API 限制
2. **context 拼接位置**：追加在 role prompt 末尾，用 `\n\n--- 用户附加要求 ---\n` 分隔
3. **折叠默认状态**：默认折叠（hidden），减少视觉干扰；选中分镜模板时可自动展开
4. **状态持久化**：context 内容需随页面状态保存/恢复
