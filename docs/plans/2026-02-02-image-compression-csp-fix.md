# 图片压缩 CSP 问题修复计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复 browser-image-compression 在 Electron 中的 CSP 问题，同时保留 Web Worker 性能优势

**Architecture:** 使用 `libURL` 选项指向本地文件，避免从 CDN 加载脚本

**Tech Stack:** TypeScript, browser-image-compression, Electron

---

## 问题分析

### 根本原因

`browser-image-compression` 的 Web Worker 默认从 CDN 加载脚本：
```
https://cdn.jsdelivr.net/npm/browser-image-compression@2.0.2/dist/browser-image-compression.js
```

Electron 的 CSP 不允许从外部 CDN 加载脚本。

### 解决方案

使用 `libURL` 选项指向本地文件：
```typescript
{
  useWebWorker: true,
  libURL: './cdn/browser-image-compression/browser-image-compression.js'
}
```

---

## 方案对比

| 方案 | 性能 | 安全性 | 复杂度 |
|------|------|--------|--------|
| `useWebWorker: false` | ❌ 阻塞主线程 | ✅ 安全 | ✅ 简单 |
| 修改 CSP 允许 CDN | ✅ 好 | ❌ 风险 | ✅ 简单 |
| **`libURL` 指向本地** | ✅ 好 | ✅ 安全 | ✅ 简单 |

---

## 实施步骤

### Task 1: 创建通用配置

**文件:** `src/renderer/src/utils/imageCompressionConfig.ts`

```typescript
/**
 * 图片压缩配置
 * 使用本地 libURL 避免 CSP 问题
 */
export function getImageCompressionOptions(overrides: Partial<ImageCompressionOptions> = {}): ImageCompressionOptions {
  return {
    maxSizeMB: 2,
    maxWidthOrHeight: 2048,
    useWebWorker: true,
    // 使用本地文件避免 CSP 限制（Worker 会尝试从 CDN 加载脚本）
    libURL: './cdn/browser-image-compression/browser-image-compression.js',
    fileType: undefined,
    initialQuality: 0.9,
    alwaysKeepResolution: false,
    ...overrides
  }
}
```

### Task 2: 更新所有页面使用新配置

修改以下文件：
- `DirectorPage.ts`
- `GeneratePage.ts`
- `BatchPage.ts`
- `ComparePage.ts`

将 `useWebWorker: false` 改为使用 `libURL` 指向本地文件。

---

## 验证

- [ ] CSP 警告消失
- [ ] 图片压缩功能正常
- [ ] Web Worker 正常工作（查看 DevTools > Sources > Workers）
