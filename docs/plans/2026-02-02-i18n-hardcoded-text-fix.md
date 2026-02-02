# i18n 硬编码文本修复计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 彻底解决 index.html 中所有硬编码中文文本，实现完整的多语言支持

**Architecture:** 
1. 为所有硬编码文本添加 `data-i18n` 或 `data-i18n-attr` 属性
2. 在翻译文件 (zh-CN.json, en.json, zh-TW.json, ru.json) 中添加对应的翻译键
3. 确保 I18nService 在页面加载和语言切换时正确应用翻译

**Tech Stack:** TypeScript, HTML data-* attributes, JSON i18n files

---

## 任务概览

| Task | 描述 | 文件数量 |
|------|------|----------|
| Task 1 | 修复 title 属性硬编码 | 1 HTML + 4 JSON |
| Task 2 | 修复 placeholder 属性硬编码 | 1 HTML + 4 JSON |
| Task 3 | 修复内联文本硬编码 (导航/按钮) | 1 HTML + 4 JSON |
| Task 4 | 修复模态框内容硬编码 | 1 HTML + 4 JSON |
| Task 5 | 修复表单选项硬编码 | 1 HTML + 4 JSON |
| Task 6 | 验证和测试 | - |

---

## Task 1: 修复 title 属性硬编码

**Files:**
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/public/i18n/zh-CN.json`
- Modify: `src/renderer/public/i18n/en.json`
- Modify: `src/renderer/public/i18n/zh-TW.json`
- Modify: `src/renderer/public/i18n/ru.json`

**Step 1: 更新 HTML - 添加 data-i18n-attr**

| 行号 | 原始 | 修改后 |
|------|------|--------|
| 660 | `title="返回图片编辑"` | `data-i18n-attr="title:nav.backToGenerate" title="返回图片编辑"` |
| 680 | `title="活动优惠"` | `data-i18n-attr="title:nav.activityTitle" title="活动优惠"` |
| 687 | `title="API设置"` | `data-i18n-attr="title:nav.settingsTitle" title="API设置"` |
| 696 | `title="切换语言"` | `data-i18n-attr="title:nav.switchLanguage" title="切换语言"` |
| 1341 | `title="清空提示词输入"` | `data-i18n-attr="title:generate.clearPromptTitle" title="清空提示词输入"` |
| 2022 | `title="选择图像分析模型"` | `data-i18n-attr="title:director.selectVisionModel" title="选择图像分析模型"` |
| 2307 | `title="复制内容"` | `data-i18n-attr="title:director.copyContent" title="复制内容"` |
| 2347 | `title="编辑模式"` | `data-i18n-attr="title:director.editMode" title="编辑模式"` |
| 2765 | `title="关闭模板库"` | `data-i18n-attr="title:template.close" title="关闭模板库"` |

**Step 2: 添加翻译键到 zh-CN.json**

```json
{
  "nav": {
    "backToGenerate": "返回图片编辑",
    "activityTitle": "活动优惠",
    "settingsTitle": "API设置",
    "switchLanguage": "切换语言"
  },
  "generate": {
    "clearPromptTitle": "清空提示词输入"
  },
  "director": {
    "selectVisionModel": "选择图像分析模型",
    "copyContent": "复制内容",
    "editMode": "编辑模式"
  },
  "template": {
    "close": "关闭模板库"
  }
}
```

**Step 3: 添加翻译键到 en.json**

```json
{
  "nav": {
    "backToGenerate": "Back to Image Editor",
    "activityTitle": "Special Offers",
    "settingsTitle": "API Settings",
    "switchLanguage": "Switch Language"
  },
  "generate": {
    "clearPromptTitle": "Clear prompt input"
  },
  "director": {
    "selectVisionModel": "Select Vision Model",
    "copyContent": "Copy Content",
    "editMode": "Edit Mode"
  },
  "template": {
    "close": "Close Template Library"
  }
}
```

---

## Task 2: 修复 placeholder 属性硬编码

**Files:**
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/public/i18n/*.json`

**Step 1: 更新 HTML placeholder**

| 行号 | 元素 | 添加属性 |
|------|------|----------|
| 1501 | 批量提示词输入 | `data-i18n-attr="placeholder:batch.promptPlaceholder"` |
| 1553 | 批量提示词2 | `data-i18n-attr="placeholder:batch.promptPlaceholder"` |
| 1915 | 理解页面提示词 | `data-i18n-attr="placeholder:understand.promptPlaceholder"` |
| 1962 | 自定义模型输入 | `data-i18n-attr="placeholder:understand.customModelPlaceholder"` |
| 2102 | 导演模式场景描述 | `data-i18n-attr="placeholder:director.scenePlaceholder"` |
| 2118 | 多场景输入 | `data-i18n-attr="placeholder:director.multiScenePlaceholder"` |
| 2498 | 模板名称 | `data-i18n-attr="placeholder:director.templateNamePlaceholder"` |
| 2509 | 模板前缀 | `data-i18n-attr="placeholder:director.templatePrefixPlaceholder"` |
| 2521 | 模板后缀 | `data-i18n-attr="placeholder:director.templateSuffixPlaceholder"` |
| 2533 | 负面提示词 | `data-i18n-attr="placeholder:director.templateNegativePlaceholder"` |
| 2612 | 图片API Key | `data-i18n-attr="placeholder:settingsModal.imageApiKeyPlaceholder"` |

