# Seedream 5.0 Pro 接入记录 + 出图渠道扩展指南

> 2026-07-20,v4.4.5。上游:火山方舟 Ark `doubao-seedream-5-0-pro-260628`,
> 经 Miau API(new-api)以 OpenAI 兼容方式暴露。网关地址 2026-07-28 起由源站
> `175.178.198.17:3000` 改为加速域名 `https://miauapi.13797248455.xyz`(仅 https)。
> 网关侧接入文档:`seedream-5.0-pro-api-guide.md`(new-api 仓库
> `relay/channel/volcengine/seedream.go`)。

## 模型能力速查

| 项 | 值 |
|---|---|
| 模型 ID | `doubao-seedream-5-0-pro-260628` |
| 端点 | `POST /v1/images/generations`(OpenAI images 兼容) |
| 参考图 | 顶层 `image`(首张)+ `images`(全部),最多 **10** 张,URL 或 data URI |
| 分辨率 | **1K / 2K 像素档**(无 4K),映射表见 `ApiService.ts` 模型配置 `resolutionMap` |
| 输出 | 仅单图(`n` 恒为 1);`url` 或 `b64_json` |
| 不支持 | `sequential_image_generation` / `stream` / `tools` / `n>1`(网关自动剔除,应用侧从源头不发) |
| watermark | 不传时网关自动补 `false`;应用显式传 `false` |
| 站点 | **Miau-only**:请求自动 pin `antigravity` 站点,与腾讯 image2 / 万相同机制 |

## 本次改动的 6 个触点(= 加新出图渠道的标准清单)

任何新出图模型照这个清单走一遍即可,每层都有对应测试:

1. **模型注册表** `src/renderer/src/services/api/ApiService.ts` → `DEFAULT_MODELS`
   - 关键字段:`apiType`(payload 形状)、`sizeStrategy`、`ratios`/`resolutions`/
     `resolutionMap`(像素映射,ASCII `x` 或 `×` 均可,解析时归一)、
     `capabilities.maxOutputs`、`defaultParams`。
   - `apiType: 'image-generation'` + baseURL 含 `/images/generations` → 走
     `buildOpenAIPayload` 的 images 分支:参考图自动按「`image` 首张 +
     `images` 全部」发,无需新代码。
2. **聊天渠道单一真源** `src/renderer/src/features/agent-chat/imageChannels.ts`
   - 加一个 `ImageChannel` 条目;composer 选择器(`ImageChannelPicker`)与
     `AgentToolExecutor` 渠道解析自动跟随。
   - 只经 Miau 网关提供的模型标 `miauOnly: true` → 出图请求自动
     `siteKey: 'antigravity'`,用户无需切站点。
3. **MCP 工具** `src/main/mcp/tools/imageTools.ts`
   - `modelSchema` enum 加新 ID + describe 里写清「什么时候该选它」
     (agent 只看这段描述做路由)。
4. **Codex skill 权威源** `resources/plugins/catimation-core/skills/catimation-image/SKILL.md`
   - 渠道清单、Choosing a model、站点要求、Common Mistakes 的「N 个合法值」。
   - 同插件 `commands/gen-image.md` 若列渠道也要同步。
   - **别手改生成物/镜像**:改完权威源跑
     `node scripts/generate-first-party-skills.mjs`(→ `firstPartySkills.generated.ts`)
     + `node scripts/sync-top-level-skills.mjs`;
     市场发布 `npm run publish:marketplace`(自动 bump 插件版本、同步单技能市场)。
5. **测试**(每层一份):
   - `ApiService.<model>.test.ts`:payload 契约(size 像素/参考图形状/
     不支持字段不出现/count 钳制/不支持档位收敛)。
   - `imageChannels.test.ts` 顺序+miauOnly;`ImageChannelPicker.test.tsx` 下拉项;
     `AgentToolExecutor.generateImage.test.ts` 渠道选择+站点 pin;
     `imageTools.test.ts` enum 接受/拒绝。
6. **守护门**:`npm run audit:skill-arch`(skill 改动)、`npm run typecheck:ci`
   (基线门,不新增即可)、`npm run build:vite`。

