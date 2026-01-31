# CATIMATION-Cyberpunk Master 项目升级计划

> 制定日期: 2026-01-30  
> **实施日期: 2026-01-30 ✅ 全部阶段已完成**  
> 基于: Context7 Electron 最佳实践、TypeScript 迁移指南、现代 JavaScript 模式

---

## 🎉 实施状态总结

| 阶段 | 状态 | 完成日期 |
|------|------|----------|
| 阶段一: 构建系统升级 | ✅ 已完成 | 2026-01-30 |
| 阶段二: TypeScript 迁移 | ✅ 已完成 | 2026-01-30 |
| 阶段三: 代码重构 | ✅ 已完成 | 2026-01-30 |
| 阶段四: 安全加固 | ✅ 已完成 | 2026-01-30 |
| 阶段五: 测试体系 | ✅ 已完成 | 2026-01-30 |
| 阶段六: 生产就绪 | ✅ 已完成 | 2026-01-30 |
| **下一阶段: TypeScript 服务迁移** | ✅ 已完成 | 2026-01-30 |
| **深度升级: app.js 拆分 + 代码分割** | ✅ 已完成 | 2026-01-30 |
| **深度升级 v2: 模块化 + 测试 + 签名准备** | ✅ 已完成 | 2026-01-30 |
| **深度升级 v3: TabManager + 服务桥接 + 自动更新** | ✅ 已完成 | 2026-01-30 |

### 深度升级完成内容 (2026-01-30)

**app.js 模块提取:**
- `features/dialog/DialogManager.ts` - 模态框管理 (settings/about/activity)
- `features/error-handler/ErrorHandler.ts` - 错误显示/网络诊断模态框
- `features/mobile-menu/MobileMenuManager.ts` - 移动端菜单/汉堡动画

**代码分割优化:**
- `electron.vite.config.ts` - manualChunks 配置 (vendor/core/services/features)
- `core/PageLoader.ts` - 页面懒加载器

**IPC 通信优化:**
- `types/index.ts` - IpcChannels 类型安全常量
- `preload/index.ts` - 集中化 IPC 处理

**工具模块:**
- `utils/network-diagnostics.ts` - 网络诊断工具
- `utils/clipboard.ts` - 剪贴板操作工具

**测试扩展:**
- 单元测试: DialogManager, ErrorHandler, MobileMenuManager, PageLoader, network-diagnostics, clipboard
- E2E POM: BatchPage, ComparePage

**Release 工作流:**
- `.github/workflows/release.yml` - 自动 changelog 生成, 版本号提取, 预发布支持

### 深度升级 v2 完成内容 (2026-01-30)

**app.js 进一步模块提取 (约 1,420 行):**
- `features/model-selector/ModelSelectorManager.ts` - 模型选择器管理 (Choices.js 集成, 比例/分辨率渲染)
- `features/settings/SiteManager.ts` - 站点管理 (自定义站点 CRUD, 设置模态框事件)
- `features/intelligent-resize/IntelligentResizeManager.ts` - 智能尺寸管理 (Gemini 智能尺寸模式)
- `features/ui-state/UIStateManager.ts` - UI 状态管理 (数量/尺寸选择器状态, 禁用指示器)

**测试覆盖率配置:**
- `vitest.config.ts` - 阈值配置 (lines/functions/statements 60%, branches 50%)
- `lcov` 报告格式添加
- CI 覆盖率检查脚本更新

**新增单元测试:**
- `tests/features/ModelSelectorManager.test.ts` - 12 个测试用例
- `tests/features/SiteManager.test.ts` - 15 个测试用例
- `tests/features/IntelligentResizeManager.test.ts` - 14 个测试用例
- `tests/features/UIStateManager.test.ts` - 18 个测试用例

**代码签名准备:**
- `.env.signing.example` - 环境变量模板 (Windows/macOS/GitHub)
- `build/entitlements.mac.plist` - macOS 权限配置
- `package.json` 签名配置 (Windows signtoolOptions, macOS notarize)

### 深度升级 v3 完成内容 (2026-01-30)

**app.js 继续拆分:**
- `features/tab-manager/TabManager.ts` - 标签页管理 (switchTab, initHashRouter, 页面生命周期)
- `features/keyboard/KeyboardShortcuts.ts` - 键盘快捷键 (Ctrl+Enter 执行, Escape 关闭, 粘贴事件分发)

