# 测试修复 Phase 2 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复 AI Image Master 项目剩余的 18 个测试失败，达到 100% 测试通过率

**Architecture:** 按问题类型分类修复：DOM环境问题、事件回调问题、第三方库mock问题、模块初始化问题。优先修复影响范围广的底层问题，再处理特定测试用例。

**Tech Stack:** Vitest, JSDOM, vi.stubGlobal, vi.fn, vi.spyOn, TypeScript

---

## 失败测试分析

| 类别 | 测试文件 | 失败数 | 根因 |
|-----|---------|-------|-----|
| DOM环境 | ImageOperations.test.ts | 4 | `document.addEventListener is not a function`, Image 构造器 mock |
| 事件回调 | ImageCacheService.test.ts | 2 | 事件监听器回调未触发 |
| 事件回调 | NetworkDiagnosticsModal.test.ts | 1 | 事件监听注册问题 |
| 第三方库 | ModelSelectorManager.test.ts | 4 | Choices.js 初始化 mock 不完整 |
| 元素交互 | KeyboardShortcuts.test.ts | 3 | activeElement 和 paste 事件处理 |
| 元素交互 | IntelligentResizeManager.test.ts | 3 | ratio button 样式和 batch 配置 |
| 模块初始化 | AppBootstrap.test.ts | 1+ | 模块加载顺序 |

---

## Phase 2A: DOM 环境修复 (优先级: 高)

### Task 1: 修复 ImageOperations 测试环境

**文件:**
- 修改: `tests/features/ImageOperations.test.ts`
- 参考: `src/renderer/src/features/image-operations/ImageOperations.ts`

**问题分析:**
1. `document.addEventListener is not a function` - JSDOM 环境未正确初始化
2. `() => mockImage is not a constructor` - Image 类 mock 方式错误

**Step 1: 检查当前测试文件设置**

```bash
npm run test:run -- tests/features/ImageOperations.test.ts --reporter=verbose 2>&1 | Select-String -Pattern "Error|FAIL" | Select-Object -First 10
```

预期: 看到具体错误位置

**Step 2: 添加 JSDOM 环境注释和 Image 类 mock**

在测试文件顶部添加:
```typescript
/**
 * @vitest-environment jsdom
 */
```

修复 Image mock (使用类而非函数):
```typescript
class MockImage {
  src: string = ''
  onload: (() => void) | null = null
  onerror: ((error: Error) => void) | null = null
  width: number = 800
  height: number = 600
  
  constructor() {
    setTimeout(() => this.onload?.(), 0)
  }
}

vi.stubGlobal('Image', MockImage)
```

**Step 3: 修复 document.addEventListener mock**

在 beforeEach 中添加:
```typescript
// 确保 document 方法可用
if (!document.addEventListener) {
  document.addEventListener = vi.fn()
  document.removeEventListener = vi.fn()
}
```

**Step 4: 运行测试验证**

```bash
npm run test:run -- tests/features/ImageOperations.test.ts
```

预期: 4 个相关测试通过

**Step 5: 提交**

```bash
git add tests/features/ImageOperations.test.ts
git commit -m "fix(tests): repair ImageOperations JSDOM environment

- Add @vitest-environment jsdom annotation
- Fix Image class mock to use proper class syntax
- Ensure document event methods are available"
```

---

### Task 2: 修复 ImageCacheService 事件回调测试

**文件:**
- 修改: `tests/services/ImageCacheService.test.ts`
- 参考: `src/renderer/src/services/ImageCacheService.ts`

**问题分析:**
- `expected "vi.fn()" to be called at least once` - 事件回调未触发
- 可能是事件触发时机或事件名不匹配

**Step 1: 检查实现中的事件名称**

```bash
grep -n "fluxImagesCached\|dispatchEvent\|addEventListener" src/renderer/src/services/ImageCacheService.ts
```

**Step 2: 确保测试中事件触发与实现一致**

在测试中手动触发事件并验证回调:
```typescript
it('监听 fluxImagesCached 事件', () => {
  const callback = vi.fn()
  
  // 直接调用服务的事件注册方法
  service.onCacheUpdate(callback)
  
  // 模拟缓存更新
  service.updateCache(mockImages)
  
  expect(callback).toHaveBeenCalled()
})
```

**Step 3: 运行测试验证**

```bash
npm run test:run -- tests/services/ImageCacheService.test.ts
```

**Step 4: 提交**

```bash
git add tests/services/ImageCacheService.test.ts
git commit -m "fix(tests): repair ImageCacheService callback tests"
```

---

## Phase 2B: 第三方库 Mock 修复 (优先级: 中)

### Task 3: 修复 ModelSelectorManager Choices.js Mock

**文件:**
- 修改: `tests/features/ModelSelectorManager.test.ts`
- 参考: `src/renderer/src/features/model-selector/ModelSelectorManager.ts`

**问题分析:**
- Choices.js 库的 mock 不完整
- init 方法期望 Choices 实例的特定行为

**Step 1: 创建完整的 Choices.js mock**

