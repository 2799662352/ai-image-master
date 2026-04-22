# gpt-image-2-all Images API 端点 + UI 适配 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 gpt-image-2-all 模型从不稳定的 Chat Completions 端点切换到 Images API 端点，并在所有页面做模型感知 UI 适配。

**Architecture:** ApiService 中新增 gpt-image-2-all 专用请求分支：无参考图走 `/v1/images/generations`（JSON），有参考图走 `/v1/images/edits`（multipart FormData）。UI 层通过读取 `modelConfig.sizeStrategy` 和 `capabilities` 来条件渲染/隐藏尺寸、分辨率、数量等控件。

**Tech Stack:** React, TypeScript, Zustand, Electron, Fetch API, FormData

---

## 文件变更地图

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/renderer/src/services/api/ApiService.ts` | 修改 | 模型配置 baseURL 变更 + buildRequestUrl 扩展 + 新增 gpt-image-2-all 专用请求方法 + makeApiRequest 路由 |
| `src/renderer/src/pages-react/GeneratePage.tsx` | 修改 | 模型感知 UI：隐藏/替换 RatioSelector，显示提示文案 |
| `src/renderer/src/pages-react/generate/RatioSelector.tsx` | 修改 | 新增 disabled/hidden 模式 prop |
| `src/renderer/src/pages-react/BatchPage.tsx` | 修改 | 模型感知 UI：PunkConfigGrid 条件渲染 |
| `src/renderer/src/pages-react/batch-punk/PunkConfigGrid.tsx` | 修改 | 新增 hidden prop 支持整个 ratio/resolution 区块隐藏 |
| `src/renderer/src/pages-react/ComparePage.tsx` | 修改 | 当选中 gpt-image-2-all 时显示提示 |

---

### Task 1: 变更模型配置 baseURL

**Files:**
- Modify: `src/renderer/src/services/api/ApiService.ts:338-356`

- [ ] **Step 1: 修改 gpt-image-2-all 的 baseURL**

将 `baseURL` 从 chat completions 改为 images/generations：

```typescript
// 找到 'gpt-image-2-all' 配置块（约 line 338-356）
// 旧值:
//   baseURL: 'https://b.apiyi.com/v1/chat/completions',
// 新值:
'gpt-image-2-all': {
  name: 'GPT Image 2 All',
  displayName: '30s，GPT图像生成，文生图/图片编辑/多图融合，文字还原度高，中文友好，$0.03/张🔥',
  price: 0.03,
  time: '30s',
  isNew: true,
  baseURL: 'https://b.apiyi.com/v1/images/generations',
  editURL: 'https://b.apiyi.com/v1/images/edits',
  apiType: 'openai',
  sizeStrategy: 'prompt',
  capabilities: {
    multipleImages: false,
    customSize: false,
    aspectRatioControl: false,
    referenceImage: true,
    imageEdit: true,
    maxOutputs: 1
  }
},
```

仅改动一行：`baseURL` 的值从 `.../v1/chat/completions` → `.../v1/images/generations`。其余保持不变。

- [ ] **Step 2: 验证 TypeScript 编译通过**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: 无新错误

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/services/api/ApiService.ts
git commit -m "refactor: switch gpt-image-2-all baseURL to /v1/images/generations"
```

---

### Task 2: 扩展 buildRequestUrl 支持 editURL

**Files:**
- Modify: `src/renderer/src/services/api/ApiService.ts:862-882`

- [ ] **Step 1: 给 buildRequestUrl 增加 urlType 参数**

当前签名：
```typescript
private buildRequestUrl(modelConfig: ModelConfig, site: ApiSite): string
```

改为：
```typescript
private buildRequestUrl(modelConfig: ModelConfig, site: ApiSite, urlType?: 'base' | 'edit'): string {
  const sourceUrl = (urlType === 'edit' && modelConfig.editURL)
    ? modelConfig.editURL
    : modelConfig.baseURL

  if (!sourceUrl) {
    return `${site.baseURL}/v1/chat/completions`
  }

  try {
    const modelUrl = new URL(sourceUrl)
    const siteUrl = new URL(site.baseURL)
    modelUrl.protocol = siteUrl.protocol
    modelUrl.host = siteUrl.host
    return modelUrl.toString()
  } catch {
    return sourceUrl
  }
}
```

这是一个向后兼容的改动 — 不传第三个参数时行为不变。

