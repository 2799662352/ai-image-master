# 完整迁移任务计划

> 创建时间: 2026-02-02
> 更新时间: 2026-02-02
> 状态: ✅ P0/P1 已完成
> 目标: 完成 Electron 应用从 JavaScript 到 TypeScript 的完整迁移

## 执行进度

### 2026-02-02 完成的任务

| 任务 ID | 任务描述 | 状态 |
|---------|---------|------|
| P0-1 | 完善 ApiService.generateImage - 构建完整请求/响应处理 | ✅ 完成 |
| P0-2 | 实现 Flux Kontext 请求处理 - FormData + extra_body | ✅ 完成 |
| P0-3 | 实现图像理解 Vision API | ✅ 完成 |
| P0-4 | 验证批量生成逻辑 | ✅ 完成 |
| P0-5 | 验证右上角按钮事件绑定 (data-action) | ✅ 完成 |
| P1-1 | 完善错误处理和重试机制 | ✅ 完成 |
| P1-2 | 实现 Flux 图片临时 URL 缓存 | ✅ 完成 |

### 主要代码变更

1. **ApiService.ts** (+150 行)
   - 添加 `buildGeminiNativePayload()` - Gemini 原生格式
   - 添加 `buildFluxPayload()` - Flux Kontext 格式
   - 添加 `buildOpenAIPayload()` - OpenAI 兼容格式
   - 添加 `makeFluxFormDataRequest()` - FormData 请求
   - 添加 `understandImage()` - 图像理解 API
   - 添加 `withRetry()` - 重试机制
   - 添加 `formatErrorMessage()` - 错误格式化

2. **ServiceBridge.ts** (+5 行)
   - 暴露 `understandImage` 到 window.aiImageAPI

3. **index.html** (+4 处修改)
   - activityBtn: `data-action="open-activity"`
   - settingsBtn: `data-action="open-settings"`
   - 移动端按钮同步更新

---

---

## 一、项目迁移状态总览

### 1.1 原始 JS 项目结构 (681 KB)

```
js/
├── api.js              # 3856 行 - API 服务核心
├── app.js              # 3506 行 - 应用主入口
├── components.js       # 363 行 - UI 组件
├── i18n.js             # 344 行 - 国际化
├── modules/
│   ├── batch-page.js       # 1562 行
│   ├── compare-page.js     # 998 行
│   ├── generate-page.js    # 1531 行
│   ├── history-page.js     # 693 行
│   ├── prompt-templates.js # 279 行
│   └── understand-page.js  # 987 行
└── services/
    ├── r2-storage.js
    └── version-checker.js
```

### 1.2 已迁移 TS 模块 (87 文件, 880 KB)

| 类别 | 模块 | 状态 | 备注 |
|-----|------|------|------|
| **页面** | GeneratePage.ts | ✅ 完成 | 1240 行 |
| **页面** | BatchPage.ts | ✅ 完成 | 1444 行 |
| **页面** | ComparePage.ts | ✅ 完成 | 959 行 |
| **页面** | HistoryPage.ts | ✅ 完成 | 826 行 |
| **页面** | DirectorPage.ts | ✅ 完成 | 1670 行 (新增) |
| **页面** | UnderstandPage.ts | ✅ 完成 | 1048 行 |
| **页面** | PromptTemplates.ts | ✅ 完成 | 422 行 |
| **核心** | AppBootstrap.ts | ⚠️ 部分 | 775 行 (app.js 22%) |
| **核心** | EventManager.ts | ✅ 完成 | 472 行 |
| **核心** | PageLoader.ts | ✅ 完成 | 动态加载 |
| **服务** | ApiService.ts | ⚠️ 部分 | 583 行 (api.js 15%) |
| **服务** | I18nService.ts | ✅ 完成 | 国际化 |
| **服务** | StorageBridge.ts | ✅ 完成 | 存储抽象 |
| **服务** | R2StorageService.ts | ✅ 完成 | R2 存储 |
| **服务** | PageStateManager.ts | ✅ 完成 | 状态管理 |
| **服务** | ServiceBridge.ts | ✅ 完成 | 服务桥接 |
| **功能** | TabManager.ts | ✅ 完成 | 标签切换 |
| **功能** | ModelSelectorManager.ts | ✅ 完成 | 模型选择 |
| **功能** | RatioResolutionManager.ts | ✅ 完成 | 比例分辨率 |
| **功能** | ToastManager.ts | ✅ 完成 | 提示消息 |
| **功能** | SiteManager.ts | ✅ 完成 | 站点管理 |
| **功能** | LanguageManager.ts | ✅ 完成 | 语言切换 |
| **功能** | ModalFactory.ts | ✅ 完成 | 模态框工厂 |
| **功能** | AccessibilityManager.ts | ✅ 完成 | 无障碍 |
| **功能** | ImageCacheService.ts | ✅ 完成 | 图片缓存 |
| **主进程** | src/main/index.ts | ✅ 完成 | 714 行 |
| **主进程** | src/main/updater.ts | ✅ 完成 | 自动更新 |
| **预加载** | src/preload/index.ts | ✅ 完成 | IPC 桥接 |

