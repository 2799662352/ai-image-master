# 示例图库修复计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复导演模式示例图库显示和编辑功能

**Architecture:** 修正元素 ID 不匹配、复制缺失资产、修复编辑功能

**Tech Stack:** TypeScript, HTML, 静态资产

---

## 问题分析

### 问题 1: 元素 ID 不匹配
- TypeScript 代码查找 `builtinGalleryGrid`
- HTML 实际使用 `directorGalleryGrid`

### 问题 2: 资产文件缺失
- 原始项目有 `assets/templates/anime-example-01.png` 等 38 张图片
- 迁移后项目没有这个目录

### 问题 3: 编辑功能不工作
- 需要检查编辑按钮的事件绑定

---

## Task 1: 修复元素 ID 不匹配

**Files:**
- Modify: `src/renderer/src/pages/DirectorPage.ts`

**修复内容:**
将 `builtinGalleryGrid` 改为 `directorGalleryGrid`

---

## Task 2: 复制资产文件

**Files:**
- Copy: 原始项目 `assets/templates/` → 迁移项目 `src/renderer/public/assets/templates/`

---

## Task 3: 修复资产路径

**Files:**
- Modify: `src/renderer/src/pages/DirectorPage.ts`

**修复内容:**
将 `./assets/templates/` 改为 `assets/templates/`

---

## Task 4: 验证和测试

**步骤:**
1. 构建应用
2. 启动应用
3. 打开导演模式 → 示例图库
4. 验证 38 张内置示例图片显示
5. 验证编辑功能

---