- [ ] **Step 2: 验证 TypeScript 编译通过**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: 无新错误

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/services/api/ApiService.ts
git commit -m "refactor: extend buildRequestUrl to support editURL via urlType param"
```

---

### Task 3: 新增 gpt-image-2-all 专用请求方法

**Files:**
- Modify: `src/renderer/src/services/api/ApiService.ts` (在 `makeFluxFormDataRequest` 方法后面，约 line 984 之后插入)

- [ ] **Step 1: 添加 buildGptImage2AllJsonPayload 方法**

在 `convertToBlob` 方法之前（约 line 986），插入：

```typescript
  /**
   * gpt-image-2-all 文生图 JSON payload（无参考图）
   */
  private buildGptImage2AllJsonPayload(prompt: string): object {
    return {
      model: 'gpt-image-2-all',
      prompt,
      response_format: 'b64_json'
    }
  }
```

- [ ] **Step 2: 添加 makeGptImage2AllFormDataRequest 方法**

紧接着插入：

```typescript
  /**
   * gpt-image-2-all 图片编辑 FormData 请求（有参考图）
   */
  private async makeGptImage2AllFormDataRequest(
    url: string,
    prompt: string,
    imageSources: string[],
    site: ApiSite,
    signal?: AbortSignal,
  ): Promise<Response> {
    const formData = new FormData()
    formData.append('model', 'gpt-image-2-all')
    formData.append('prompt', prompt)
    formData.append('response_format', 'b64_json')

    for (let i = 0; i < imageSources.length; i++) {
      const blob = await this.convertToBlob(imageSources[i])
      if (blob) {
        formData.append('image[]', blob, `image${i}.png`)
      }
    }

    const headers: Record<string, string> = {}
    if (site.authType === 'bearer') {
      headers['Authorization'] = `Bearer ${this.apiKey}`
    } else {
      headers['x-api-key'] = this.apiKey!
    }

    return fetch(url, {
      method: 'POST',
      headers,
      body: formData,
      signal,
    })
  }
```

- [ ] **Step 3: 验证 TypeScript 编译通过**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: 无新错误

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/services/api/ApiService.ts
git commit -m "feat: add gpt-image-2-all dedicated JSON and FormData request methods"
```

---

### Task 4: 在 makeApiRequest 中添加 gpt-image-2-all 请求路由

**Files:**
- Modify: `src/renderer/src/services/api/ApiService.ts:887-935` (makeApiRequest 方法)

- [ ] **Step 1: 在 makeApiRequest 中插入 gpt-image-2-all 分支**

在 `makeApiRequest` 方法中，`const url = this.buildRequestUrl(modelConfig, site)` 这行之前（约 line 902），插入 gpt-image-2-all 的早期返回：

```typescript
  private async makeApiRequest(options: {
    prompt: string
    model: string
    ratio?: string
    resolution?: string
    referenceImages?: string[]
    imageBase64?: string
    count: number
    modelConfig: ModelConfig
    site: ApiSite
    signal?: AbortSignal
  }): Promise<Response> {
    const { prompt, model, ratio, resolution, referenceImages, imageBase64, modelConfig, site, signal } = options

    // gpt-image-2-all: 专用 Images API 路径
    if (model === 'gpt-image-2-all') {
      const imageSources = imageBase64 ? [imageBase64] : (referenceImages || [])
      const hasImages = imageSources.length > 0

      if (hasImages) {
        const url = this.buildRequestUrl(modelConfig, site, 'edit')
        return this.makeGptImage2AllFormDataRequest(url, prompt, imageSources, site, signal)
      } else {
        const url = this.buildRequestUrl(modelConfig, site)
        const body = this.buildGptImage2AllJsonPayload(prompt)
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (site.authType === 'bearer') {
          headers['Authorization'] = `Bearer ${this.apiKey}`
        } else {
          headers['x-api-key'] = this.apiKey!
        }
        return fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal,
        })
      }
    }

    // 构建请求 URL：用站点的域名替换模型 URL 中的域名
    const url = this.buildRequestUrl(modelConfig, site)
    // ... 后续原有逻辑不变 ...
```

关键：整个 `if (model === 'gpt-image-2-all')` 块在已有的 `const url = this.buildRequestUrl(...)` 之前插入，作为早期返回，不影响其他模型的任何逻辑。

