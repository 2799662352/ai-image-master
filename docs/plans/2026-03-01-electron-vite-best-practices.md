# electron-vite 最佳实践适配 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**目标:** 将项目的 electron-vite 配置升级到符合官方最佳实践，修复依赖管理、HMR 开发体验、TypeScript 配置等问题。

**架构:** 采用渐进式修复策略，按优先级从高到低逐步修改。每个 Task 独立可验证，确保修改不引入回归。核心思路是：(1) 添加 externalizeDepsPlugin；(2) 启用 HMR 开发模式；(3) 修正依赖分类；(4) 补全 TypeScript 配置；(5) 清理过时配置。

**技术栈:** electron-vite 5.x, Electron 38 (Chromium 140, Node 22), Vite 7.3, TypeScript 5.9

**参考文档 (via Context7):**
- electron-vite 官方文档: https://electron-vite.org
- externalizeDepsPlugin 指南: https://electron-vite.org/guide/build
- HMR 配置: https://electron-vite.org/guide/hmr
- 项目结构约定: https://electron-vite.org/guide/dev

---

## 当前问题清单（按优先级排序）

| # | 严重级别 | 问题 | 影响 |
|---|---------|------|------|
| 1 | 🔴 严重 | 未使用 `externalizeDepsPlugin` | 主进程/preload 打包膨胀，原生模块兼容性风险 |
| 2 | 🔴 严重 | 缺少 HMR 支持 (`ELECTRON_RENDERER_URL`) | 开发效率极低，每次改动需重新构建 |
| 3 | 🟡 中等 | `dependencies` vs `devDependencies` 分类错误 | 配合 externalizeDepsPlugin 后会导致运行时缺失 |
| 4 | 🟡 中等 | 主进程使用 `require()` 而非 `import()` | 不符合 ESM 标准，electron-vite 原生支持 ESM |
| 5 | 🟡 中等 | 缺少 TypeScript 配置文件 | 无类型检查、无路径别名解析、IDE 支持不完整 |
| 6 | 🟢 轻微 | `build.esbuild` 在 Vite 7 中可能已废弃 | 潜在构建警告或兼容性问题 |
| 7 | ✅ 正确 | `chrome140` 目标 (Electron 38 = Chromium 140) | 无需修改 |
| 8 | ✅ 正确 | `node22` 目标 (Electron 38 = Node 22) | 无需修改 |
| 9 | ✅ 正确 | 项目结构 `src/main`, `src/preload`, `src/renderer` | 符合 electron-vite 推荐结构 |
| 10 | ✅ 正确 | `src/renderer/index.html` 存在且引用 `./src/main.ts` | 符合 Vite 入口规范 |

---

### Task 1: 添加 externalizeDepsPlugin（核心插件）

**背景说明:**
electron-vite 文档明确推荐：main 和 preload 进程使用 `externalizeDepsPlugin` 来外部化 `package.json` 中 `dependencies` 的包。这样做的好处：
- 减小主进程 bundle 体积
- 避免原生模块（如 electron-store）的打包兼容性问题
- 与 Electron 的 Node.js 运行时直接对接

**文件:**
- 修改: `electron.vite.config.ts:1-22`

**Step 1: 修改 electron.vite.config.ts，添加 externalizeDepsPlugin**

```typescript
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'path'

const isAnalyze = process.env.npm_lifecycle_event === 'analyze' || process.argv.includes('--mode=analyze')
const isProd = process.env.NODE_ENV === 'production'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist/main',
      target: 'node22',
      minify: isProd,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist/preload',
      target: 'node22',
      minify: isProd,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    // ... renderer 配置保持不变
  }
})
```

**Step 2: 验证构建不报错**

运行: `npx electron-vite build`
预期: 构建成功，`dist/main/index.js` 不再包含 `electron-store` 和 `electron-updater` 的源码

**Step 3: 提交**

```bash
git add electron.vite.config.ts
git commit -m "build: add externalizeDepsPlugin to main and preload"
```

---

### Task 2: 启用 HMR 开发模式

**背景说明:**
electron-vite 的核心价值在于开发时的热模块替换。`electron-vite dev` 会启动一个 Vite 开发服务器，并通过 `ELECTRON_RENDERER_URL` 环境变量传递给主进程。主进程需要检查此变量来决定加载开发服务器还是本地文件。

**文件:**
- 修改: `src/main/index.ts:304-306`

**Step 1: 修改 loadFile 逻辑，添加 HMR 支持**

找到当前代码（约第 304-306 行）：
```typescript
  // 加载页面 - 始终使用构建好的文件
  // 如果需要热重载开发，请使用 electron-vite dev
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
```

替换为：
```typescript
  // electron-vite dev 模式: 加载 Vite 开发服务器 URL (HMR 热更新)
  // electron-vite build + electron .: 加载构建后的本地文件
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
```

**Step 2: 修改 isDev 检测逻辑**

找到当前代码（约第 8 行）：
```typescript
const isDev = process.argv.includes('--dev') || process.env.NODE_ENV === 'development'
```

