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