- [ ] **Step 2: 验证 TypeScript 编译通过**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: 无新错误

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/services/api/ApiService.ts
git commit -m "feat: route gpt-image-2-all to Images API endpoints"
```

---

### Task 5: 添加 getModelConfig 公开方法

**Files:**
- Modify: `src/renderer/src/services/api/ApiService.ts` (在 `getCurrentModel` 方法附近，约 line 1425-1427)

- [ ] **Step 1: 添加 getModelConfig 静态方法**

在 `getCurrentModel()` 方法后面插入：

```typescript
  /**
   * 按 key 获取模型配置（UI 层用于读取 capabilities）
   */
  getModelConfig(key: string): ModelConfig | undefined {
    return this.models[key]
  }
```

- [ ] **Step 2: 验证 TypeScript 编译通过**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: 无新错误

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/services/api/ApiService.ts
git commit -m "feat: expose getModelConfig for UI model-awareness"
```

---

### Task 6: 生成页 UI 适配 — RatioSelector

**Files:**
- Modify: `src/renderer/src/pages-react/generate/RatioSelector.tsx`
- Modify: `src/renderer/src/pages-react/GeneratePage.tsx`

- [ ] **Step 1: 给 RatioSelector 添加 hidden 模式**

将 `RatioSelector.tsx` 改为：

```typescript
const RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']

interface RatioSelectorProps {
  value: string
  onChange: (ratio: string) => void
  hidden?: boolean
}

export function RatioSelector({ value, onChange, hidden }: RatioSelectorProps) {
  if (hidden) {
    return (
      <div className="px-4 py-3 bg-zinc-800/60 border-2 border-zinc-700 text-sm text-zinc-400">
        <span className="text-cyberpunk-yellow font-bold">⚡ 尺寸自适应</span>
        <span className="ml-2">该模型无需选择尺寸。如需指定，请在提示词中描述，例如：</span>
        <span className="text-zinc-300">"横版 16:9 电影画幅"、"竖版 9:16 手机海报"、"1024×1024 方图"</span>
      </div>
    )
  }

  return (
    <div className="flex flex-wrap gap-2">
      {RATIOS.map((r) => (
        <button
          key={r}
          onClick={() => onChange(r)}
          className={`px-3 py-1.5 text-sm border-2 transition-colors ${
            value === r
              ? 'border-cyberpunk-yellow bg-cyberpunk-yellow/10 text-cyberpunk-yellow'
              : 'border-zinc-700 text-zinc-400 hover:border-zinc-500'
          }`}
        >
          {r}
        </button>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: 在 GeneratePage 中传递 hidden prop**

在 `GeneratePage.tsx` 中，`const currentModel = models[currentModelKey]` 后面加入模型感知变量：

```typescript
  const currentModel = models[currentModelKey]

  const isSizeInPrompt = currentModel?.capabilities?.sizeStrategy === 'prompt'
    || (currentModel as any)?.sizeStrategy === 'prompt'
```

注意：`useModelStore` 的 `models` 存的是 `ModelInfo`（name + capabilities + ...），`sizeStrategy` 可能在顶层也可能在 capabilities 里。这里取决于 `window.aiImageAPI.getAllModels()` 返回的结构。我们同时检查两处以确保兼容。

然后修改 `<RatioSelector>` 调用：

```typescript
      <RatioSelector value={ratio} onChange={setRatio} hidden={isSizeInPrompt} />
```

- [ ] **Step 3: 验证 TypeScript 编译通过**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: 无新错误

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/pages-react/generate/RatioSelector.tsx src/renderer/src/pages-react/GeneratePage.tsx
git commit -m "feat: hide ratio selector for size-in-prompt models on GeneratePage"
```

---

### Task 7: 批量页 UI 适配 — PunkConfigGrid

**Files:**
- Modify: `src/renderer/src/pages-react/batch-punk/PunkConfigGrid.tsx`
- Modify: `src/renderer/src/pages-react/BatchPage.tsx`

- [ ] **Step 1: 给 PunkConfigGrid 添加 sizeHidden prop**

在 `PunkConfigGrid.tsx` 的 `Props` 接口中添加：

```typescript
interface Props {
  ratio: string
  resolution: string
  concurrency: number
  ratioOptions: RatioOption[]
  resolutionOptions: ResolutionOption[]
  supportsResolution: boolean
  onRatioChange: (s: string) => void
  onResolutionChange: (s: string) => void
  onConcurrencyChange: (n: number) => void
  sizeHidden?: boolean
}
```

然后在组件函数中接收 `sizeHidden` 并条件渲染：

