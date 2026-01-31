# 下一阶段升级计划 v5

> 创建时间: 2026-01-30
> 状态: 📋 待执行
> 前置: v4 已完成

## 当前状态分析

### 代码指标 (v4 完成后)
| 指标 | 当前值 | 目标值 |
|------|--------|--------|
| app.js 行数 | ~4059 | <3000 |
| TypeScript 模块数 | 20+ | 25+ |
| 测试覆盖率 | ~70% | 80% |
| Bundle 分析 | 已配置 | 优化后 |

### 已完成模块 (v1-v4)
- ✅ core: Router, EventBus, PageLoader
- ✅ services: ApiService, StorageBridge, I18nService, R2Storage, VersionChecker, ServiceBridge
- ✅ features: DialogManager, ErrorHandler, MobileMenuManager, ModelSelectorManager
- ✅ features: SiteManager, IntelligentResizeManager, UIStateManager, TabManager
- ✅ features: KeyboardShortcuts, HistoryDataService, ImageOperations
- ✅ main: updater.ts (多 provider, 重试机制)
- ✅ types: IpcChannelMap 完整类型安全

### app.js 剩余功能分析

```
功能区块                          行数估算    优先级    依赖
─────────────────────────────────────────────────────────
1. AIImageApp 初始化              ~150       P0       全局
2. I18n/语言管理                  ~200       P1       I18nService
3. 模型选择器初始化/管理           ~400       P1       ModelSelectorManager
4. 历史记录方法                   ~350       P2       HistoryDataService  
5. Toast/通知                     ~50        P3       已有 toast.ts
6. 详细错误显示                   ~600       P2       ErrorHandler
7. 智能尺寸模式                   ~200       P2       IntelligentResizeManager
8. Flux图片缓存                   ~100       P3       新模块
9. 站点管理函数                   ~150       P3       SiteManager
10. 网络受限对话框                ~200       P2       新模块
```

---

## 阶段一: 应用初始化重构

### 目标
将 `AIImageApp` 类拆分为更小、可测试的模块。

### 任务

#### 1.1 创建 AppBootstrap 模块
**文件**: `src/renderer/src/core/AppBootstrap.ts`

```typescript
// 参考 Context7 最佳实践: 单例模式
export class AppBootstrap {
  private static instance: AppBootstrap
  private initialized = false
  
  private constructor() {}
  
  static getInstance(): AppBootstrap {
    if (!AppBootstrap.instance) {
      AppBootstrap.instance = new AppBootstrap()
    }
    return AppBootstrap.instance
  }
  
  async init(): Promise<void> {
    if (this.initialized) return
    
    // 关键路径初始化
    await this.initCriticalPath()
    
    // 非关键路径延迟加载
    this.scheduleNonCriticalInit()
    
    this.initialized = true
    this.dispatchReady()
  }
  
  private async initCriticalPath(): Promise<void> { /* ... */ }
  private scheduleNonCriticalInit(): void { /* requestIdleCallback */ }
  private dispatchReady(): void { /* window.dispatchEvent */ }
}
```

**功能点**:
- 关键路径: I18n → Pages → Events → ModelSelector
- 非关键路径: FluxCache, R2Listener, History, VersionChecker
- 支持重试机制 (DOM 元素检测)

#### 1.2 创建 LanguageManager 模块
**文件**: `src/renderer/src/features/language/LanguageManager.ts`

```typescript
export class LanguageManager {
  constructor(private i18n: I18nService) {}
  
  async switchLanguage(lang: string): Promise<boolean>
  updateSEOForLanguage(lang: string): void
  updateModelSelectorsDisplayName(): void
  toggleLanguageDropdown(): void
  updateLanguageSwitcherDisplay(lang: string): void
}
```

**功能点**:
- 语言切换及持久化
- SEO meta 标签更新
- UI 元素国际化刷新
- 下拉菜单交互

---

## 阶段二: 模型选择器完善

### 目标
将剩余模型选择器代码迁移到 `ModelSelectorManager`。

### 任务

#### 2.1 完善 ModelSelectorManager
**更新**: `src/renderer/src/features/model-selector/ModelSelectorManager.ts`

**新增方法**:
```typescript
// 桌面端选择器初始化
initDesktopModelSelector(models: ModelConfig[], currentModelKey: string): void

// 移动端选择器初始化  
initMobileModelSelector(models: ModelConfig[], currentModelKey: string): void

// 切换模型
switchModel(modelName: string): void

// 更新 UI 状态
updateUIForModel(): void

// Seedream 计数提示
setupSeedreamCountHint(modelConfig: ModelConfig): void
```

#### 2.2 创建 RatioResolutionManager 模块
**文件**: `src/renderer/src/features/model-selector/RatioResolutionManager.ts`

```typescript
export class RatioResolutionManager {
  renderRatioOptions(modelConfig: ModelConfig): void
  renderResolutionOptions(modelConfig: ModelConfig): void
  renderBatchRatioOptions(modelConfig: ModelConfig): void
  updateBatchRatioTitle(selectElement: HTMLSelectElement): void
}
```

---

## 阶段三: 错误处理增强

### 目标
完善错误处理模块，提取剩余错误显示逻辑。

### 任务

#### 3.1 扩展 ErrorHandler
**更新**: `src/renderer/src/features/error-handler/ErrorHandler.ts`

**新增方法**:
```typescript
// 详细错误模态框
showDetailedError(error: Error, context?: string): void

// 网络受限对话框
showNetworkRestrictedDialog(
  inaccessibleUrls: string[],
  allUrls: string[],
  content: string,
  suggestions: string[]
): void

// 格式化错误用于复制
formatErrorForCopy(errorInfo: ErrorInfo): string
```