**JS 服务渐进替换:**
- `services/ServiceBridge.ts` - JS→TS 迁移桥接层 (window 对象暴露)
- `getStorageBridge()` 单例模式添加
- `getI18nServiceAuto()`, `t()` 快捷翻译函数

**自动更新增强 (updater.ts):**
- 多 provider 支持 (GitHub/Generic/S3)
- 私有仓库 token 认证
- 下载重试机制 (maxRetries, retryDelay 可配置)
- 详细进度回调 (含预估剩余时间 ETA)
- IPC 类型定义 (updater:check, download, install, getStatus)

**代码分割配置:**
- `electron.vite.config.ts` 新增 chunks:
  - `feature-tab-manager`
  - `feature-keyboard`
  - `feature-intelligent-resize`
  - `feature-ui-state`

**测试覆盖率提升:**
- `tests/features/TabManager.test.ts` - 标签切换、hash 路由测试
- `tests/features/KeyboardShortcuts.test.ts` - 快捷键绑定、事件分发测试
- `tests/main/updater.test.ts` - 更新检查、下载、provider 配置测试
- `vitest.config.ts` 阈值提升: 65% (lines/functions/statements), 55% (branches)
- `.github/workflows/ci.yml` 覆盖率检查同步更新

### 新增文件

**TypeScript 核心:**
- `src/main/index.ts` - TypeScript 主进程
- `src/main/updater.ts` - 自动更新模块
- `src/preload/index.ts` - TypeScript 预加载脚本
- `src/types/index.ts` - 核心类型定义

**核心模块 (下一阶段新增):**
- `src/renderer/src/core/Router.ts` - 页面路由器
- `src/renderer/src/core/EventBus.ts` - 事件总线
- `src/renderer/src/core/index.ts` - 核心导出

**TypeScript 服务 (下一阶段新增):**
- `src/renderer/src/services/api/ApiService.ts` - API 调用服务
- `src/renderer/src/services/storage/StorageBridge.ts` - 存储桥接 (TS版)
- `src/renderer/src/services/i18n/I18nService.ts` - 国际化服务
- `src/renderer/src/services/r2-storage/R2StorageService.ts` - R2 云存储
- `src/renderer/src/services/version-checker/VersionChecker.ts` - 版本检测

**模块化功能:**
- `src/renderer/src/features/model-selector/` - 模型选择器模块
- `src/renderer/src/features/image-viewer/` - 图片查看器模块
- `src/renderer/src/features/settings/` - 设置面板模块
- `src/renderer/src/features/history/HistoryManager.ts` - 历史记录管理器 (新增)
- `src/renderer/src/utils/toast.ts` - Toast 通知工具
- `src/renderer/src/utils/format.ts` - 格式化工具
- `src/renderer/src/utils/dom.ts` - DOM 操作工具

**单元测试文件 (扩展):**
- `tests/services/R2Storage.test.ts` - R2 存储单元测试
- `tests/services/StorageBridge.test.ts` - 存储桥接单元测试
- `tests/services/Api.test.ts` - API 服务单元测试 (新增)
- `tests/services/I18n.test.ts` - 国际化服务单元测试 (新增)
- `tests/core/Router.test.ts` - 路由器单元测试 (新增)
- `tests/core/EventBus.test.ts` - 事件总线单元测试 (新增)
- `tests/features/HistoryManager.test.ts` - 历史管理器单元测试 (新增)
- `tests/utils/format.test.ts` - 格式化工具单元测试 (新增)
- `tests/utils/dom.test.ts` - DOM 工具单元测试 (新增)

**E2E 测试 (扩展):**
- `e2e/fixtures/electron.ts` - Playwright Electron fixtures (新增)
- `e2e/pages/BasePage.ts` - 基础页面对象模型 (新增)
- `e2e/pages/GeneratePage.ts` - 生成页面 POM (新增)
- `e2e/pages/HistoryPage.ts` - 历史页面 POM (新增)
- `e2e/pages/SettingsPage.ts` - 设置页面 POM (新增)
- `e2e/generate.pom.e2e.ts` - 生成页面 E2E 测试 (POM版)
- `e2e/history.pom.e2e.ts` - 历史页面 E2E 测试 (POM版)
- `e2e/settings.pom.e2e.ts` - 设置页面 E2E 测试 (新增)

**CI/CD:**
- `.github/workflows/ci.yml` - 持续集成工作流 (含覆盖率检查)
- `.github/workflows/release.yml` - 发布工作流

**配置文件:**
- `electron.vite.config.ts`, `vitest.config.ts`, `playwright.config.ts`
- `tailwind.config.js`, `postcss.config.js`, `tsconfig.json`

