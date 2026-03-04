# Custom Templates — Design Document

**Date:** 2026-03-05
**Status:** Approved
**Problem:** 用户只能编辑内置模板的 prefix/suffix/negative，无法新建自定义模板。

## Design

### 数据层
- 新增 `CUSTOM_TEMPLATES_STORAGE_KEY` 在 localStorage 存储自定义模板完整数据
- `addCustomTemplate(data)` 自动生成 `custom-{timestamp}` key
- `getAllTemplates()` 返回内置 + 自定义合并列表
- Pipeline 层无需改动（未知 key 自动回退到 styleAnchor.medium 推断）

### UI 层
- 模板选择弹窗底部，「确定」按钮旁加「新建模板」
- 新建时复用编辑弹窗，名称可编辑，图标固定 ✏️
- 自定义模板在 grid 中标签显示「自定义」