```typescript
export default function PunkConfigGrid({
  ratio,
  resolution,
  concurrency,
  ratioOptions,
  resolutionOptions,
  supportsResolution,
  onRatioChange,
  onResolutionChange,
  onConcurrencyChange,
  sizeHidden,
}: Props) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: 14,
        marginBottom: 20,
      }}
    >
      {/* RATIO — 尺寸自适应模型时替换为提示 */}
      {sizeHidden ? (
        <div
          className="p-sticker"
          style={{ background: 'var(--punk-cream)', padding: '0.8rem 1rem', gridColumn: 'span 2' }}
        >
          <div className="p-display" style={{ fontSize: 12, marginBottom: 6, opacity: 0.85 }}>
            // SIZE 尺寸
          </div>
          <div className="p-mono" style={{ fontSize: 11, fontWeight: 700, opacity: 0.75 }}>
            ⚡ 该模型尺寸自适应，如需指定请在提示词中描述（如"横版16:9"）
          </div>
        </div>
      ) : (
        <>
          {/* RATIO */}
          <div
            className="p-sticker"
            style={{ background: 'var(--punk-cream)', padding: '0.8rem 1rem' }}
          >
            <div className="p-display" style={{ fontSize: 12, marginBottom: 6, opacity: 0.85 }}>
              // RATIO 比例
            </div>
            <select
              value={ratio}
              onChange={(e) => onRatioChange(e.target.value)}
              className="p-select"
              aria-label="尺寸比例"
            >
              {ratioOptions.map((r) => (
                <option key={r.key} value={r.key}>{formatOption(r)}</option>
              ))}
            </select>
          </div>

          {/* RESOLUTION */}
          <div
            className="p-sticker p-tilt-r-2"
            style={{ background: 'var(--punk-cream)', padding: '0.8rem 1rem' }}
          >
            <div className="p-display" style={{ fontSize: 12, marginBottom: 6, opacity: 0.85 }}>
              // RES 清晰度
            </div>
            {supportsResolution ? (
              <select
                value={resolution}
                onChange={(e) => onResolutionChange(e.target.value)}
                className="p-select"
                aria-label="清晰度"
              >
                {resolutionOptions.map((r) => (
                  <option key={r.key} value={r.key}>{formatOption(r)}</option>
                ))}
              </select>
            ) : (
              <div
                className="p-mono"
                style={{
                  padding: '0.5rem 0.6rem',
                  background: 'var(--punk-black)',
                  color: 'var(--punk-cream)',
                  fontSize: 11,
                  fontWeight: 900,
                  border: '2px solid var(--punk-black)',
                  opacity: 0.85,
                }}
                aria-label="当前模型不支持清晰度切换"
              >
                // MODEL DEFAULT (该模型不支持切换)
              </div>
            )}
          </div>
        </>
      )}

      {/* CONCURRENCY — 始终显示 */}
      <div
        className="p-sticker p-tilt-l-2"
        style={{
          background: 'var(--punk-pink)',
          color: 'var(--punk-cream)',
          padding: '0.8rem 1rem',
        }}
      >
        <div className="p-display" style={{ fontSize: 12, marginBottom: 6 }}>
          // CONC 并发
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => onConcurrencyChange(n)}
              className="p-mono"
              aria-pressed={concurrency === n}
              style={{
                flex: 1,
                padding: '0.4rem 0',
                background: concurrency === n ? 'var(--punk-black)' : 'var(--punk-cream)',
                color: concurrency === n ? 'var(--punk-pink)' : 'var(--punk-black)',
                border: '2px solid var(--punk-black)',
                fontWeight: 900,
                fontSize: 13,
                cursor: 'pointer',
                transform: concurrency === n ? 'translate(-1px, -1px)' : 'none',
                boxShadow: concurrency === n ? '2px 2px 0 var(--punk-cream)' : 'none',
              }}
            >
              {n}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 在 BatchPage 中计算 sizeHidden 并传递**

在 `BatchPage.tsx` 中，`modelConfig` state 已经在 line 110-115 通过 `window.aiImageAPI.getCurrentModel()` 获取。在 `supportsResolution` 之后添加：

```typescript
  const sizeHidden = useMemo(() => {
    return (modelConfig as any)?.sizeStrategy === 'prompt'
  }, [modelConfig])
