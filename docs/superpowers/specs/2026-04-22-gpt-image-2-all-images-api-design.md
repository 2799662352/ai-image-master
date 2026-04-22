# gpt-image-2-all: 切换到 Images API 端点 + 全页面 UI 适配

**日期:** 2026-04-22
**状态:** 设计完成，待实施

## 背景

当前 `gpt-image-2-all` 模型使用 `/v1/chat/completions` 对话式端点。经逆向工程分析 `imagen.apiyi.com` 和实际测试发现，该端点**不稳定——经常返回对话文本而非图片**。

[官方文档](https://docs.apiyi.com/api-capabilities/gpt-image-2-all/overview)提供三个端点：

| 端点 | 用途 | Content-Type | 推荐度 |
|------|------|-------------|--------|
| `POST /v1/chat/completions` | 对话式 | `application/json` | ⭐ 官方主推但不稳定 |
| `POST /v1/images/generations` | 文生图 | `application/json` | 兼容 |
| `POST /v1/images/edits` | 图片编辑 | `multipart/form-data` | 兼容 |

**决策：** 弃用 chat completions 端点，改用 Images API 作为唯一路径：

- **无参考图** → `POST /v1/images/generations`（JSON）
- **有参考图** → `POST /v1/images/edits`（multipart FormData）

同时在生成页、批量页、对比页做模型感知 UI 适配。

## 改动范围

| 文件 | 改动类型 |
|------|----------|
| `ApiService.ts` | 模型配置 + 新增 FormData 构建 + 请求路由 |
| 生成页相关组件 | 模型感知 UI 条件渲染 |
| 批量页 / PunkConfigGrid | 模型感知 UI 条件渲染 |
| 对比页 | 模型感知尺寸按钮 |

**不改动：** `extractImages()`（已兼容 `data[]` 格式）、TabBar、AppLayout、stores。

---

## 1. API 层改造

### 1.1 模型配置变更

```typescript
// ApiService.ts — DEFAULT_MODELS['gpt-image-2-all']
'gpt-image-2-all': {
  name: 'GPT Image 2 All',
  displayName: '30s，GPT图像生成，文生图/图片编辑/多图融合，文字还原度高，中文友好，$0.03/张🔥',
  price: 0.03,
  time: '30s',
  isNew: true,
  baseURL: 'https://b.apiyi.com/v1/images/generations',   // ← 文生图
  editURL: 'https://b.apiyi.com/v1/images/edits',          // ← 图片编辑
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
}
```

### 1.2 请求路由逻辑

在 `makeApiRequest` 中，对 `gpt-image-2-all` 进行端点分流：

```
if (modelKey === 'gpt-image-2-all') {
  const hasImages = (referenceImages?.length > 0) || imageBase64
  if (hasImages) {
    // 有参考图 → multipart FormData → POST /v1/images/edits
    const url = buildRequestUrl(modelConfig, site, 'edit')  // 用 editURL + site host 重写
    return makeGptImage2AllFormDataRequest(url, ...)
  } else {
    // 无参考图 → JSON → POST /v1/images/generations
    const url = buildRequestUrl(modelConfig, site)  // 用 baseURL + site host 重写
    return makeGptImage2AllJsonRequest(url, ...)
  }
}
```

**URL 重写注意：** `buildRequestUrl` 已有逻辑将模型 `baseURL` 的 host 替换为选中 site 的 host。需扩展该方法支持传入 `'edit'` 参数时使用 `editURL` 而非 `baseURL`，确保多站点（apiyi / b-apiyi / yunwu 等）兼容。

### 1.3 文生图 JSON 请求 (`/v1/images/generations`)

```typescript
function buildGptImage2AllJsonPayload(prompt: string): object {
  return {
    model: 'gpt-image-2-all',
    prompt,
    response_format: 'b64_json'
  }
  // 不传 size、n、quality、aspect_ratio（会触发参数校验错误）
}
```

### 1.4 图片编辑 FormData 请求 (`/v1/images/edits`)

```typescript
async function buildGptImage2AllFormData(
  prompt: string,
  imageSources: string[]  // base64 data URL 数组
): Promise<FormData> {
  const formData = new FormData()
  formData.append('model', 'gpt-image-2-all')
  formData.append('prompt', prompt)
  formData.append('response_format', 'b64_json')

  for (let i = 0; i < imageSources.length; i++) {
    const blob = await convertToBlob(imageSources[i])
    if (blob) {
      formData.append('image[]', blob, `image${i}.png`)
    }
  }

  return formData
}
```

**为什么默认 `b64_json`：**
- Electron 桌面应用无需跨域下载
- R2 CDN URL 24 小时过期，b64_json 直接持久化
- apiyi 的 b64_json 已含 `data:image/png;base64,` 前缀，可直接渲染

**`convertToBlob` 复用：** 已有 `ApiService.ts` 的 `makeFluxFormDataRequest` 中的 `convertToBlob` 方法。

### 1.5 请求发送

```typescript
// FormData 请求（不设 Content-Type，浏览器自动加 multipart boundary）
async function makeGptImage2AllFormDataRequest(
  url: string,
  formData: FormData,
  site: ApiSite,
  signal?: AbortSignal
): Promise<Response> {
  const headers: Record<string, string> = {}
  // Authorization header
  const apiKey = this.getApiKeyForSite(site)
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

  return fetch(url, {
    method: 'POST',
    headers,
    body: formData,
    signal,
  })
}
```

### 1.6 响应解析

无需改动 `extractImages()`。当前已支持 `data[]` 格式：

```typescript
// 已有代码 — 自然适配
if (data.data) {
  for (const item of data.data) {
    if (item.url) images.push(item.url)
    if (item.b64_json) {
      const b64 = item.b64_json
      images.push(b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}`)
    }
  }
}
```

之前走 chat completions 时，响应是 `choices[]`，走 `data[]` 分支走不到。切换端点后自然命中 `data[]` 路径。

### 1.7 超时

apiyi 文档建议 ≥ 120s。Electron 的 `fetch` 无默认超时，自然满足。若未来需要可在 AbortController 上加 120s timer。

---

## 2. 模型感知 UI 适配

### 2.1 判断条件

所有页面共用同一套判断逻辑，从已有的 `DEFAULT_MODELS` 配置读取：

```typescript
const modelConfig = ApiService.getModelConfig(currentModelKey)
const isSizeInPrompt = modelConfig?.sizeStrategy === 'prompt'
const isSingleOutput = modelConfig?.capabilities?.maxOutputs === 1
```

通过 `useModelStore` 获取当前模型 key，传入组件作为 props 或在组件内直接消费。

### 2.2 生成页 (GeneratePage + 子组件)

| 控件 | `sizeStrategy === 'prompt'` 时的行为 |
|------|------|
| RatioSelector | 隐藏所有比例按钮，只显示 "自适应" + 提示框 |
| 分辨率选择器 | **隐藏** |
| 图片质量选择器 | **隐藏** |
| 数量选择 | **disabled**, 值锁定为 1 |
| 提示文案 | 显示信息框：*"该模型尺寸自适应，无需单独选择。如需指定尺寸，请在提示词中描述，例如：'横版 16:9 电影画幅'、'竖版 9:16 手机海报'、'1024×1024 方图'。"* |

### 2.3 批量页 (BatchPage / PunkConfigGrid)

| 控件 | `sizeStrategy === 'prompt'` 时的行为 |
|------|------|
| 批量比例 (PunkConfigGrid) | 锁定为 "自适应"，其他选项 disabled |
| 批量分辨率 | **隐藏** |
| 批量质量 | **隐藏** |
| 抽卡模式 | 正常工作（同 prompt 调 N 次，每次出 1 张）|
| 多提示词模式 | 正常工作（每个 prompt 调 1 次）|
| 费用提示 (PunkBudgetReceipt) | 显示 "$0.03/张 × N张 = $X.XX" |

### 2.4 对比页 (ComparePage)

| 控件 | 行为 |
|------|------|
| 模型选择器（左/右）| gpt-image-2-all 可选 |
| 尺寸按钮 | 当任一侧选了 gpt-image-2-all，显示提示 "该模型尺寸自适应" |

---

## 3. 多图融合说明

apiyi 的 `/v1/images/edits` 端点支持 `image[]` 字段重复多次上传多张参考图，**上传顺序对应 prompt 中的"图1/图2/图3"**。

当前 `ReferenceImageList` 组件已支持多张参考图上传和排序。在构建 FormData 时保持 `imageSources` 数组顺序与 UI 显示顺序一致。

---

## 4. 错误处理

| 错误场景 | 处理 |
|----------|------|
| 401 令牌无效 | 现有错误处理已覆盖 |
| 429 限流/额度不足 | 现有 `withRetry` 已覆盖 |
| 5xx 服务器错误 | 现有 `withRetry`（maxRetries: 1）已覆盖 |
| FormData 中图片过大 (>10MB) | 现有参考图压缩逻辑已覆盖（browser-image-compression） |
| `b64_json` 前缀防双重拼接 | `extractImages` 中 `startsWith('data:')` 检查已覆盖 |

---

## 5. 不做的事（YAGNI）

- **不做** Chat Completions 端点保留作为回退选项（源头问题是端点不稳定，保留它没有意义）
- **不做** OSS/R2 自动转存（默认 b64_json 避开了 URL 过期问题，如需要可单独做）
- **不做** 通用 ModelCapabilities 框架（直接从现有 config 读取，不引入新抽象层）
- **不做** 图像理解页适配（gpt-image-2-all 是生成模型，不用于图像理解）
- **不做** 导演页适配（DirectorPage 目前是 @参考图 测试桩，不涉及图片生成）

---

## 6. 测试要点

1. **生成页 — 文生图（无参考图）：** 选择 gpt-image-2-all → 输入提示词 → 点击生成 → 验证走 `/v1/images/generations` → 返回图片
2. **生成页 — 带参考图：** 上传 1-3 张参考图 → 输入编辑指令 → 验证走 `/v1/images/edits` multipart → 返回图片
3. **批量页 — 抽卡模式：** gpt-image-2-all + 抽卡 5 张 → 验证 5 次独立调用 → 5 张图片
4. **批量页 — 多提示词：** 3 个不同 prompt → 验证 3 次独立调用
5. **对比页：** 左 gpt-image-2-all vs 右 Nano Banana → 两侧各出一张图
6. **UI 适配：** 切换模型时，尺寸/分辨率/质量控件正确显示/隐藏
7. **其他模型不受影响：** 切回 Nano Banana Pro → 所有控件恢复正常