```typescript
class MockChoices {
  constructor(element: HTMLElement, options?: any) {
    this.element = element
    this.options = options
  }
  
  element: HTMLElement
  options: any
  passedElement: { element: HTMLElement } = { element: document.createElement('select') }
  
  setChoices = vi.fn()
  clearChoices = vi.fn()
  setChoiceByValue = vi.fn()
  getValue = vi.fn(() => ({ value: 'test' }))
  destroy = vi.fn()
  init = vi.fn()
  
  static get instances() {
    return []
  }
}

vi.stubGlobal('Choices', MockChoices)
```

**Step 2: 在 beforeEach 中确保 Choices 可用**

```typescript
beforeEach(() => {
  (window as any).Choices = MockChoices
  vi.clearAllMocks()
})
```

**Step 3: 运行测试验证**

```bash
npm run test:run -- tests/features/ModelSelectorManager.test.ts
```

**Step 4: 提交**

```bash
git add tests/features/ModelSelectorManager.test.ts
git commit -m "fix(tests): complete Choices.js mock for ModelSelectorManager"
```

---

### Task 4: 修复 KeyboardShortcuts 测试

**文件:**
- 修改: `tests/features/KeyboardShortcuts.test.ts`

**问题分析:**
- `activeElement` 检测问题
- paste 事件在 textarea/input 中的处理

**Step 1: Mock document.activeElement**

```typescript
Object.defineProperty(document, 'activeElement', {
  get: vi.fn(() => mockActiveElement),
  configurable: true
})
```

**Step 2: 创建正确的 paste 事件**

```typescript
const createPasteEvent = (target: HTMLElement) => {
  const event = new ClipboardEvent('paste', {
    bubbles: true,
    cancelable: true,
    clipboardData: new DataTransfer()
  })
  Object.defineProperty(event, 'target', { value: target })
  return event
}
```

**Step 3: 运行测试验证**

```bash
npm run test:run -- tests/features/KeyboardShortcuts.test.ts
```

**Step 4: 提交**

```bash
git add tests/features/KeyboardShortcuts.test.ts
git commit -m "fix(tests): repair KeyboardShortcuts activeElement and paste tests"
```

---

## Phase 2C: 其他测试修复 (优先级: 低)

### Task 5: 修复 IntelligentResizeManager 测试

**文件:**
- 修改: `tests/features/IntelligentResizeManager.test.ts`

**Step 1: 检查 ratio button 样式期望**

```bash
npm run test:run -- tests/features/IntelligentResizeManager.test.ts --reporter=verbose 2>&1 | Select-String -Pattern "Received|Expected" | Select-Object -First 10
```

**Step 2: 对齐测试期望与实现**

根据实现调整测试断言或修复实现逻辑。

**Step 3: 运行测试验证并提交**

---

### Task 6: 修复 MobileMenuManager 测试

**文件:**
- 修改: `tests/features/MobileMenuManager.test.ts`

**问题:** resize handler 未正确关闭菜单

**Step 1: Mock window.innerWidth**

```typescript
vi.stubGlobal('innerWidth', 1200) // 超过 breakpoint
```

**Step 2: 触发 resize 事件**

```typescript
window.dispatchEvent(new Event('resize'))
```

---

### Task 7: 修复 NetworkDiagnosticsModal 测试

**文件:**
- 修改: `tests/features/NetworkDiagnosticsModal.test.ts`

**问题:** `networkRestrictedImages` 事件监听未正确注册

**Step 1: 确保事件名称匹配实现**

**Step 2: 使用 dispatchEvent 触发自定义事件**

```typescript
document.dispatchEvent(new CustomEvent('networkRestrictedImages', { detail: mockData }))
```

---

### Task 8: 修复 HistoryManager/HistoryDataService 测试

**文件:**
- 修改: `tests/features/HistoryManager.test.ts`
- 修改: `tests/features/HistoryDataService.test.ts`

**问题:** 模块初始化和依赖 mock

---

### Task 9: 修复 AppBootstrap 测试

**文件:**
- 修改: `tests/core/AppBootstrap.test.ts`

**问题:** 核心模块加载顺序和依赖

---

### Task 10: 修复 updater 测试

**文件:**
- 修改: `tests/main/updater.test.ts`

**问题:** Electron main 进程测试环境

---

## 验证清单

完成所有任务后运行:

```bash
npm run test:run
```

预期结果:
- Test Files: 38 passed (38)
- Tests: 653 passed (653)
- 0 failures

## 参考资料

### Vitest 最佳实践 (来自 context7)

1. **vi.stubGlobal** - 用于 mock 全局变量如 `window.alert`, `Image`, `innerWidth`
2. **@vitest-environment jsdom** - 文件级别指定 JSDOM 环境
3. **vi.fn()** - 创建可追踪调用的 mock 函数
4. **vi.spyOn()** - 监视对象方法调用

### 常见陷阱

1. `mockReturnValueOnce` 只作用一次，循环中需用 `mockReturnValue`
2. JSDOM 的 `style.cssText` 可能不正确解析，需显式设置关键样式
3. 事件监听需在正确时机注册，使用 `vi.stubGlobal` 而非直接赋值