## 本次顺手修的边界 bug(getImageSize)

`getImageSize` 原本只查通用硬编码尺寸表(缺 4:5/5:4,且 1K 边长与部分模型
文档不一致)。现在的解析顺序:

1. **模型自己的 `resolutionMap`** 优先(`resolveImageSizeFromMap`,归一 `×`→`x`);
2. 模型配了表、比例有档但**请求的分辨率档缺失**(如 5.0 Pro 无 4K、
   SeeDream 4.5 无 1K)→ **收敛到模型 `defaultResolution`**,绝不回落通用表
   ——通用表会给出模型根本不支持的像素(如 5120x2880)直接打到上游报错;
3. 模型没配表 → 通用硬编码表(既有模型行为不变)。

背景:MCP `generate_image` 的 `resolution` 参数是全局 enum(1K/2K/4K),
agent 可能对任何渠道传 4K,收敛逻辑是必须的兜底。

## 音频页存储演进(2026-07-21)

seed-audio 音频作品的存储从「IndexedDB 存 base64」升级为**三级持久化**
(方案 A 本地 + 方案 B COS,用户最终选 B 为主):

1. **COS 桶(主持久层,方案 B)**:生成后 `audioHistory.uploadCos` 把字节
   PUT 到图片历史 bucket 的 `image-history/audio/YYYY/MM/DD/<id>.<ext>` 前缀。
   - **复用现有 STS 授权**:`serverless/sts-cos` 只放行 `image-history/*` 的
     PutObject,所以 key 必须挂在该前缀下(用 `audio/` 子路径与图片分开),
     **零 SCF 改动**。ContentType 按格式给 `audio/mpeg|ogg|wav|pcm`。
   - 上传走 `enqueueUpload`(占并发槽)+ `rejectOversizedBase64` 大小闸门,
     与图片历史同一条通道。回权威 `https://<bucket>.cos.<region>.myqcloud.com/…`
     URL,跨设备、可分享、不失效。
2. **本地文件(缓存/离线,方案 A)**:同时落 `userData/audio-history/`,播放
   优先 `local-file://`(秒开、免网络);read/delete IPC 做目录包含校验。
3. **base64(最后兜底)**:仅当 COS 和本地都失败时才写进 IndexedDB,保证音频
   永不丢。

播放/波形/下载源优先级统一为 **本地文件 → COS URL → base64**;元数据(路径/
URL/时长/波形峰值)存 IndexedDB,不再背大字节。相关代码:
`src/main/services/audioHistoryFiles.ts`(本地文件)、`index.ts` 的
`audio-history:upload-cos`(COS)、`AudioPage.ts`(三级消费)。

## 与桶端图片处理的关系(2026-07-20 同日配置)

- COS 桶 `image-master-1345773498` 已开**自动极智压缩**:参考图 COS URL 被上
  游网关拉取时自动返回压缩字节(JPG/静态 PNG/GIF;WEBP 原样),应用零改动。
- 「保留 HDR 信息」维持**不保留**(AI 生成图无 HDR 元数据,保留只会变大)。
- 参考图链路不变:COS URL 直传(除 nano/gemini 系 `inlineRefImageAsBase64`
  内联 base64 外),Seedream 5.0 Pro 吃 URL,无需本地压缩。

## 发布链路(v4.4.5 实操)

1. `npm run publish:marketplace`(插件 catimation-core → 1.0.19,单技能 catalog 上传 COS)
2. bump `package.json` → 4.4.5 + `docs/releases/v4.4.5.md`
3. 分支 `feat/seedream-5-0-pro-channel` → PR #76 → 6 项 Quality Gate 全绿合入 main
   (途中根治了 `CodexProtocolClient.collaborationMode.test.ts` 悬空 turn promise
   的 unhandled-rejection flake:fire-and-forget 的 `iterator.next()` 补 catch)
4. 手动触发 `release.yml`(version=4.4.5)→ 构建 setup.exe + blockmap →
   上传 COS `releases/` → 校验线上 `latest.yml` → GitHub Release 兜底