### 1.3 迁移差距分析

**api.js 剩余功能 (~85%)**:
```
功能区块                          行数估算    迁移状态
─────────────────────────────────────────────────────────
1. 模型配置 (models)              ~200       ⚠️ 已添加6个模型
2. 站点配置 (apiSites)            ~100       ✅ 已迁移
3. generateImage 核心             ~400       ⚠️ 部分迁移
4. buildRequestPayload           ~300       ⚠️ 需完善
5. parseResponse                 ~200       ⚠️ 需完善
6. 图片下载/缓存                  ~500       ⚠️ 部分迁移
7. 图片理解 (Vision API)          ~600       ❌ 未迁移
8. 历史记录管理                   ~400       ✅ 已迁移
9. 批量生成逻辑                   ~500       ⚠️ 需验证
10. Flux Kontext 特殊处理         ~300       ❌ 未迁移
11. 错误处理/重试机制             ~200       ⚠️ 需完善
12. 网络诊断                      ~150       ✅ 已迁移
```

**app.js 剩余功能 (~78%)**:
```
功能区块                          行数估算    迁移状态
─────────────────────────────────────────────────────────
1. AIImageApp 初始化              ~150       ⚠️ AppBootstrap
2. I18n/语言切换                  ~200       ✅ 已迁移
3. 模型选择器初始化               ~400       ✅ 已迁移
4. 历史记录 UI                    ~350       ✅ 已迁移
5. Toast/通知                     ~50        ✅ 已迁移
6. 详细错误显示                   ~600       ⚠️ 部分迁移
7. 智能尺寸模式                   ~200       ✅ 已迁移
8. Flux 图片缓存                  ~100       ⚠️ 需完善
9. 站点管理 UI                    ~150       ✅ 已迁移
10. 网络受限对话框                ~200       ✅ 已迁移
11. SEO/Meta 更新                 ~100       ⚠️ 需验证
12. 移动端适配                    ~300       ✅ 已迁移
13. 键盘快捷键                    ~150       ✅ 已迁移
```

---

## 二、迁移任务优先级

### P0 - 关键功能 (阻塞使用)

| 任务 ID | 任务描述 | 预估工作量 | 依赖 |
|---------|---------|-----------|------|
| P0-1 | 完善 ApiService.generateImage | 2h | - |
| P0-2 | 实现 Flux Kontext 请求处理 | 1.5h | P0-1 |
| P0-3 | 实现图像理解 Vision API | 2h | P0-1 |
| P0-4 | 完善批量生成逻辑 | 1.5h | P0-1 |
| P0-5 | 修复右上角按钮事件绑定 | 0.5h | - |

### P1 - 重要功能 (影响体验)