替换为（添加 `app.isPackaged` 检测，更可靠）：
```typescript
const isDev = !app.isPackaged || process.argv.includes('--dev') || process.env.NODE_ENV === 'development'
```

注意：`app.isPackaged` 在 `electron-vite dev` 时自动为 `false`。

**Step 3: 更新 CSP will-navigate 白名单**

找到当前代码（约第 234 行）：
```typescript
    if (parsedUrl.protocol !== 'file:' && parsedUrl.origin !== 'http://localhost:5173') {
```

替换为（支持 electron-vite 的动态端口）：
```typescript
    const devServerUrl = process.env['ELECTRON_RENDERER_URL']
    const isDevNavigation = devServerUrl && navigationUrl.startsWith(devServerUrl)
    if (parsedUrl.protocol !== 'file:' && !isDevNavigation) {
```

**Step 4: 验证 HMR 开发模式**

运行: `npx electron-vite dev`
预期: 应用启动并连接到 Vite 开发服务器，修改 renderer 源码后页面自动热更新

**Step 5: 验证生产模式**

运行: `npx electron-vite build && npx electron .`
预期: 应用正常加载构建后的本地文件

**Step 6: 提交**

```bash
git add src/main/index.ts
git commit -m "feat: enable HMR dev mode with ELECTRON_RENDERER_URL"
```

---

### Task 3: 修正 dependencies vs devDependencies

**背景说明:**
electron-vite 文档明确说明：
- `dependencies`: 应用运行时需要的包 → 配合 `externalizeDepsPlugin` 被外部化（不打包）
- `devDependencies`: 仅构建时需要的包 → 被 Vite 打包进 bundle

对于 renderer 进程的包（choices.js, jszip 等），它们会被 Vite 打包进 renderer bundle，所以放在 `devDependencies` 是正确的。

对于 main/preload 进程的包（electron-store, electron-updater 等），由于使用了 `externalizeDepsPlugin`，它们必须在 `dependencies` 中，否则运行时找不到。

**文件:**
- 修改: `package.json`

**Step 1: 确认当前依赖分类**

当前 `dependencies`（会被 externalizeDepsPlugin 外部化）：
- `electron-store` ✅ 正确（main 进程运行时依赖）
- `electron-updater` ✅ 正确（main 进程运行时依赖）

当前 `devDependencies` 中需要检查的包：
- `sharp` — 如果在 main 进程使用 → 应移到 `dependencies`
- `@langchain/*` — 如果在 renderer 进程使用 → 保持在 `devDependencies`（会被 Vite 打包）
- `choices.js`, `jszip`, `browser-image-compression` — renderer 进程使用 → 保持在 `devDependencies`（正确，Vite 会打包）
- `zod` — 如果在 renderer 进程使用 → 保持在 `devDependencies`

**Step 2: 检查 sharp 是否在 main 进程使用**

运行: 在 `src/main/` 中搜索 `sharp` 的引用
- 如果 main 进程使用了 sharp → 移到 `dependencies` 并在 `externalizeDepsPlugin` 中处理
- 如果只在 renderer 或构建脚本中使用 → 保持在 `devDependencies`

**Step 3: 验证**

运行: `npx electron-vite build && npx electron .`
预期: 应用正常启动，无 MODULE_NOT_FOUND 错误

**Step 4: 提交**

```bash
git add package.json
git commit -m "fix: correct dependencies classification for externalizeDepsPlugin"
```

---

### Task 4: 主进程 require() → 动态 import()

**背景说明:**
electron-vite 原生支持 ESM。`require()` 是 CJS 风格，而 `import()` 是 ESM 标准。虽然 electron-vite 默认将 main 进程打包为 CJS 格式（Electron 兼容性），但使用 `import()` 可以更好地配合 tree-shaking 和代码分析。

**文件:**
- 修改: `src/main/index.ts:49,63,78,387`

**Step 1: 将 require('electron-store') 替换为动态 import()**

找到所有 `require('electron-store')` 调用（第 49、63、78 行），将懒加载模式改为：

```typescript
let StoreModule: any

async function getStoreModule() {
  if (!StoreModule) {
    StoreModule = (await import('electron-store')).default
  }
  return StoreModule
}

async function getPageStateStore(): Promise<StoreInstance> {
  if (!pageStateStore) {
    const Store = await getStoreModule()
    pageStateStore = new Store({
      name: 'page-states',
      defaults: { version: '1.0.0', states: {} }
    })
  }
  return pageStateStore!
}
```

注意：这会将 `getXxxStore()` 函数变为异步的。需要检查所有调用处是否已用 `await`。

如果改为 async 影响范围过大，可以保持 `require()` — electron-vite 打包为 CJS 后 `require` 仍然可用。此 Task 为优化性质，非必须。

**Step 2: 验证**

运行: `npx electron-vite build && npx electron .`
预期: electron-store 正常工作

**Step 3: 提交**

```bash
git add src/main/index.ts
git commit -m "refactor: replace require() with dynamic import() in main process"
```

