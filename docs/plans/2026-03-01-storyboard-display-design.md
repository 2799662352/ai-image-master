# Storyboard Display & Import Enhancement Design

**Date:** 2026-03-01
**Goal:** 图像理解页展示完整分镜数据（格式化文本 + JSON 双 Tab），支持复制，导演模式接收全量结构化数据。
**Architecture:** 共享格式化函数 + sessionStorage 传递结构化 JSON + Tab 切换 UI。

---

## 背景

当前 `StoryboardToDirectorAdapter.ts` 仅传递 3 类字段（scene.d、obj.f+motive、shot.desc），丢失了环境参数、音乐设计、角色空间位置/物理/锚点/运动、镜头演出/特效/动机、连续性锚点和校验总结。

## 改动文件

| # | 文件 | 动作 | 内容 |
|---|------|------|------|
| 1 | `StoryboardToDirectorAdapter.ts` | 重写 | `formatStoryboardText()` + 扩展 `DirectorImportData` |
| 2 | `UnderstandPage.ts` | 修改 | Tab 切换 UI（格式化文本/JSON）+ 复制按钮 + 导入按钮 |
| 3 | `DirectorPage.ts` | 修改 | 缓存 structuredData + LLM 调用时注入 |

## Part 1: Adapter 改造

### DirectorImportData 接口

```typescript
export interface DirectorImportData {
  sceneDescription: string           // 全量格式化文本
  structuredData?: StoryboardResponse // 原始结构化 JSON
  referenceImageBase64?: string
  referenceImageMimeType?: string
  templateNegative?: string
}
```

### formatStoryboardText 格式化模板

```
{scene.d}
{scene.cap}

环境: {scene.env}
音乐: {scene.bgm}

角色:
[{n}] {f} | 位置: {s} | 物理: {p} | 锚点: {t} | 运动: {m}
  动机: {motive}
  衔接: {tc}

分镜:
{id}: {desc}
  演出: {act}
  特效: {fx || '无'}
  动机: {motive}

连续性: {cont}
校验: {notes}
```

## Part 2: UnderstandPage 结果展示

### Tab 切换 UI

```
┌─────────────────────────────────────────┐
│ 4-Pass 分镜分析完成                      │
├──────────────┬──────────────────────────┤
│ [格式化文本]  │ [JSON]                   │  ← 点击切换
├──────────────┴──────────────────────────┤
│ (当前 tab 内容，max-h-500px 可滚动)      │
├─────────────────────────────────────────┤
│ [复制]                    [导入导演模式]  │
└─────────────────────────────────────────┘
```

- 默认显示格式化文本 tab
- JSON tab 显示美化缩进的原始 JSON
- 复制按钮复制当前 tab 内容
- 复制后按钮文字变"已复制"，1.5s 恢复

### UI 规范 (ui-ux-pro-max)

| 规则 | 实现 |
|------|------|
| cursor-pointer | 所有按钮和 tab |
| focus-states | focus:ring-2 focus:ring-blue-500 |
| keyboard-nav | Tab 键可切换 |
| aria-labels | 所有按钮有 aria-label |
| transition | transition-colors duration-200 |
| icons | Font Awesome SVG，不用 emoji |
| 复制反馈 | 按钮变绿 + "已复制" + 1.5s 恢复 |

### 数据存储

Pipeline 完成后：
- `_lastStoryboardResult` = 原始 StoryboardResponse
- `_lastFormattedText` = formatStoryboardText(result)
- `_lastJsonText` = JSON.stringify(result, null, 2)

Tab 切换时直接切换显示内容，无需重新计算。

## Part 3: DirectorPage 接收

### checkForImportData 扩展

```typescript
private _importedStoryboardData: StoryboardResponse | null = null

private checkForImportData(): void {
  // ... 现有逻辑 ...
  if (data.structuredData) {
    this._importedStoryboardData = data.structuredData
  }
}
```

### LLM 调用注入

在 `generateJsonShots()` 中，当 `_importedStoryboardData` 存在时注入结构化上下文：

```typescript
let structuredContext = ''
if (this._importedStoryboardData) {
  const sd = this._importedStoryboardData
  structuredContext = `
## 结构化分镜数据
环境: ${sd.scene.env}
音乐: ${sd.scene.bgm}
角色锚点: ${sd.objs.map(o => `[${o.n}] ${o.t}`).join('; ')}
时间轴: ${sd.scene.timeline.map(t => `${t.id}(${t.dur},${t.tempo})`).join(' → ')}
`
}
```

## 设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 数据传递方式 | sessionStorage JSON | 简单可靠，几十 KB 无压力 |
| Tab 实现 | 纯 DOM class 切换 | 项目无 React，用原生 DOM 操作 |
| 格式化函数位置 | Adapter 文件中导出 | UnderstandPage 和 Adapter 共用 |
| 复制方式 | navigator.clipboard.writeText | 现代 API，Electron 支持 |