| 任务 ID | 任务描述 | 预估工作量 | 依赖 |
|---------|---------|-----------|------|
| P1-1 | 完善错误处理和重试机制 | 1h | P0-1 |
| P1-2 | 实现 Flux 图片临时 URL 缓存 | 1h | P0-2 |
| P1-3 | 完善 SEO/Meta 更新逻辑 | 0.5h | - |
| P1-4 | 验证所有模型的请求/响应处理 | 2h | P0-1 |
| P1-5 | 完善图片下载功能 | 1h | - |

### P2 - 增强功能 (提升质量)

| 任务 ID | 任务描述 | 预估工作量 | 依赖 |
|---------|---------|-----------|------|
| P2-1 | 增加单元测试覆盖率到 80% | 4h | - |
| P2-2 | 完善类型定义和接口 | 2h | - |
| P2-3 | 代码审查和重构 | 2h | P2-2 |
| P2-4 | 性能优化和打包优化 | 1.5h | - |
| P2-5 | 文档更新 | 1h | - |

---

## 三、详细迁移任务

### 阶段 1: ApiService 核心功能完善 (P0-1 ~ P0-4)

#### 3.1.1 完善 generateImage 方法

**当前状态**: ApiService.ts 只有基础结构，缺少完整的请求构建和响应解析。

**需要迁移的功能**:

```typescript
// 从 api.js 迁移以下方法:

// 1. buildRequestPayload - 构建不同 API 类型的请求体
buildRequestPayload(options: GenerateOptions): RequestPayload {
  const { prompt, model, ratio, referenceImages, modelConfig } = options
  
  switch (modelConfig.apiType) {
    case 'gemini-native':
      return this.buildGeminiPayload(options)
    case 'flux':
    case 'flux-kontext':
      return this.buildFluxPayload(options)
    case 'openai':
    case 'image-generation':
      return this.buildOpenAIPayload(options)
    default:
      return this.buildChatCompletionsPayload(options)
  }
}

// 2. parseResponse - 解析不同 API 类型的响应
parseResponse(response: any, modelConfig: ModelConfig): GenerateResult {
  // 根据 apiType 解析不同格式的响应
}

// 3. handleRetry - 错误重试机制
async handleRetry<T>(
  fn: () => Promise<T>, 
  maxRetries: number = 3
): Promise<T>
```

**技术参考** (Context7 最佳实践):
- Electron IPC: 使用 `contextBridge.exposeInMainWorld` 安全暴露 API
- 避免直接暴露 `ipcRenderer.on`，应包装回调

#### 3.1.2 实现 Flux Kontext 特殊处理

**需要迁移的逻辑**:
```typescript
// Flux Kontext 模型特殊处理
- extra_body 参数展开
- aspect_ratio 参数转换
- 安全级别 (safety_tolerance) 配置
- 临时 URL (10分钟失效) 缓存逻辑
```

#### 3.1.3 实现图像理解 Vision API

**需要迁移的方法**:
```typescript
// 从 api.js 迁移:
async understandImage(options: VisionOptions): Promise<VisionResult> {
  // 支持 URL 和 Base64 输入
  // 支持角色/提示词组合
  // 支持多图对比
}
```

### 阶段 2: UI 事件绑定修复 (P0-5)

#### 3.2.1 右上角按钮事件修复

**问题**: `activityBtn`, `settingsBtn`, `languageSwitcher` 事件未正确绑定。

**解决方案**:
1. 在 `index.html` 中添加 `data-action` 属性
2. 在 `EventManager.ts` 中注册对应处理器

**已完成的修改**:
- ✅ activityBtn: `data-action="open-activity"`
- ✅ settingsBtn: `data-action="open-settings"`
- ⚠️ languageSwitcher: 需验证 `data-action="toggle-language"`

### 阶段 3: 错误处理和重试机制 (P1-1)

#### 3.3.1 完善错误处理

**需要实现**:
```typescript
interface ApiError {
  code: string
  message: string
  retryable: boolean
  context?: Record<string, any>
}

class ApiErrorHandler {
  // 分类错误类型
  categorizeError(error: Error): ApiError
  
  // 显示用户友好的错误信息
  showUserFriendlyError(error: ApiError): void
  
  // 网络诊断
  runNetworkDiagnostics(): Promise<DiagnosticsResult>
}
```