---

### Task 5: 添加 TypeScript 配置文件

**背景说明:**
electron-vite 项目推荐使用多个 tsconfig 文件分别配置不同进程的 TypeScript 编译环境。同时需要添加 `electron-vite/node` 类型声明以支持资产导入（如 `?asset` 后缀）。

**文件:**
- 创建: `tsconfig.json`（根配置 + project references）
- 创建: `tsconfig.node.json`（main + preload 进程配置）
- 创建: `tsconfig.web.json`（renderer 进程配置）

**Step 1: 创建 tsconfig.json（根配置）**

```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.node.json" },
    { "path": "./tsconfig.web.json" }
  ]
}
```

**Step 2: 创建 tsconfig.node.json（main + preload）**

```json
{
  "compilerOptions": {
    "composite": true,
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "node",
    "lib": ["ES2022"],
    "outDir": "dist",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "types": ["electron-vite/node"],
    "paths": {
      "@types/*": ["./src/types/*"]
    }
  },
  "include": [
    "src/main/**/*",
    "src/preload/**/*",
    "src/types/**/*",
    "electron.vite.config.ts"
  ]
}
```

**Step 3: 创建 tsconfig.web.json（renderer）**

```json
{
  "compilerOptions": {
    "composite": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "outDir": "dist",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "jsx": "preserve",
    "paths": {
      "@/*": ["./src/renderer/src/*"],
      "@core/*": ["./src/renderer/src/core/*"],
      "@services/*": ["./src/renderer/src/services/*"],
      "@features/*": ["./src/renderer/src/features/*"],
      "@pages/*": ["./src/renderer/src/pages/*"],
      "@utils/*": ["./src/renderer/src/utils/*"],
      "@types/*": ["./src/types/*"],
      "@skills/*": ["./skills/*"]
    }
  },
  "include": [
    "src/renderer/src/**/*",
    "src/types/**/*"
  ]
}
```

**Step 4: 验证类型检查**

运行: `npx tsc --noEmit`
预期: 可能有预存在的类型错误，记录但不在此 Task 中修复

**Step 5: 提交**

```bash
git add tsconfig.json tsconfig.node.json tsconfig.web.json
git commit -m "build: add TypeScript configuration for electron-vite project"
```

---

### Task 6: 清理 Vite 7 兼容性问题

**背景说明:**
Vite 7 默认使用 Oxc minifier。`build.esbuild` 中的 `drop` 选项可能不再生效或产生警告。需要验证并调整。

**文件:**
- 修改: `electron.vite.config.ts` renderer 的 `build` 配置

**Step 1: 检查 Vite 7 中 esbuild.drop 是否仍然支持**

运行: `npx electron-vite build 2>&1` 并检查是否有 deprecation warning。

如果有警告，将：
```typescript
esbuild: {
  drop: isProd ? ['console', 'debugger'] : [],
  legalComments: 'none'
}
```

替换为 Vite 7 的推荐写法（如果 Oxc minifier 支持 drop）：
```typescript
minify: isProd ? 'oxc' : false,
```

如果 Vite 7 的 esbuild transform 仍然支持 `drop` 选项，则保持原样。

**Step 2: 验证构建**

运行: `npx electron-vite build`
预期: 无 deprecation warning，生产构建中无 console.log

**Step 3: 提交**

```bash
git add electron.vite.config.ts
git commit -m "build: verify Vite 7 compatibility for esbuild options"
```

---

## 修正说明（对之前分析的纠正）

1. **~~缺少 `src/renderer/index.html`~~** → 文件存在（3422 行），底部正确引用了 `<script type="module" src="./src/main.ts"></script>`
2. **~~`chrome140` 目标可能过高~~** → Electron 38.8.4 对应 Chromium 140.0.7339.41，`chrome140` 是**完全正确**的
3. **`sandbox: false`** → 不在此计划中修改，因为可能需要更深入的安全审计，且如果使用 `bytecodePlugin` 则 preload 必须禁用 sandbox

## 不修改项

| 项目 | 原因 |
|------|------|
| `chrome140` 目标 | 完全匹配 Electron 38 的 Chromium 版本 |
| `node22` 目标 | 完全匹配 Electron 38 的 Node.js 版本 |
| `sandbox: false` | 需单独安全审计；与 bytecodePlugin 有依赖 |
| 循环依赖问题 | 架构级重构，超出本计划范围 |
| `manualChunks` 策略 | 当前策略合理，与 electron-vite 最佳实践不冲突 |
| renderer resolve alias | 配置正确，与 electron-vite 兼容 |

---

## 执行顺序

```
Task 1 (externalizeDepsPlugin) → Task 3 (修正 dependencies) → Task 2 (HMR) → Task 5 (tsconfig) → Task 4 (require→import) → Task 6 (Vite 7 兼容)
```

Task 1 和 Task 3 有依赖关系（添加 externalizeDepsPlugin 后才需要确认 dependencies 分类）。其余 Task 可独立执行。