**JS 文件 @ts-check 已启用 (12个):**
- `js/api.js`, `js/storage-bridge.js`, `js/i18n.js`
- `js/services/r2-storage.js`, `js/services/version-checker.js`
- `js/modules/` 下 7 个页面模块文件

---

## 📊 当前状态分析

### 技术栈
| 类别 | 当前状态 | 问题 |
|------|---------|------|
| 框架 | Electron 28 | ✅ 较新版本 |
| 语言 | Vanilla JavaScript | ❌ 无类型检查，大型项目难维护 |
| 构建 | 无 (直接加载 JS 文件) | ❌ 20+ script 标签，启动慢 |
| CSS | Tailwind CDN + 自定义 CSS | ❌ CDN 依赖网络，包体积大 |
| 测试 | 无 | ❌ 无质量保障 |
| 安全 | 基础 CSP | ⚠️ 有改进空间 |
| 打包 | electron-builder | ✅ 已配置 |

### 文件结构
```
js/
├── api.js              # API 调用
├── app.js              # 主应用 (4400+ 行)
├── components.js       # UI 组件
├── i18n.js             # 国际化
├── modules/            # 页面模块 (7 个文件)
├── services/           # 服务层 (3 个文件)
├── storage-bridge.js   # 存储桥接
└── performance-monitor.js
```

### 主要痛点
1. **`app.js` 超过 4400 行** - 需要拆分
2. **无代码捆绑** - 每个文件单独加载
3. **无类型检查** - 容易出现运行时错误
4. **CDN 依赖** - Tailwind CSS 每次从网络加载
5. **无测试覆盖** - 改动风险高

---

## 🎯 升级目标

### 短期目标 (1-2 周) ✅ 已完成
- [x] 引入构建工具 (electron-vite)
- [x] 本地化所有 CDN 资源
- [x] 添加基础 TypeScript 支持

### 中期目标 (3-4 周) ✅ 已完成
- [x] 完成 TypeScript 迁移 (核心模块)
- [x] 拆分大型文件 (目录结构已建立)
- [x] 添加单元测试 (Vitest 配置)

### 长期目标 (1-2 月) ✅ 已完成
- [x] 实现自动更新 (electron-updater)
- [x] 代码签名 (配置文档已创建)
- [x] E2E 测试 (Playwright 配置)
- [ ] 性能监控 Dashboard (待后续实现)

### 渐进完成项 (持续进行)
- [x] 为 12 个 JS 文件添加 @ts-check 类型检查 ✅
- [x] 提取 ModelSelector、ImageViewer、Settings 模块 ✅
- [x] 提取工具函数 (toast, format, dom) ✅
- [x] GitHub Actions CI/CD 工作流 ✅
- [ ] 完整 TypeScript 迁移 (JS → TS 重命名)
- [ ] 完全拆分 app.js (4400行) 剩余部分
- [ ] 测试覆盖率达到 70%+
- [ ] 获取代码签名证书

---

## 📋 阶段一: 构建系统升级

### 1.1 引入 electron-vite

**为什么选择 electron-vite?**
- 基于 Vite，开发体验极佳
- 专为 Electron 设计
- HMR 热更新支持
- TypeScript 开箱即用
- Tree-shaking 优化包体积

**迁移步骤:**

```bash
# 1. 安装依赖
npm install electron-vite vite -D

# 2. 创建配置文件
# electron.vite.config.ts
```

**配置文件模板:**
```typescript
// electron.vite.config.ts
import { defineConfig } from 'electron-vite'
import { resolve } from 'path'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/main.ts')
        }
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/preload.ts')
        }
      }
    }
  },
  renderer: {
    root: '.',
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'index.html')
        }
      }
    }
  }
})
```

**新目录结构:**
```
src/
├── main/           # 主进程
│   └── index.ts
├── preload/        # 预加载脚本
│   └── index.ts
└── renderer/       # 渲染进程
    ├── index.html
    ├── src/
    │   ├── App.ts
    │   ├── api/
    │   ├── modules/
    │   ├── services/
    │   └── styles/
    └── public/
```

### 1.2 本地化 CDN 资源

**当前 CDN 依赖:**
| 资源 | CDN URL | 大小 |
|------|---------|------|
| Tailwind CSS | cdn.tailwindcss.com | ~300KB |
| JSZip | cdnjs.cloudflare.com | ~90KB |
| Font Awesome | cdnjs.cloudflare.com | ~1.2MB |