### 阶段 4: 测试覆盖率提升 (P2-1)

**当前覆盖率**: ~55%
**目标覆盖率**: 80%

**需要新增的测试**:
| 模块 | 文件 | 目标覆盖率 |
|------|------|-----------|
| ApiService | `tests/services/ApiService.test.ts` | 85% |
| GeneratePage | `tests/pages/GeneratePage.test.ts` | 80% |
| BatchPage | `tests/pages/BatchPage.test.ts` | 80% |
| DirectorPage | `tests/pages/DirectorPage.test.ts` | 75% |
| EventManager | `tests/core/EventManager.test.ts` | 90% |

---

## 四、技术规范 (Context7 最佳实践)

### 4.1 Electron IPC 安全模式

```typescript
// ✅ 推荐: 只暴露特定方法
contextBridge.exposeInMainWorld('myAPI', {
  loadPreferences: () => ipcRenderer.invoke('load-prefs')
})

// ❌ 避免: 暴露整个 ipcRenderer
contextBridge.exposeInMainWorld('electronAPI', {
  on: ipcRenderer.on  // 危险!
})

// ✅ 正确的事件监听暴露
contextBridge.exposeInMainWorld('electronAPI', {
  onUpdateCounter: (callback) => 
    ipcRenderer.on('update-counter', (_event, value) => callback(value))
})
```

### 4.2 electron-vite 资源处理

```typescript
// electron.vite.config.ts
export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        output: {
          manualChunks(id): string | void {
            if (id.includes('node_modules')) return 'vendor'
            if (id.includes('features/history')) return 'feature-history'
          }
        }
      }
    }
  },
  renderer: {
    publicDir: 'src/renderer/public'  // 静态资源目录
  }
})
```

### 4.3 TypeScript 单例模式

```typescript
class ServiceManager {
  private static instance: ServiceManager
  private constructor() {}
  
  static getInstance(): ServiceManager {
    if (!ServiceManager.instance) {
      ServiceManager.instance = new ServiceManager()
    }
    return ServiceManager.instance
  }
}
```

---

## 五、执行顺序

```
Week 1: P0 关键功能
├── Day 1-2: ApiService.generateImage 完善
├── Day 2-3: Flux Kontext 处理
├── Day 3-4: Vision API 实现
└── Day 4-5: 批量生成 + UI 事件修复

Week 2: P1 重要功能 + P2 增强
├── Day 1-2: 错误处理 + 重试机制
├── Day 2-3: Flux 缓存 + 图片下载
├── Day 3-4: 测试覆盖率提升
└── Day 4-5: 代码审查 + 文档
```

---

## 六、验收标准

### 功能验收
- [ ] 所有 6 个模型可正常生成图片
- [ ] 批量生成功能正常工作
- [ ] 图像理解功能正常工作
- [ ] 右上角按钮 (活动、设置、语言) 可点击
- [ ] 标签切换 (批量、历史、对比等) 正常
- [ ] 错误提示友好且有重试选项

### 质量验收
- [ ] TypeScript 编译无错误
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] E2E 测试通过
- [ ] 构建产物可正常运行
- [ ] 无控制台错误

### 性能验收
- [ ] 首屏加载 < 3s
- [ ] 图片生成响应流畅
- [ ] 内存占用稳定

---

## 七、风险和缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| API 兼容性问题 | 高 | 保留原始 JS 代码作为参考 |
| 测试覆盖不足 | 中 | 优先覆盖核心路径 |
| 构建配置复杂 | 中 | 使用 electron-vite 标准配置 |
| 类型定义遗漏 | 低 | 渐进式添加类型 |

---

## 八、相关文档

- `docs/plans/2026-01-30-next-phase-upgrade-v5.md` - 前序计划
- `docs/plans/2026-01-27-electron-builder-packaging.md` - 打包配置
- `25/soraui_4.0/apiyi-p/js/api.js` - 原始 API 实现参考
- `25/soraui_4.0/apiyi-p/js/app.js` - 原始应用入口参考
