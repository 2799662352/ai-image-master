# CATIMATION-Cyberpunk Master

AI 图片生成桌面应用（Electron + React + LangChain/LangGraph）。

## 项目简介

本项目是一个基于 Electron 的 AI 创作工具，支持：

- 文生图、参考图生成、批量生成
- Director 多阶段管线生成（技能选择、场景分析、角色锚点、设计组装、一致性校验）
- 本地桌面持久化与历史记录管理

## 技术栈

- Electron 28
- React 19 + Zustand
- Vite / electron-vite
- TypeScript
- LangChain + LangGraph
- Vitest + Playwright

## 环境要求

- Node.js 18+（建议 20+）
- npm 9+

## 安装与启动

```bash
npm install
npm run dev
```

常用命令：

- `npm run dev`：开发模式（electron-vite）
- `npm run start`：直接启动 Electron
- `npm run preview`：预览构建产物
- `npm run typecheck`：TypeScript 检查

## 测试命令

- `npm run test`：Vitest 交互
- `npm run test:run`：Vitest 一次性执行
- `npm run test:coverage`：覆盖率
- `npm run test:e2e`：Playwright E2E

## 打包与发布

- `npm run build:vite`：构建 main/preload/renderer
- `npm run build`：构建并打包
- `npm run build:win`：Windows 包
- `npm run build:dir`：仅输出 unpacked 目录
- `npm run release`：发布流程（按仓库配置）
- 打包实操文档：`docs/packaging-guide.md`

## Skills 系统说明（重点）

### 1) 内置 Skills

- 内置技能位于仓库 `skills/` 目录。
- 打包时通过 `extraResources` 一并带入应用资源目录。

### 2) 用户自定义 Skills（打包后可扩展）

应用支持运行时读取用户技能目录：

- 目录：`app.getPath('userData')/skills/<skill-name>/SKILL.md`
- 主进程通过 IPC `load-skills` / `save-skill` 读写
- 渲染进程支持手动“刷新 Skills”重载缓存

这意味着：打包后用户新增 skill 文件可生效（刷新后立即生效）。

### 3) 合并策略

- 最终技能集合 = 内置 skills + 用户 skills
- 同名 `id` 冲突时：用户技能覆盖内置技能
- 坏格式 skill 会被跳过，不中断主流程

## 目录概览

- `src/main`：Electron 主进程（窗口、IPC、文件系统）
- `src/preload`：安全桥接（`contextBridge` + `ipcRenderer.invoke`）
- `src/renderer`：前端与业务逻辑
- `src/renderer/src/services/pipeline`：Director/Storyboard 管线
- `skills`：内置技能定义（`SKILL.md`）

## 许可证

MIT

# AI Image Master

<div align="center">