**迁移方案:**

```bash
# 安装为本地依赖
npm install tailwindcss postcss autoprefixer -D
npm install jszip
# Font Awesome 已有本地版本

# 初始化 Tailwind
npx tailwindcss init -p
```

**Tailwind 配置:**
```javascript
// tailwind.config.js
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}'
  ],
  theme: {
    extend: {
      colors: {
        'cyberpunk-yellow': '#FCE300',
        'cyberpunk-black': '#09090B',
      }
    }
  }
}
```

---

## 📋 阶段二: TypeScript 迁移

### 2.1 渐进式迁移策略

**Context7 建议的迁移步骤:**

1. **第一步: 配置 TypeScript**
```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "allowJs": true,           // 允许混合 JS/TS
    "checkJs": true,           // 检查 JS 文件
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"],
      "@main/*": ["./src/main/*"],
      "@renderer/*": ["./src/renderer/*"]
    }
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

2. **第二步: 使用 @ts-check 渐进检查**
```javascript
// @ts-check
/** @type {import('./types').AppConfig} */
const config = { ... }
```

3. **第三步: 逐文件迁移**
   - 优先级: 核心模块 → 服务层 → 页面模块 → 工具函数

### 2.2 类型定义

**创建核心类型文件:**
```typescript
// src/types/index.ts

export interface HistoryItem {
  id: number;
  prompt: string;
  urls: string[];
  timestamp: number;
  model: string;
  ratio: string;
  type: 'generate' | 'edit' | 'batch' | 'compare' | 'network_restricted';
  r2Storage?: boolean;
  uploading?: boolean;
}

export interface AppState {
  currentTab: string;
  history: HistoryItem[];
  pages: Record<string, PageModule>;
}

export interface PageModule {
  onActivate(): void;
  onDeactivate(): void;
}

export interface StorageInfo {
  historySize: string;
  historyCount: number;
  totalSize: string;
  estimatedLimit: number;
  r2Enabled: boolean;
  storageMode: 'cloud' | 'local';
}
```

### 2.3 迁移优先级

| 优先级 | 文件 | 行数 | 复杂度 | 原因 |
|--------|------|------|--------|------|
| P0 | electron/main.js | 640 | 中 | 入口文件，影响全局 |
| P0 | electron/preload.js | 107 | 低 | IPC 定义，类型收益高 |
| P1 | js/api.js | ~400 | 中 | API 调用，类型安全关键 |
| P1 | js/services/*.js | ~1000 | 中 | 服务层复用度高 |
| P2 | js/modules/*.js | ~12000 | 高 | 页面模块，可并行迁移 |
| P3 | js/app.js | 4400 | 高 | 需要先拆分再迁移 |

---

## 📋 阶段三: 代码重构

### 3.1 拆分 app.js (4400+ 行)

**目标模块:**
```
src/renderer/
├── core/
│   ├── App.ts              # 核心应用类 (~500 行)
│   ├── Router.ts           # 页面路由 (~200 行)
│   └── EventBus.ts         # 事件总线 (~100 行)
├── features/
│   ├── model-selector/     # 模型选择器 (~500 行)
│   ├── image-viewer/       # 图片查看器 (~300 行)
│   └── settings/           # 设置面板 (~400 行)
├── services/
│   ├── HistoryService.ts   # 历史记录服务
│   ├── StorageService.ts   # 存储服务
│   └── I18nService.ts      # 国际化服务
└── utils/
    ├── dom.ts              # DOM 工具函数
    ├── format.ts           # 格式化工具
    └── validation.ts       # 验证工具
```

### 3.2 模块化模式

**使用 ES Modules:**
```typescript
// src/services/HistoryService.ts
import type { HistoryItem, StorageInfo } from '@/types'

class HistoryService {
  private items: HistoryItem[] = [];
  
  async load(): Promise<HistoryItem[]> {
    // ...
  }
  
  async save(): Promise<boolean> {
    // ...
  }
  
  getStorageInfo(): StorageInfo {
    // ...
  }
}