**Step 2: 添加翻译键**

zh-CN.json:
```json
{
  "batch": {
    "promptPlaceholder": "设计一张图文店促销活动传单，宣传年终大促销活动。\\n\\n主要内容：\\n- 大标题：年终大促\\n- 优惠力度：全场5折起\\n- 活动时间：12月1日-31日"
  },
  "understand": {
    "promptPlaceholder": "例如：这张图片里有什么？描述图片中的场景...",
    "customModelPlaceholder": "例如：gpt-4-vision-preview"
  },
  "director": {
    "scenePlaceholder": "描述场景、剧情或您想要的效果...（留空则AI自动分析参考图）",
    "multiScenePlaceholder": "每个场景用空行分隔，例如：\\n\\n场景1：男主站在雨中，背对镜头\\n\\n场景2：女主在窗边看书，阳光洒落",
    "templateNamePlaceholder": "例如：我的动漫风格",
    "templatePrefixPlaceholder": "添加在提示词开头的内容...",
    "templateSuffixPlaceholder": "添加在提示词末尾的内容...",
    "templateNegativePlaceholder": "不希望出现在图片中的内容..."
  },
  "settingsModal": {
    "imageApiKeyPlaceholder": "请输入您的图片生成 API Key"
  }
}
```

---

## Task 3: 修复内联文本硬编码 (导航/按钮)

**Files:**
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/public/i18n/*.json`

**关键硬编码文本:**

| 行号 | 原始文本 | i18n key |
|------|----------|----------|
| 635 | `SKIP /// 跳过` | `intro.skip` |
| 638 | `ENTER NIGHT CITY /// 进入夜之城` | `intro.enter` |
| 698 | `中` | `common.langShort.zhCN` |
| 706 | `简体中文` | `common.langName.zhCN` |
| 708-718 | 语言名称 | `common.langName.*` |
| 1130 | `稍后更新` | `update.later` |
| 1133 | `立即更新` | `update.now` |
| 1184 | `取消` | `common.cancel` |
| 1187 | `确认生成` | `cardConfirm.confirm` |

---

## Task 4: 修复模态框内容硬编码

**更新版本更新模态框:**
```html
<h3 data-i18n="update.title">发现新版本</h3>
<p data-i18n="update.versionReleased">新版本已发布</p>
<h4 data-i18n="update.notes">更新内容</h4>
<p data-i18n="update.description">为了获得最佳体验，建议您立即更新到最新版本。</p>
<button data-i18n="update.later">稍后更新</button>
<button data-i18n="update.now">立即更新</button>
```

**更新抽卡确认模态框:**
```html
<h3 data-i18n="cardConfirm.title">确认抽卡生成</h3>
<span data-i18n="cardConfirm.mode">生成模式：</span>
<span data-i18n="cardConfirm.quantity">生成数量：</span>
<span data-i18n="cardConfirm.model">当前模型：</span>
<span data-i18n="cardConfirm.cost">预估费用：</span>
<p data-i18n="cardConfirm.description">抽卡模式将使用相同提示词...</p>
```

---

## Task 5: 修复表单选项硬编码

**生成数量选项:**
```html
<option value="1" data-i18n="generate.count.one">1张</option>
<option value="2" data-i18n="generate.count.two">2张</option>
```

**并发数量选项:**
```html
<option value="1" data-i18n="batch.concurrency.one">1个</option>
<option value="2" data-i18n="batch.concurrency.two">2个</option>
```

---

## Task 6: 验证和测试

**Step 1: 构建项目**
```bash
npm run build:vite
```

**Step 2: 启动应用测试**

验证清单：
- [ ] 切换到英语，所有文本变为英文
- [ ] 切换到繁体中文，所有文本变为繁体
- [ ] 切换到俄语，所有文本变为俄语
- [ ] 切换回简体中文，所有文本恢复
- [ ] 控制台无 i18n 相关警告
- [ ] 所有 tooltip (title) 正确翻译
- [ ] 所有 placeholder 正确翻译
- [ ] 所有按钮文本正确翻译
- [ ] 所有模态框内容正确翻译

---

## 执行顺序

1. **Task 1** - title 属性 (9 处)
2. **Task 2** - placeholder 属性 (11 处)
3. **Task 3** - 导航/按钮文本 (~15 处)
4. **Task 4** - 模态框内容 (~20 处)
5. **Task 5** - 表单选项 (~15 处)
6. **Task 6** - 验证测试

**预估工作量:** 约 80 处修改，分 5 个批次执行
