# GPT Image 2 官转 集成文档

## 概述

`gpt-image-2` 是 OpenAI 官方旗舰图像生成模型，通过 API易 网关接入。支持精确的 size/quality 控制、4K 输出、mask 局部重绘。按 token 计费。

与 `gpt-image-2-all`（官逆）区别：官转走 OpenAI Images API 正式通道，支持精确参数控制；官逆走逆向通道，统一 $0.03/张。

## 定价

按 token 计费（输入 text + 输入 image + 输出 image 三段之和）：

| 画质    | 1024×1024 | 1024×1536 / 1536×1024 | 2K/4K          |
|---------|-----------|----------------------|----------------|
| Low     | $0.006    | $0.005               | 按 token 实计  |
| Medium  | $0.053    | $0.041               | 按 token 实计  |
| High    | $0.211    | $0.165               | 按 token 实计  |

编辑（带参考图）因自动启用 high-fidelity，输入 token 显著高于纯文生图。

## 预设尺寸

| size           | 含义          | 分辨率等级 |
|----------------|--------------|-----------|
| `auto`         | 自适应（默认） | 模型决定   |
| `1024x1024`    | 方形 1:1      | 1K        |
| `1536x1024`    | 横版 3:2      | 1K        |
| `1024x1536`    | 竖版 2:3      | 1K        |
| `2048x2048`    | 方形 1:1      | 2K        |
| `2048x1152`    | 横版 16:9     | 2K        |
| `3840x2160`    | 横版 16:9     | 4K        |
| `2160x3840`    | 竖版 9:16     | 4K        |

自定义尺寸约束：最大边 ≤ 3840px，两边 16 的倍数，比例 ≤ 3:1，总像素 0.65-8.3MP。

## 质量档位

| quality  | 说明               | 适用场景                  |
|----------|--------------------|--------------------------|
| `auto`   | 模型自动选择        | 默认                     |
| `low`    | 快速草图            | 批量、草稿               |
| `medium` | 均衡                | 日常使用                 |
| `high`   | 精细（印刷级文字）   | 终稿、海报、精细文字      |

## API 端点

| 端点                          | 用途                | Content-Type             |
|-------------------------------|--------------------|--------------------------| 
| `POST /v1/images/generations` | 文生图              | `application/json`       |
| `POST /v1/images/edits`       | 参考图编辑/多图融合  | `multipart/form-data`    |

域名：`b.apiyi.com`（已配置）、`api.apiyi.com`、`vip.apiyi.com` 均可。

## 代码架构

### 模型配置 (`ApiService.ts → DEFAULT_MODELS['gpt-image-2']`)

```
ratios[]        → 扁平预设尺寸列表，key 直接作为 API size 参数
resolutions[]   → 质量选项（auto/low/medium/high），复用分辨率下拉 UI
sizeStrategy    → 'size-param'（通过 size 参数控制尺寸，非 prompt）
defaultParams   → { output_format: 'png' }
capabilities    → { imageEdit: true, resolutionControl: true, ... }
```

### 请求路由 (`makeApiRequest`)

```
model === 'gpt-image-2' || 'gpt-image-2-all'
  ├── 有参考图 → makeGptImage2FormDataRequest (multipart)
  │     参数: model, prompt, image[], size?, quality?
  └── 无参考图 → buildGptImage2JsonPayload (JSON)
        参数: model, prompt, size?, quality?, output_format?

isOfficial (gpt-image-2):
  - 不发 response_format、n
  - 发 size, quality, output_format
  - 超时 360s
  - b64_json 返回纯 base64（需拼前缀）

!isOfficial (gpt-image-2-all):
  - 发 response_format: 'b64_json'
  - 不发 size, quality
  - 超时 120s
  - b64_json 返回带前缀
```

### 尺寸/质量解析

```
resolveGptImage2Size(ratio)
  → ratio key 含 'x' 直接返回（如 '2048x1152'）
  → 'auto' 返回 undefined（不传 size）

resolveGptImage2Quality(resolution)
  → 'low'/'medium'/'high' 直接返回
  → 'auto' 返回 undefined（不传 quality）
```

### UI 适配

`ModelSelectorManager.renderResolutionOptions` 检测 `isQualityMode`：
- 当 resolutions 包含 `low`/`medium`/`high` 时，标签切换为"图片质量"
- 隐藏"最终分辨率"像素显示

## 与 gpt-image-2-all 选型

| 需求              | 推荐模型            |
|-------------------|-------------------|
| 精确尺寸/4K        | gpt-image-2       |
| 质量档位控制        | gpt-image-2       |
| mask 局部重绘       | gpt-image-2       |
| 统一价 $0.03/张    | gpt-image-2-all   |
| 速度优先 (~30s)    | gpt-image-2-all   |
| 参数极简            | gpt-image-2-all   |

## 注意事项

1. **超时**：`quality=high` + 4K 可达 3-5 分钟，客户端超时已配 360s
2. **禁用参数**：不要发 `input_fidelity`（强制高保真）、`background: transparent`（不支持）
3. **b64_json 差异**：官转返回纯 base64（无前缀），`extractImages` 已处理自动拼接
4. **令牌类型**：必须使用"按量优先"令牌，按次计费令牌不可用
5. **单次出图**：固定 1 张（`n=1`），需要多张请并发调用

## 参考文档

- [API易 GPT-Image-2 概览](https://docs.apiyi.com/api-capabilities/gpt-image-2/overview)
- [文生图 API](https://docs.apiyi.com/api-capabilities/gpt-image-2/text-to-image)
- [图片编辑 API](https://docs.apiyi.com/api-capabilities/gpt-image-2/image-edit)
- [官转 vs 官逆对比](https://docs.apiyi.com/api-capabilities/gpt-image-2/vs-gpt-image-2-all)