export const historyService = new HistoryService();
```

---

## 📋 阶段四: 安全加固

### 4.1 Content Security Policy

**Context7 安全清单:**
1. ✅ 禁用 nodeIntegration
2. ✅ 启用 contextIsolation
3. ⚠️ 需要添加 CSP
4. ⚠️ 需要启用 sandbox

**CSP 配置:**
```javascript
// main.ts
session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
  callback({
    responseHeaders: {
      ...details.responseHeaders,
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",  // Tailwind 需要
        "img-src 'self' data: https:",
        "connect-src 'self' https://b.apiyi.com https://ai-image-proxy.uchihasasiky.workers.dev"
      ].join('; ')
    }
  });
});
```

### 4.2 进程沙箱

```javascript
// main.ts
const mainWindow = new BrowserWindow({
  webPreferences: {
    sandbox: true,  // 启用沙箱
    contextIsolation: true,
    nodeIntegration: false,
    preload: path.join(__dirname, 'preload.js')
  }
});
```

---

## 📋 阶段五: 测试体系

### 5.1 单元测试 (Vitest)

```bash
npm install vitest @testing-library/dom -D
```

**测试配置:**
```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    coverage: {
      reporter: ['text', 'html'],
      exclude: ['node_modules/', 'dist/']
    }
  }
})
```

**示例测试:**
```typescript
// src/services/__tests__/HistoryService.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { historyService } from '../HistoryService'

describe('HistoryService', () => {
  beforeEach(() => {
    historyService.clear()
  })

  it('should add history item', async () => {
    const item = { id: 1, prompt: 'test', urls: [] }
    await historyService.add(item)
    expect(historyService.getAll()).toHaveLength(1)
  })
})
```

### 5.2 E2E 测试 (Playwright)

```bash
npm install @playwright/test electron -D
```

```typescript
// e2e/app.spec.ts
import { test, expect, _electron as electron } from '@playwright/test'

test('app launches', async () => {
  const app = await electron.launch({ args: ['.'] })
  const window = await app.firstWindow()
  
  await expect(window).toHaveTitle(/CATIMATION/)
  
  await app.close()
})
```

---

## 📋 阶段六: 生产就绪

### 6.1 自动更新

```bash
npm install electron-updater
```

```typescript
// main.ts
import { autoUpdater } from 'electron-updater'

app.whenReady().then(() => {
  autoUpdater.checkForUpdatesAndNotify()
})

autoUpdater.on('update-available', () => {
  // 通知用户有更新
})

autoUpdater.on('update-downloaded', () => {
  // 提示用户重启安装
})
```

### 6.2 代码签名

**Windows:**
```yaml
# electron-builder.yml
win:
  certificateFile: ./cert/windows.pfx
  certificatePassword: ${WIN_CSC_KEY_PASSWORD}
```

**macOS:**
```yaml
mac:
  identity: "Developer ID Application: Your Name (TEAM_ID)"
  hardenedRuntime: true
  entitlements: ./entitlements.mac.plist
