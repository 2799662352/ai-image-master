# AI Image Master Phase 3: 性能优化计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 基于 Context7 获取的 Electron 和 Vite 最佳实践，优化应用启动和运行性能

**Architecture:** 
- Electron 主进程：禁用默认菜单、异步 I/O、延迟加载
- Vite 构建：代码分割优化、manualChunks 策略
- 渲染进程：懒加载、预取策略

**Tech Stack:** Electron 28, Vite 7, electron-vite, TypeScript

---

## Context7 最佳实践参考

### Electron 性能优化 (来源: electron/electron)

1. **禁用默认菜单** - 在 `app.ready` 前调用 `Menu.setApplicationMenu(null)`
2. **延迟资源加载** - 使用 just-in-time 模式，仅在需要时加载模块
3. **异步 I/O** - 使用 `fs.promises` 替代同步方法
4. **避免同步 IPC** - 不使用 `ipcRenderer.sendSync`

### Vite 代码分割 (来源: vitejs/vite)

1. **import.meta.glob** - 懒加载模块，按需加载
2. **manualChunks** - 自定义分块策略，优化缓存
3. **eager: true** - 关键模块立即加载
4. **Tree-shaking** - 移除未使用代码

---

## 当前状态检查

| 检查项 | 状态 | 说明 |
|-------|-----|------|
| 测试通过 | ✅ | 730/730 |
| 构建成功 | ✅ | electron-builder 正常 |
| JS 迁移 | ✅ | 已完成 |
| 代码分割 | ⚠️ 需优化 | 当前有 manualChunks 但可改进 |

---

## Task 1: 检查并优化 Electron 主进程

**Files:**
- 检查: `src/main/index.ts`
- 验证: 是否已实现 Electron 性能最佳实践

**Step 1: 检查当前主进程实现**

```bash
# 检查是否已禁用默认菜单
grep -n "Menu.setApplicationMenu" src/main/index.ts

# 检查是否使用同步 I/O
grep -n "Sync(" src/main/
```

**Step 2: 验证异步模式**

确保所有文件操作使用 `fs.promises`:
- `fs.readFileSync` → `fs.promises.readFile`
- `fs.writeFileSync` → `fs.promises.writeFile`
- `fs.readdirSync` → `fs.promises.readdir`

---

## Task 2: 优化 Vite 代码分割策略

**Files:**
- 修改: `electron.vite.config.ts`

**Step 1: 分析当前分块策略**

```bash
npm run build:vite
# 查看输出的 chunk 大小
```

**Step 2: 优化 manualChunks 配置**

基于 Context7 Vite 文档的最佳实践:

```typescript
// electron.vite.config.ts
export default defineConfig({
  renderer: {
    build: {
      rollupOptions: {
        output: {
          manualChunks: (id) => {
            // 第三方库分离
            if (id.includes('node_modules')) {
              if (id.includes('choices.js')) return 'vendor-choices'
              if (id.includes('jszip')) return 'vendor-jszip'
              return 'vendor'
            }
            // 功能模块分离
            if (id.includes('/features/')) {
              const match = id.match(/\/features\/([^/]+)\//)
              if (match) return `feature-${match[1]}`
            }
            // 页面模块分离
            if (id.includes('/pages/')) {
              const match = id.match(/\/pages\/([^/]+)\//)
              if (match) return `page-${match[1]}`
            }
          }
        }
      }
    }
  }
})
```

---

## Task 3: 添加测试覆盖率工具

**Files:**
- 修改: `package.json`

**Step 1: 安装覆盖率依赖**

```bash
npm install -D @vitest/coverage-v8
```

**Step 2: 验证覆盖率报告**

```bash
npm run test:coverage
```

---

## Task 4: 优化渲染进程懒加载

**Files:**
- 检查: `src/renderer/src/main.ts`
- 优化: 非关键模块延迟加载

**Step 1: 识别非关键模块**

非关键模块（可延迟加载）:
- HistoryManager
- VersionChecker
- PerformanceDashboard

关键模块（立即加载）:
- I18nService
- ApiService
- UIComponentsService

**Step 2: 实现延迟加载**

```typescript
// 延迟加载非关键模块
requestIdleCallback(() => {
  import('./services/HistoryManager').then(m => m.init())
  import('./services/VersionChecker').then(m => m.init())
})
```

---

## 验证清单

- [ ] `npm run test:run` - 730 测试通过
- [ ] `npm run build:vite` - 构建成功
- [ ] `npm run build:dir` - 打包成功
- [ ] 启动时间测量 - 记录优化前后对比

---

## 优先级排序

| 任务 | 优先级 | 预计时间 | 收益 |
|-----|-------|---------|-----|
| Task 3: 测试覆盖率 | 高 | 5 分钟 | 代码质量可视化 |
| Task 1: 主进程检查 | 中 | 10 分钟 | 确认最佳实践 |
| Task 2: 代码分割 | 中 | 20 分钟 | 更快加载 |
| Task 4: 懒加载 | 低 | 30 分钟 | 更快首屏 |

---

## 参考文档

- Electron Performance: https://github.com/electron/electron/blob/main/docs/tutorial/performance.md
- Vite Code Splitting: https://vitejs.dev/guide/build.html#chunking-strategy
- electron-vite: https://electron-vite.org/guide/build