![TypeScript](https://img.shields.io/badge/TypeScript-95%25-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-35.0.0-47848F?style=flat-square&logo=electron&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-6.2.0-646CFF?style=flat-square&logo=vite&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)

**AI 图片生成桌面应用 - 支持多种 AI 模型**

[功能特性](#-功能特性) • [快速开始](#-快速开始) • [技术架构](#-技术架构) • [项目结构](#-项目结构)

</div>

---

## ✨ 功能特性

### 🎨 图片生成
- **多模型支持**: Gemini, Seedream, Sora, Flux Kontext
- **参考图上传**: 拖拽、粘贴、多图支持
- **智能比例**: 自动检测最佳比例
- **多分辨率**: 1K / 2K / 4K 可选

### 🎬 导演模式 (Director Mode)
- **九宫格分镜**: 3×3 电影级分镜生成
- **剧场版动画**: 日式动画风格，权重标记语法
- **电影级模板**: 分形几何原则，角色一致性保证
- **Sora2 视频提示词**: 一键生成视频提示词
- **多风格模板**: 动画、漫画、电影、韩漫、美漫、插画

### 📦 批量生成
- **抽卡模式**: 同一提示词生成多张
- **多提示词模式**: 批量不同提示词
- **并发控制**: 智能队列管理

### 🔍 模型对比
- 双模型同时生成对比
- 参考图自动同步

### 📜 历史记录
- 自动保存生成记录
- R2 云端存储
- 批量下载/删除
- 点击预览大图

### 🖼️ 图像理解
- 多模型图像分析
- 流式输出响应
- 自定义提示词

---

## 🚀 快速开始

### 环境要求

- Node.js >= 18.0.0
- npm >= 9.0.0

### 安装依赖

```bash
npm install
```

### 开发模式

```bash
npm run dev
```

### 构建应用

```bash
# 构建渲染进程
npm run build:vite

# 构建 Electron 应用
npm run build

# 打包为安装程序
npm run package
```

---

## 🏗️ 技术架构

| 层级 | 技术 | 说明 |
|------|------|------|
| **框架** | Electron 35 | 跨平台桌面应用 |
| **构建** | Vite 6 + electron-vite | 快速开发构建 |
| **语言** | TypeScript 5.7 | 类型安全 |
| **样式** | Tailwind CSS 4 | 原子化 CSS |
| **存储** | Cloudflare R2 | 云端图片存储 |
| **测试** | Vitest + Playwright | 单元测试 + E2E |

### 架构特点

```
┌─────────────────────────────────────────────────────┐
│                    Electron Main                     │
│  ┌───────────────┐  ┌───────────────┐  ┌─────────┐ │
│  │  Auto Updater │  │  IPC Handlers │  │ Dialogs │ │
│  └───────────────┘  └───────────────┘  └─────────┘ │
└─────────────────────────────────────────────────────┘
                           │
                    IPC Bridge (Preload)
                           │
┌─────────────────────────────────────────────────────┐
│                  Renderer Process                    │
│  ┌─────────────────────────────────────────────┐   │
│  │              ServiceBridge (TS)              │   │
│  │  ┌─────────┐ ┌─────────┐ ┌───────────────┐ │   │
│  │  │ API Svc │ │ Storage │ │ HistoryManager│ │   │
│  │  └─────────┘ └─────────┘ └───────────────┘ │   │
│  └─────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────┐   │
│  │                 Pages (TS)                   │   │
│  │  ┌──────────┐ ┌──────────┐ ┌────────────┐  │   │
│  │  │ Generate │ │ Director │ │  History   │  │   │
│  │  │   Page   │ │   Page   │ │    Page    │  │   │
│  │  └──────────┘ └──────────┘ └────────────┘  │   │
│  └─────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

---

## 📁 项目结构

```
ai-image-master/
├── src/
│   ├── main/                    # Electron 主进程
│   │   └── index.ts             # 主进程入口
│   ├── preload/                 # 预加载脚本
│   │   └── index.ts             # IPC 桥接
│   └── renderer/                # 渲染进程
│       ├── src/
│       │   ├── pages/           # 页面模块
│       │   │   ├── GeneratePage.ts    # 图片生成
│       │   │   ├── DirectorPage.ts    # 导演模式 ⭐
│       │   │   ├── BatchPage.ts       # 批量生成
│       │   │   ├── HistoryPage.ts     # 历史记录
│       │   │   ├── ComparePage.ts     # 模型对比
│       │   │   └── UnderstandPage.ts  # 图像理解
│       │   ├── services/        # 服务层
│       │   │   ├── api/         # API 服务
│       │   │   ├── storage/     # 存储服务
│       │   │   └── i18n/        # 国际化
│       │   ├── features/        # 功能模块
│       │   │   ├── model-selector/    # 模型选择器
│       │   │   ├── tab-manager/       # 标签管理
│       │   │   └── history/           # 历史数据服务
│       │   ├── core/            # 核心模块
│       │   │   ├── AppBootstrap.ts    # 应用引导
│       │   │   └── VirtualScroller.ts # 虚拟滚动
│       │   └── utils/           # 工具函数
│       ├── public/              # 静态资源
│       │   ├── i18n/            # 多语言文件
│       │   ├── css/             # 样式文件
│       │   └── data/            # 配置数据
│       └── index.html           # HTML 入口
├── tests/                       # 测试文件
├── e2e/                         # E2E 测试
├── docs/                        # 文档
│   └── plans/                   # 开发计划
└── dist/                        # 构建输出
```

---

## 🎬 导演模式详解

### 风格模板

| 模板 | 说明 | 特点 |
|------|------|------|
| `theatrical` | 剧场版动画 | 日式权重标记 `((style:1.5))` |
| `cinematic` | 电影级九宫格 | 分形几何，角色一致性 |
| `anime` | 动画截图 | 赛璐璐着色 |
| `manga` | 漫画分镜 | 黑白墨线，网点 |
| `movie` | 电影分镜 | 宽银幕，戏剧光影 |
| `webtoon` | 韩漫/条漫 | 全彩，纵向排版 |

### JSON Shots 系统

```typescript
// AI 生成结构化分镜
{
  "shots": [
    {
      "shot_number": "分镜1",
      "prompt_text": "Wide shot, character stands..."
    },
    // ... 9个分镜
  ],
  "style_template": "theatrical",
  "negative_prompt": "..."
}
```

### Sora2 视频提示词

```
@角色卡 The video plays out in a continuous 9-part sequence:
1. Wide shot: character in the rain...
2. Over-the-shoulder: looking at city...
...
9. Back view: walking away...
```

---

## 🌍 国际化支持

- 🇨🇳 简体中文 (zh-CN)
- 🇹🇼 繁体中文 (zh-TW)
- 🇺🇸 English (en)
- 🇷🇺 Русский (ru)

---

## 📊 测试覆盖

```bash
# 运行单元测试
npm test

# 运行 E2E 测试
npm run test:e2e

# 查看测试覆盖率
npm run test:coverage
```

当前覆盖率: **53%** (1281/1298 tests passing)

---

## 📝 开发日志

### 2026-02-02
- ✅ Director Mode 优化 - 电影级九宫格
- ✅ 剧场版动画风格模板
- ✅ JSON Shots 风格配置系统
- ✅ Sora2 视频提示词生成
- ✅ 历史页面缩略图点击预览
- ✅ 参考图点击预览 (全页面)
- ✅ i18n 多语言完善

---

## 📄 License

MIT License - 详见 [LICENSE](LICENSE)

---

<div align="center">

**Built with ❤️ using Electron + TypeScript + Vite**

</div>