#### 3.2 创建 NetworkDiagnosticsModal 模块
**文件**: `src/renderer/src/features/error-handler/NetworkDiagnosticsModal.ts`

```typescript
export class NetworkDiagnosticsModal {
  show(diagnostics: NetworkDiagnostics): void
  hide(): void
  runDiagnostics(): Promise<NetworkDiagnostics>
}
```

---

## 阶段四: 缓存系统优化

### 目标
提取 Flux 图片缓存为独立模块。

### 任务

#### 4.1 创建 ImageCacheService 模块
**文件**: `src/renderer/src/services/cache/ImageCacheService.ts`

```typescript
export class ImageCacheService {
  private cache: Map<string, CachedImage>
  
  // 初始化缓存系统
  init(): void
  
  // 清理过期缓存
  cleanupExpired(): void
  
  // 获取缓存图片
  getCachedImage(originalUrl: string): string | null
  
  // 更新历史记录缓存映射
  updateHistoryWithCachedImages(
    originalUrls: string[], 
    cachedUrls: string[]
  ): void
  
  // 获取显示 URL (优先缓存)
  getDisplayUrl(originalUrl: string, cachedUrls?: string[]): string
}
```

---

## 阶段五: 测试覆盖率提升

### 目标
达到 80% 整体覆盖率。

### 任务

#### 5.1 新增单元测试

| 模块 | 文件 | 目标覆盖率 |
|------|------|-----------|
| AppBootstrap | `tests/core/AppBootstrap.test.ts` | 90% |
| LanguageManager | `tests/features/LanguageManager.test.ts` | 85% |
| RatioResolutionManager | `tests/features/RatioResolutionManager.test.ts` | 85% |
| NetworkDiagnosticsModal | `tests/features/NetworkDiagnosticsModal.test.ts` | 80% |
| ImageCacheService | `tests/services/ImageCacheService.test.ts` | 90% |

#### 5.2 更新覆盖率阈值
**更新**: `vitest.config.ts`

```typescript
coverage: {
  thresholds: {
    global: {
      lines: 80,
      functions: 80,
      branches: 70,
      statements: 80
    }
  }
}
```

---

## 阶段六: 可访问性 (a11y) 增强

### 目标
改善键盘导航和屏幕阅读器支持。

### 任务

#### 6.1 创建 AccessibilityManager 模块
**文件**: `src/renderer/src/features/accessibility/AccessibilityManager.ts`

```typescript
export class AccessibilityManager {
  // 焦点管理
  trapFocus(container: HTMLElement): void
  restoreFocus(): void
  
  // ARIA 状态更新
  updateAriaLive(message: string, priority?: 'polite' | 'assertive'): void
  
  // 键盘导航增强
  enableArrowNavigation(container: HTMLElement): void
  
  // 跳过链接
  setupSkipLinks(): void
}
```

#### 6.2 ARIA 属性增强
- 模态框: `role="dialog"`, `aria-modal="true"`, `aria-labelledby`
- 按钮: `aria-pressed`, `aria-expanded`
- 加载状态: `aria-busy`, `aria-live`
- 错误提示: `role="alert"`

---

## 技术参考 (Context7)

### Electron IPC 安全最佳实践
```javascript
// ✅ 推荐: 只暴露特定方法
contextBridge.exposeInMainWorld('myAPI', {
  loadPreferences: () => ipcRenderer.invoke('load-prefs')
})

// ❌ 避免: 暴露整个 ipcRenderer
contextBridge.exposeInMainWorld('electronAPI', {
  on: ipcRenderer.on  // 危险!
})
```

### Vitest Mock 最佳实践
```typescript
// 使用 vi.spyOn 监控方法调用
const spy = vi.spyOn(market, 'getApples')
market.getApples()
expect(spy).toHaveBeenCalledTimes(1)

// 清理 mock 状态
spy.mockClear()  // 清除调用历史
spy.mockRestore() // 恢复原始实现
```

### TypeScript 单例模式
```typescript
class Singleton {
  private static instance: Singleton
  private constructor() {}
  
  static getInstance(): Singleton {
    if (!Singleton.instance) {
      Singleton.instance = new Singleton()
    }
    return Singleton.instance
  }
}
```

### Vite 代码分割优化
```javascript
// 动态导入实现懒加载
const modules = import.meta.glob('./dir/*.js')

// manualChunks 优化 bundle
manualChunks: (id) => {
  if (id.includes('node_modules')) return 'vendor'
  if (id.includes('features/history')) return 'feature-history'
}
```

---

## 预期成果

### 代码质量
- [ ] app.js 减少到 ~3000 行
- [ ] 新增 5+ TypeScript 模块
- [ ] 测试覆盖率达到 80%

### 用户体验
- [ ] 可访问性评分提升 (Lighthouse a11y)
- [ ] 错误提示更友好
- [ ] 键盘导航完善

### 开发体验
- [ ] 模块化更清晰
- [ ] 类型安全更完整
- [ ] 测试更易编写

---

## 执行顺序

```mermaid
graph LR
    A[阶段一: 初始化重构] --> B[阶段二: 模型选择器]
    B --> C[阶段三: 错误处理]
    C --> D[阶段四: 缓存系统]
    D --> E[阶段五: 测试覆盖]
    E --> F[阶段六: 可访问性]
```

**建议顺序**: 1 → 2 → 3 → 4 → 5 → 6

每个阶段完成后更新文档和项目记忆。

---

## 相关文档
- `docs/plans/2026-01-30-project-upgrade-plan.md` - 主项目计划
- `docs/plans/2026-01-30-next-phase-upgrade-v3.md` - v3 计划 (已完成)
- `docs/code-signing.md` - 代码签名指南
- `.cursorrules` - 项目记忆
