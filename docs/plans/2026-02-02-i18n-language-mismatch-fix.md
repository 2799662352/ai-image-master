# i18n 语言配置不匹配修复计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复 i18n 语言切换功能，使配置与实际翻译文件匹配

**Architecture:** 更新 I18nService.ts 的 supportedLanguages 配置，匹配实际存在的翻译文件 (zh-CN, en, zh-TW, ru)

**Tech Stack:** TypeScript, i18n, JSON 翻译文件

---

## 问题分析

### 当前状态

| 组件 | 语言代码 |
|------|----------|
| I18nService 配置 | `['zh-CN', 'en-US', 'ja-JP']` |
| HTML 语言选项 | `zh-CN`, `en`, `zh-TW`, `ru` |
| 翻译文件 | `zh-CN.json`, `en.json`, `zh-TW.json`, `ru.json` |

### 根本原因

1. `en-US` vs `en`: 配置用 `en-US`，但翻译文件和 HTML 用 `en`
2. `zh-TW` 和 `ru` 未在 supportedLanguages 中
3. `ja-JP` 在配置中但没有翻译文件

### i18next 最佳实践参考

根据 Context7 i18next 文档，推荐配置：
- `supportedLngs`: 明确列出所有支持的语言
- `fallbackLng`: 设置回退语言
- `load: 'languageOnly'`: 只加载基础语言（如 `en` 而非 `en-US`）

---

## Task 1: 更新 I18nService 配置

**Files:**
- Modify: `src/renderer/src/services/i18n/I18nService.ts:75-79` (SUPPORTED_LANGUAGES)
- Modify: `src/renderer/src/services/i18n/I18nService.ts:89-98` (config)

**Step 1: 更新 SUPPORTED_LANGUAGES 常量**

```typescript
// 支持的语言列表 - 必须与 public/i18n/ 目录下的翻译文件匹配
const SUPPORTED_LANGUAGES: LanguageInfo[] = [
  { code: 'zh-CN', name: 'Chinese (Simplified)', nativeName: '简体中文' },
  { code: 'en', name: 'English', nativeName: 'English' },
  { code: 'zh-TW', name: 'Chinese (Traditional)', nativeName: '繁體中文' },
  { code: 'ru', name: 'Russian', nativeName: 'Русский' }
]
```

**Step 2: 更新默认配置**

```typescript
this.config = {
  defaultLanguage: 'zh-CN',
  fallbackLanguage: 'zh-CN',
  supportedLanguages: ['zh-CN', 'en', 'zh-TW', 'ru'],
  basePath: './i18n/',
  cacheEnabled: true,
  version: '1.0.0',
  ...config
}
```

**Step 3: 更新 Language 类型定义**

```typescript
export type Language = 'zh-CN' | 'en' | 'zh-TW' | 'ru' | string
```

**Step 4: 构建并验证**

Run: `npm run build:vite`
Expected: Build succeeds

**Step 5: 测试语言切换**

1. 启动应用
2. 点击语言切换按钮
3. 分别选择：简体中文、English、繁體中文、Русский
4. 验证控制台无 "Unsupported language" 警告
5. 验证界面文本正确切换

---

## 验证清单

- [ ] `supportedLanguages` 包含 `['zh-CN', 'en', 'zh-TW', 'ru']`
- [ ] `SUPPORTED_LANGUAGES` 常量匹配
- [ ] 控制台无 "Unsupported language" 警告
- [ ] 所有四种语言可正常切换
- [ ] 界面文本正确显示
