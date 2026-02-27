# 负面提示词开关 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在导演模式模板编辑器中为负面提示词添加 toggle 开关，默认关闭（不使用负面提示词），用户手动开启后才启用。

**Architecture:** 在 HTML 的负面提示词标签旁添加 Tailwind CSS checkbox toggle。使用 `peer/checked` 控制 textarea 的禁用状态。DirectorPage.ts 在 `openTemplateEditor` / `saveTemplateFromEditor` 中读写 toggle 状态。

**Tech Stack:** HTML/Tailwind CSS (peer modifier), TypeScript

---

### Task 1: 在 HTML 中添加 toggle 开关

**Files:**
- Modify: `src/renderer/index.html` (负面提示词标签区域)

**Step 1: 在负面提示词 label 旁添加 toggle**

找到 `templateEditorNegative` 的 label，修改为包含 toggle 的布局：

将：
```html
<label class="flex items-center text-sm font-bold text-[#FAFAFA] mb-2 uppercase tracking-wide">
    <span class="w-6 h-6 rounded-none bg-[#EF4444] text-white flex items-center justify-center text-xs mr-2">4</span>
    <span data-i18n="director.templateEditor.negative">负面提示词 (Negative)</span>
</label>
```

改为：
```html
<label class="flex items-center justify-between text-sm font-bold text-[#FAFAFA] mb-2 uppercase tracking-wide">
    <span class="flex items-center">
        <span class="w-6 h-6 rounded-none bg-[#EF4444] text-white flex items-center justify-center text-xs mr-2">4</span>
        <span data-i18n="director.templateEditor.negative">负面提示词 (Negative)</span>
    </span>
    <label class="relative inline-flex items-center cursor-pointer">
        <input type="checkbox" id="templateEditorNegativeToggle" class="sr-only peer">
        <div class="w-9 h-5 bg-[#3F3F46] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[#EF4444]"></div>
    </label>
</label>
```

**Step 2: Commit**

```bash
git add src/renderer/index.html
git commit -m "feat: add negative prompt toggle switch to template editor"
```

---

### Task 2: 在 DirectorPage.ts 中实现 toggle 逻辑

**Files:**
- Modify: `src/renderer/src/pages/DirectorPage.ts`

**Step 1: 在 `openTemplateEditor` 中初始化 toggle 状态**

在填充负面提示词值之后，设置 toggle 和 textarea 状态：

```typescript
const negativeToggle = document.getElementById('templateEditorNegativeToggle') as HTMLInputElement
if (negativeToggle && negativeInput) {
  const hasNegative = !!(template?.negative?.trim())
  negativeToggle.checked = hasNegative
  negativeInput.disabled = !hasNegative
  negativeInput.classList.toggle('opacity-30', !hasNegative)

  negativeToggle.onchange = () => {
    negativeInput.disabled = !negativeToggle.checked
    negativeInput.classList.toggle('opacity-30', !negativeToggle.checked)
    if (negativeToggle.checked) negativeInput.focus()
  }
}
```

新建模板时（template 为 null），toggle 默认关闭。

**Step 2: 在 `saveTemplateFromEditor` 中根据 toggle 决定是否保存 negative**

```typescript
const negativeToggle = document.getElementById('templateEditorNegativeToggle') as HTMLInputElement
const negative = negativeToggle?.checked ? (negativeInput?.value?.trim() || '') : ''
```

**Step 3: 在 `resetCurrentTemplate` 中同步 toggle 状态**

重置时也需要更新 toggle 为 ON（因为内置模板有 negative 内容）。

**Step 4: Commit**

```bash
git add src/renderer/src/pages/DirectorPage.ts
git commit -m "feat: implement negative prompt toggle logic in template editor"
```

---

### Task 3: 构建验证

**Step 1: 构建**

Run: `npm run build:vite 2>&1 | Select-Object -Last 3`

**Step 2: 运行时验证**

1. 打开导演模式 → 选模板 → 点编辑
2. 确认 toggle 默认关闭，textarea 禁用+半透明
3. 开启 toggle → textarea 可编辑
4. 保存 → 重新打开编辑器 → 确认状态保持
5. 新建模板 → toggle 默认关闭

**Step 3: Commit**

```bash
git add -A
git commit -m "chore: negative prompt toggle verification"
```
