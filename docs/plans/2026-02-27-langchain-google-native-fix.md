# LangChain Gemini 原生端点修复 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 LangChainDirectorService 从 `ChatOpenAI`（OpenAI 兼容端点）切换到 `ChatGoogle`（Gemini 原生端点），使 `withStructuredOutput` 的 Function Calling 在 API易 代理上正常工作。

**Architecture:** 使用 `@langchain/google` 的 `ChatGoogle` 类替代 `@langchain/openai` 的 `ChatOpenAI`。API易 的 Gemini 原生端点（`/v1beta/`）完整支持 Function Calling，而 OpenAI 兼容端点（`/v1/chat/completions`）对 Gemini 模型不支持。保留 `ChatOpenAI` 作为非 Gemini 模型的回退。

**Tech Stack:** TypeScript, `@langchain/google`, `@langchain/core`, Zod, Electron-Vite

---

### Task 1: 安装 `@langchain/google` 依赖

**Step 1: 安装包**

Run: `npm install @langchain/google`

Expected: 成功安装，package.json 和 package-lock.json 更新

**Step 2: 验证安装**

Run: `node -e "require.resolve('@langchain/google'); console.log('OK')"`

Expected: `OK`

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: install @langchain/google for Gemini native endpoint"
```

---

### Task 2: 更新 LangChainDirectorService 使用 ChatGoogle

**Files:**
- Modify: `src/renderer/src/services/LangChainDirectorService.ts`

**Step 1: 更新 import**

将：
```typescript
import { ChatOpenAI } from '@langchain/openai'
```
改为：
```typescript
import { ChatOpenAI } from '@langchain/openai'
import { ChatGoogle } from '@langchain/google'
```

**Step 2: 更新构造函数，根据模型名选择 LLM**

判断模型名是否包含 `gemini`，如果是则用 `ChatGoogle`（原生端点），否则用 `ChatOpenAI`。

```typescript
export class LangChainDirectorService {
  private llm: ChatOpenAI | ChatGoogle
  private structuredLlm: any

  constructor(config: { apiKey: string; baseURL: string; model?: string }) {
    const modelName = config.model || 'gpt-4o'
    const isGemini = modelName.toLowerCase().includes('gemini')

    if (isGemini) {
      // Gemini 模型：使用原生端点，支持 Function Calling
      this.llm = new ChatGoogle({
        model: modelName,
        apiKey: config.apiKey,
        baseUrl: config.baseURL.replace(/\/v1\/?$/, ''),
        maxRetries: 2,
        maxOutputTokens: 8192,
      })
    } else {
      // 非 Gemini 模型：使用 OpenAI 兼容端点
      this.llm = new ChatOpenAI({
        model: modelName,
        apiKey: config.apiKey,
        maxRetries: 2,
        maxTokens: 8192,
        configuration: { baseURL: `${config.baseURL.replace(/\/v1\/?$/, '')}/v1` }
      })
    }

    this.structuredLlm = this.llm.withStructuredOutput(SceneResponseSchema)
  }
```

**注意**: `ChatGoogle` 的 `baseUrl` 参数名是驼峰式（不是 `baseURL`），且不需要 `/v1` 后缀 — 它会自动使用 `/v1beta/` 端点。

**Step 3: 更新 analyzeImage 方法的类型**

`ChatGoogle` 和 `ChatOpenAI` 都有 `.invoke()` 方法，返回类型兼容。无需改动 `analyzeImage` 的逻辑。

**Step 4: 验证编译**

Run: `npm run build:vite 2>&1 | Select-Object -Last 5`

Expected: 构建成功

**Step 5: Commit**

```bash
git add src/renderer/src/services/LangChainDirectorService.ts
git commit -m "feat: use ChatGoogle for Gemini models to enable native Function Calling"
```

---

### Task 3: 更新测试

**Files:**
- Modify: `tests/services/LangChainDirectorService.test.ts`

**Step 1: 检查现有测试是否需要更新 mock**

测试中 mock 了 `ChatOpenAI`，如果构造时传入 Gemini 模型名，需要同时 mock `ChatGoogle`。

**Step 2: 添加测试用例验证模型自动选择**

```typescript
describe('model selection', () => {
  it('should use ChatGoogle for gemini models', () => {
    const service = new LangChainDirectorService({
      apiKey: 'test', baseURL: 'https://api.example.com', model: 'gemini-3-pro-preview'
    })
    // 验证实例类型
  })

  it('should use ChatOpenAI for non-gemini models', () => {
    const service = new LangChainDirectorService({
      apiKey: 'test', baseURL: 'https://api.example.com', model: 'gpt-4o'
    })
    // 验证实例类型
  })
})
```

**Step 3: 运行测试**

Run: `npx vitest run tests/services/LangChainDirectorService.test.ts`

Expected: 全部通过

**Step 4: Commit**

```bash
git add tests/services/LangChainDirectorService.test.ts
git commit -m "test: add model selection tests for ChatGoogle vs ChatOpenAI"
```

---

### Task 4: 构建 + 运行时验证

**Step 1: 全量构建**

Run: `npm run build:vite`

Expected: 构建成功

**Step 2: 运行时测试（手动）**

1. `npm run dev`
2. 打开导演模式，选择剧场版动画模板
3. 上传参考图，点击生成
4. 观察控制台：
   - `[ServiceBridge] ✓ LangChainDirectorService 实例已创建` → 确认实例化
   - `[DirectorPage] Using LangChain structured output...` → 确认走 LangChain 路径
   - `[DirectorPage] LangChain success: N shots` → **不再 503**

**Step 3: Commit（如有修复）**

```bash
git add -A
git commit -m "chore: langchain google native endpoint verification"
```

---

## 注意事项

1. **`ChatGoogle` 的 `baseUrl` 参数**：注意是小驼峰 `baseUrl`，不是 `baseURL`。需要查看 `@langchain/google` 的实际 API。
2. **`@langchain/google` 版本兼容性**：`package.json` 中是 `^0.1.2`，实际安装可能是更新版本。需确认 `ChatGoogle` 类的构造参数。
3. **图片内容格式**：`ChatGoogle` 的多模态消息格式可能与 `ChatOpenAI` 略有不同，需测试 `buildImageContent` 的兼容性。
4. **回退安全**：如果 `ChatGoogle` 构造失败，应 catch 并回退到 `ChatOpenAI`。