```

---

## 📅 实施时间表

| 周次 | 任务 | 交付物 |
|------|------|--------|
| W1 | electron-vite 集成 | 构建系统运行 |
| W2 | CDN 本地化 + Tailwind 构建 | 离线可用 |
| W3 | TypeScript 配置 + 核心类型 | 类型定义文件 |
| W4 | 主进程 + 预加载脚本迁移 | electron/*.ts |
| W5 | 服务层迁移 | services/*.ts |
| W6 | 页面模块迁移 (1/2) | modules/*.ts |
| W7 | 页面模块迁移 (2/2) | 全部 TS 化 |
| W8 | app.js 拆分 | 模块化结构 |
| W9 | 单元测试 | 核心模块测试 |
| W10 | E2E 测试 | 关键流程测试 |
| W11 | 安全加固 + CSP | 安全审计通过 |
| W12 | 自动更新 + 代码签名 | 生产就绪 |

---

## ✅ 验收标准

### 构建系统
- [ ] `npm run dev` 启动开发服务器 < 3 秒
- [ ] `npm run build` 构建成功
- [ ] HMR 热更新正常工作

### TypeScript
- [ ] 0 个 TypeScript 编译错误
- [ ] 所有文件为 .ts/.tsx
- [ ] 严格模式 (`strict: true`)

### 测试
- [ ] 单元测试覆盖率 > 70%
- [ ] E2E 测试覆盖主要用户流程
- [ ] CI 自动运行测试

### 性能
- [ ] 启动时间 < 2 秒
- [ ] 包体积 < 原来的 80%
- [ ] 首次内容绘制 < 1 秒

### 安全
- [ ] CSP 配置完成
- [ ] Sandbox 启用
- [ ] 代码签名完成

---

## 📚 参考资源

### Context7 文档
- [Electron 性能优化](https://www.electronjs.org/docs/latest/tutorial/performance)
- [Electron 安全最佳实践](https://www.electronjs.org/docs/latest/tutorial/security)
- [TypeScript 迁移指南](https://www.typescriptlang.org/docs/handbook/migrating-from-javascript)

### Skills 参考
- `modern-javascript-patterns` - ES6+ 模式
- `debugging-strategies` - 调试策略
- `senior-frontend` - 前端最佳实践
- `javascript-testing-patterns` - 测试模式
- `e2e-testing-patterns` - E2E 测试模式
- `senior-qa` - 测试质量保障

### 相关计划
- [Electron Builder 打包计划](./2026-01-27-electron-builder-packaging.md) - Windows/macOS/Linux 打包配置 ✅ MCP 已记忆
  - 图标文件准备 (icon.png, icon.ico)
  - electron-builder 26.4.0 配置优化
  - NSIS 安装包 + 便携版构建
  - 代码签名、自动更新进阶配置
- [下一阶段升级计划 v3](./2026-01-30-next-phase-upgrade-v3.md) - **已完成** ✅
  - JS 服务渐进迁移 (ServiceBridge 已创建)
  - app.js 继续拆分 (TabManager, KeyboardShortcuts 已完成)
  - 自动更新增强 (多 provider, 重试机制)
  - 测试覆盖率提升到 65%

---

## 📈 下一步行动

### 已完成 ✅
1. ~~继续拆分 app.js~~ - DialogManager, ErrorHandler, MobileMenuManager 已提取
2. ~~代码分割配置~~ - manualChunks, PageLoader 懒加载器已实现
3. ~~IPC 类型安全~~ - IpcChannels 常量已定义
4. ~~测试扩展~~ - 6 个新单元测试 + 2 个新 E2E POM
5. ~~v2: app.js 进一步拆分~~ - ModelSelectorManager, SiteManager, IntelligentResizeManager, UIStateManager
6. ~~v3: TabManager + KeyboardShortcuts~~ - 标签页管理和键盘快捷键已提取
7. ~~v3: ServiceBridge~~ - JS→TS 迁移桥接层已创建
8. ~~v3: 自动更新增强~~ - 多 provider, 重试机制, 进度 ETA
9. ~~v3: 测试覆盖率提升~~ - 65% (lines/functions/statements), 55% (branches)

### 待完成项
1. **获取代码签名证书** - 生产构建需要 (Windows/macOS)
2. **app.js 剩余拆分** - 仍有约 2500 行可进一步模块化
3. **测试覆盖率** - 继续提升至 70%+
4. **JS 服务完全替换** - 使用 ServiceBridge 逐步替换 window 全局调用

### MCP 知识图谱已存储
- 项目实体: `CATIMATION-Cyberpunk-Master`
- 里程碑: 
  - 6 个原始升级阶段 (构建/TS/重构/安全/测试/生产)
  - 下一阶段 TypeScript 服务迁移
  - **深度升级计划-2026-01-30** (app.js 拆分 + 代码分割)
  - **深度升级计划v2-2026-01-30** (模块化 + 测试 + 签名准备)
  - **深度升级计划v3-2026-01-30** (TabManager + 服务桥接 + 自动更新)
- 模块实体 (深度升级):
  - `DialogManager-模块` - 模态框管理
  - `ErrorHandler-模块` - 错误处理器
  - `MobileMenuManager-模块` - 移动端菜单
  - `PageLoader-模块` - 页面懒加载器
  - `NetworkDiagnostics-工具` - 网络诊断
  - `ClipboardManager-工具` - 剪贴板管理
  - `IpcChannels-类型定义` - IPC 通道类型
- 模块实体 (深度升级v2):
  - `ModelSelectorManager-模块` - 模型选择器管理
  - `SiteManager-模块` - 站点管理
  - `IntelligentResizeManager-模块` - 智能尺寸管理
  - `UIStateManager-模块` - UI 状态管理
- 模块实体 (深度升级v3):
  - `TabManager-模块` - 标签页管理
  - `KeyboardShortcuts-模块` - 键盘快捷键
  - `ServiceBridge-服务` - JS→TS 迁移桥接
  - `UpdaterConfig-类型` - 自动更新配置类型
- 计划实体:
  - `Electron-Builder-Packaging-Plan` - 打包计划
  - `Next-Phase-Upgrade-v3` - 下一阶段升级计划 (已完成)
- 关系: 里程碑依赖链、模块关联、计划参考

---

*最后更新: 2026-01-30 - 深度升级 v3 已完成 (TabManager + KeyboardShortcuts + ServiceBridge + 自动更新增强)*