```

然后在 `<PunkConfigGrid>` 调用处传入 `sizeHidden`：

```typescript
          <PunkConfigGrid
            ratio={ratio}
            resolution={resolution}
            concurrency={concurrency}
            ratioOptions={ratioOptions}
            resolutionOptions={resolutionOptions}
            supportsResolution={supportsResolution}
            onRatioChange={setRatio}
            onResolutionChange={setResolution}
            onConcurrencyChange={setConcurrency}
            sizeHidden={sizeHidden}
          />
```

- [ ] **Step 3: 验证 TypeScript 编译通过**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: 无新错误

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/pages-react/batch-punk/PunkConfigGrid.tsx src/renderer/src/pages-react/BatchPage.tsx
git commit -m "feat: hide size controls in batch page for size-in-prompt models"
```

---

### Task 8: 对比页 UI 适配

**Files:**
- Modify: `src/renderer/src/pages-react/ComparePage.tsx`

- [ ] **Step 1: 在 ComparePage 中添加模型感知提示**

在 `ComparePage.tsx` 中，`textarea` 之前（约 line 57），添加提示逻辑：

首先在组件顶部（`const options = useMemo(...)` 之后）添加感知变量：

```typescript
  const leftIsSizeInPrompt = useMemo(() => {
    const m = models[leftModelKey] as any
    return m?.sizeStrategy === 'prompt' || m?.capabilities?.sizeStrategy === 'prompt'
  }, [models, leftModelKey])

  const rightIsSizeInPrompt = useMemo(() => {
    const m = models[rightModelKey] as any
    return m?.sizeStrategy === 'prompt' || m?.capabilities?.sizeStrategy === 'prompt'
  }, [models, rightModelKey])

  const showSizeHint = leftIsSizeInPrompt || rightIsSizeInPrompt
```

然后在 `<textarea>` 之前加入条件提示：

```typescript
      {showSizeHint && (
        <div className="px-4 py-2 bg-zinc-800/60 border-2 border-zinc-700 text-sm text-zinc-400">
          <span className="text-cyberpunk-yellow font-bold">⚡</span>
          <span className="ml-2">
            {leftIsSizeInPrompt && rightIsSizeInPrompt
              ? '两侧模型均为尺寸自适应，如需指定尺寸请在提示词中描述'
              : `${leftIsSizeInPrompt ? '左侧' : '右侧'}模型尺寸自适应，如需指定尺寸请在提示词中描述`}
          </span>
        </div>
      )}
```

- [ ] **Step 2: 验证 TypeScript 编译通过**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: 无新错误

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/pages-react/ComparePage.tsx
git commit -m "feat: show size hint in compare page for size-in-prompt models"
```

---

### Task 9: 端到端手动验证

- [ ] **Step 1: 启动开发服务器**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npm run dev`

- [ ] **Step 2: 验证生成页文生图（无参考图）**

1. 选择 gpt-image-2-all 模型
2. 确认 RatioSelector 被替换为"尺寸自适应"提示
3. 输入提示词，点击生成
4. 打开 DevTools Network 面板，确认请求发到 `/v1/images/generations`
5. 请求体为 JSON：`{ model: "gpt-image-2-all", prompt: "...", response_format: "b64_json" }`
6. 确认成功返回图片

- [ ] **Step 3: 验证生成页带参考图**

1. 上传 1 张参考图
2. 输入编辑指令，点击生成
3. Network 面板确认请求发到 `/v1/images/edits`
4. Content-Type 为 `multipart/form-data`
5. FormData 中包含 `model`、`prompt`、`response_format`、`image[]` 字段
6. 确认成功返回图片

- [ ] **Step 4: 验证批量页**

1. 切到批量页
2. 确认 PunkConfigGrid 中比例/分辨率被替换为"尺寸自适应"提示
3. 并发控制仍正常显示
4. 输入 prompt，抽卡 3 张 → 3 次独立请求 → 3 张图片

- [ ] **Step 5: 验证对比页**

1. 左侧选 gpt-image-2-all，右侧选其他模型
2. 确认出现"左侧模型尺寸自适应"提示
3. 输入 prompt，点击对比 → 两侧各出一张图

- [ ] **Step 6: 验证其他模型不受影响**

1. 切回 Nano Banana Pro 或其他模型
2. 生成页 RatioSelector 恢复正常显示
3. 批量页比例/分辨率恢复正常
4. 对比页提示消失
5. 生成请求正常走原有逻辑

- [ ] **Step 7: 最终 Commit**

如果前面有任何修复，统一 commit：

```bash
git add -A
git commit -m "fix: adjustments from e2e verification"
```
