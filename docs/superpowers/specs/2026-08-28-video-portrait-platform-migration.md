# 视频 + 人像库迁到平台账号：调研与迁移方案

日期：2026-08-28
状态：**计划，未动代码**
参考实现：`D:\tecx\text\shortdrama-mvp`（同一条链路已跑通）

---

## 一句话结论

比预想的小得多。桌面端**已经有整套 `asset://` 人像库链路**（47 个文件），
`cn` 区的模型 ID 也**已经是** `doubao-seedance-*`——正是唯一认 `asset://` 的那一套。
真正要换的只有三处接缝：**base URL、鉴权、人像库端点**。

不是「接一个新功能」，是「把已有功能重新接线」。

---

## 二、为什么这条路成立（证据）

### 2.1 `asset://` 是人像库唯一的接入方式

人像库不在生成请求里传图片 URL，也不传字节。它返回一个 asset ID，
生成请求里写 `asset://<id>`。shortdrama 的类型定义把这一点摊得很平——
`asset://` 和普通 URL **共用一个字段**，下游根本不知道它的存在：

```
shortdrama-mvp/src/lib/gateway/video.ts:22-26
export interface VideoReference {
  /** http(s) URL, `asset://<id>`, or a data URI. */
  url: string;
  role: VideoRole;
}
```

### 2.2 只有 `doubao-seedance-2*` 认它——这一条决定了迁移的形状

```
shortdrama-mvp/src/lib/portrait/library.ts:141-151
 * Only Volcengine's own Seedance 2.x does. Everything else — the vvdance
 * re-hosts, wan3, HappyHorse — needs a plain HTTPS URL, and sending them an
 * `asset://` is rejected upstream.
export function supportsPortraitAssets(model: string): boolean {
  return /^doubao-seedance-2/.test(model);
}
```

**含义：换人像库和换模型命名是同一件事的两半，不能拆开做。**
一半做了另一半没做，症状是「提交被上游拒」或更糟的「静默丢掉人像一致性」。

> ⚠️ 这条来自 shortdrama 的注释（经验证据，有人踩过），**我没有独立验证**。
> 独立验证的成本是：注册一个真 asset + 拿 `vvdance-*` 模型提交一次真视频，
> 要花钱。建议在迁移的第一个真机测试里顺带证实，而不是专门跑一次。

### 2.3 桌面端的 `cn` 区已经在用对的那一套

```42:48:src/main/services/seedance/region.ts
  cn: {
    '2.0': 'doubao-seedance-2-0-260128',
    '2.0-fast': 'doubao-seedance-2-0-fast-260128',
    '2.0-mini': 'doubao-seedance-2-0-mini-260615',
    '2.5': 'doubao-seedance-2-5-260628',
    wan3: WAN3_UPSTREAM_MODEL_ID,
  },
```

逐字对上 shortdrama 的 `VIDEO_MODELS`（`options.ts:15-19`）。

**但 `global` 区是 `dreamina-seedance-*`**，按 2.2 的规则它不认 `asset://`。
桌面端现在能用是因为它接的是 vvdance 自己的素材库（另一套协议）。
迁到平台后 global 区要么跟着切 `doubao-*`，要么放弃人像库——见 §5.1。

### 2.4 平台人像库端点是超集，但**不是同一个池**

> ⚠️ **先说结论里最容易被端点清单掩盖的一条**：桌面端现有人像库是 vvdance 的
> `/api/open/v1/local-assets`（HMAC 签名、按 global/cn 站点隔离，`assets.ts:352-359`
> 那句中文错误提示就是为站点隔离写的）；平台的是 `/api/volcengine-asset/*`
> （JWT + `X-Project-Id` 计费项目作用域）。**两个不同的后端、不同的鉴权、不同的池。**
>
> 迁移的用户可见后果：**已经攒在 vvdance 库里的人像，走平台后 `asset://` 读不出来。**
> 要么接受「人像库清零、重新登记」，要么写一次性迁移（读 vvdance 列表 →
> 逐个 `POST /assets` 到平台 → 重建本地 ID 映射）。这件事必须在动代码前拍板，
> 见 §5.4。

端点层面平台确实覆盖了桌面端所需：

```
sora-ui-backend/src/routes/volcengineAsset.ts
  22: POST   /groups                    (admin)
  25: GET    /groups
  28: GET    /groups/:groupId
  34: POST   /upload-media              ← 能直接传字节
  51: POST   /assets                    ← 登记（shortdrama 只用这个）
  54: GET    /assets/:assetId/poll      ← 等就绪（shortdrama 只用这个）
  57: DELETE /assets/:assetId           ← 桌面端要
  63: GET    /assets/:assetId
  66: GET    /assets                    ← 桌面端要（列表）
```

桌面端现有的 list / delete 都有对应。**唯一缺口是 capacity**——
vvdance 有 `/local-assets/capacity`（`assets.ts:419`），平台没有对等端点。

---

## 三、三处接缝的现状与目标

| 接缝 | 现在 | 目标 |
|---|---|---|
| **视频 base URL** | `https://vvdance.yongmuai.com`（cn）/ `https://vvdance.ai`（global），`region.ts:7-10` | Miau 网关 |
| **视频鉴权** | 用户自填的 vvdance apiKey | 主进程网关 token（**已有**，`getActivePoolToken()`） |
| **人像库协议** | `/api/open/v1/local-assets`，apiKey + **apiSecret** 做 HMAC 签名，`assets.ts:27/55-56` | `/api/volcengine-asset/*`，平台 JWT + `X-Project-Id`（**JWT 已有**） |

第三行的落差最大：不只是换 URL，是换协议 + 换鉴权模型。
**好消息是 apiSecret 这个负担消失了**——平台侧不需要 HMAC 签名。

---

## 四、迁移步骤（按依赖排序）

每步标注「已有 / 要新写 / 要确认」。

### 4.1 人像库客户端（要新写，但有现成形状可抄）

新写一个 `platformAssets.ts`，与 `seedance/assets.ts` **平级共存**，不替换。
理由：用户可能还想用自己的 vvdance key，两条路要能并存，
就像现在图片那边「平台额度 / 自填 Key」并存一样。

组头（抄 `shortdrama-mvp/src/lib/portrait/library.ts:32-48`）：

```
Authorization: Bearer <平台 JWT>
X-Project-Id: <selectedPool.projectId>
X-Producer-Project-Id: <selectedPool.producerProjectId>   // 有才带
```

四个操作：
- 登记 `POST /assets`，body `{url, assetType:'Image', name: name.slice(0,64)}`，
  取 `data.Id`（**大写 Id**）
- 列表 `GET /assets`
- 删除 `DELETE /assets/:assetId`
- 等就绪 `GET /assets/:assetId/poll?timeout=30000&interval=3000`，
  等 `data.Status === 'Active'`

### 4.2 asset ID 要和 pool 成对存（要新写）

**这条最容易漏，漏了会串号。** 上游把 group 按 `project-<id>` 懒创建，
一个 pool 下登记的 asset 在另一个 pool 下**读不出来**（不是陈旧，是不存在）：

```
shortdrama-mvp/src/lib/portrait/library.ts:10-13
 * Registration is scoped to a billing project: the group is created lazily as
 * `project-<id>`, and an asset registered under one pool does not resolve for
 * a request billed to another. That is why the pool is stored next to the id.
```

读取时必须校验**池键两半都相等**（`projectId` **与** `producerProjectId`），
不等就当无效重新登记（`shortdrama-mvp/src/lib/portrait/ensure.ts:46-49`）。

**只比 `projectId` 是错的**：两个不同的 producer project 可以共用一个 `projectId`，
只按它认会把两个池悄悄合并、把素材记到错的池。上游 group 名有两种形式
（`project-<id>` 和 `project-<id>-pp-<ppId>`，见 §7.9），这就是原因。

### 4.3 每次提交前都要等就绪（要新写）

**即使已经有 asset ID 也要等。** 首次 wait 超时的 asset 否则会永久毒化
后续每一次生成（`ensure.ts:67-72`）。

拿不到就报「稍等重试」，**不要降级成图片 URL**：

```
shortdrama-mvp/src/app/api/segments/[id]/video/route.ts:256-264
    // No silent downgrade to the image URL. The portrait library is what holds
    // a face across shots, and a render that quietly used the weaker channel
    // would come back subtly wrong — a different person in the same costume —
    // which costs more than the wait.
```

### 4.4 视频提交改指网关（要确认形状差异）

shortdrama 的请求体（`video.ts:66-93`）：

```json
{
  "model": "doubao-seedance-2-0-260128",
  "prompt": "...",
  "metadata": {
    "content": [
      { "type": "text", "text": "..." },
      { "type": "image_url", "image_url": { "url": "asset://<id>" }, "role": "reference_image" }
    ],
    "duration": 10, "ratio": "9:16", "resolution": "720p", "generate_audio": true
  }
}
```

三条必须照抄的细节：
1. **`prompt` 出现两次**——顶层一次，`content[0]` 一次
2. **持 URL 的键名跟 type 走**：`image_url` / `video_url` / `audio_url`，不能合并
3. **`role` 在 entry 顶层，不能塞进 url 对象**——嵌进去 schema 接受但模型忽略，
   首帧会静默降级成松散参考（`video.ts:76-78`）

还有一条隐性契约：**`content[]` 的顺序就是编号**，提示词里的「@参考2」
按位置解析，不能重排（`video.ts:70-73`）。

**已确认（2026-08-28）：差异集中在信封，不在内容。**

桌面端打的是 vvdance 的 Ark 协议 `POST {base}/api/v3/contents/generations/ark/tasks`，
body 是**扁平**的：`content/ratio/resolution/duration/generate_audio` 全在顶层，
且**没有顶层 `prompt`**（提示词只在 `content[0].text`）。

而 `content[]` 的条目形状**两边逐字节相同**——同样的 `type`、同样的**顶层 `role`**、
同样的 `{url}` 嵌套、同样的「顺序即编号」纪律：

```245:265:src/main/services/seedance/runtime.ts
  const content: SeedanceContentItem[] = [
    { type: 'text', text: normalizeSeedancePromptReferences(input.prompt) },
  ]
  if (firstFrameUrl) {
    content.push({ type: 'image_url', role: 'first_frame', image_url: { url: firstFrameUrl } })
  }
  ...
  // ⚠️ SDK 文档要求参考视频/音频必须带 reference_video / reference_audio role
  // （多模态参考、编辑视频、延长视频示例均如此）——漏掉会被当成非参考内容处理。
```

**所以最贵的那部分（素材解析与组装：本地文件流式上传、`data:` 内联阈值、
COS 中转、失败降级）一行都不用动。** 转换基本是搬家 + 补一个重复的顶层 `prompt`。

取值形式也一致：`"16:9"` 字符串、`"720p"` 小写、整数秒、布尔音频开关。
两个要注意的默认值差异：A 的 `ratio` 默认 `16:9`、B 默认 `9:16`；
A 在 `taskMode` 存在时强制把 ratio 改写成 `adaptive`。

### 4.4b 已经有一条打 Miau 网关的 OpenAI 兼容路径可以抄

这是对工作量估算影响最大的发现：**wan3 就是**。

```14:14:src/shared/miau.ts
export const MIAU_BASE_URL = 'https://miauapi.13797248455.xyz/v1'
```

base 已含 `/v1`，wan3 打 `/video/generations`——**提交端点与目标逐字相同**。
现成可复用的：Bearer 鉴权 + 30s 硬超时、`metadata` 信封模式、`retrySubmit`、
上游状态字符串归一表、永久性错误码识别、Miau token 取值（**同一枚，用户不用配新东西**）、
`VideoTransport` 分派接口。

不能复用的只有轮询端点：wan3 打 `GET /v1/video/generations/{id}`，
目标是 `GET /v1/videos/{id}`，两条不同的路径。

> ⚠️ **未确认**：shortdrama 的 `GATEWAY_BASE_URL` 与桌面端 `MIAU_BASE_URL`
> 是否指向同一部署。

### 4.4c 会丢的能力（迁移的真实代价）

网关侧的 `buildVideoRequest` / `pollVideo` 里一个都没有：

| 能力 | 桌面端出处 | 影响 |
|---|---|---|
| `seed` 提交 + 实际 seed 回传 | `videoTransport.ts:88` / `client.ts:36` | **可复现性没了** |
| `DELETE` 取消（queued 时不计费） | `client.ts:163-169` | 误提交只能等它跑完并计费 |
| `tools: [{type:'web_search'}]` | `videoTransport.ts:91` | 联网搜索增强 |
| `taskMode: 'edit' \| 'extend'`（2.5） | `videoTransport.ts:92` | 视频编辑/延长两个功能 |
| `usage.completion_tokens` | `client.ts:29` | 计费口径读不到 |
| `2.0-mini` 与全部 `dreamina-*` | `region.ts:35-41` | 网关目录里没有对等物 |
| 官方素材库 / 素材额度 | `assets.ts:28/423` | 见 §5.2 |

未找到水印与回调字段——两侧都没有，不算丢失。

**这张表决定了迁移不能是「一刀切换」**：至少 `seed` 和 `taskMode` 是有人在用的，
需要保留 vvdance 直连作为并行选项（就像图片那边「平台额度 / 自填 Key」并存）。

### 4.5 轮询（要新写）

`GET {网关}/v1/videos/{taskId}`。
**完成判据取「URL 存在」而非 status 字符串**——网关中转多个上游，
终态词不统一（succeeded / completed / done），`video.ts:157-162`。

必须在同一 billing scope 下轮询：一个 shadow 账号建的任务，
用别的 token 查会报「不存在」（`poll/route.ts:48-51`）。

### 4.6 提交不可重发（要新写）

视频提交**没有幂等键**，重复任务会跑完、计费、且 ID 找不回
（`video.ts:98-102`）。网络不确定时不能自动重发。

---

## 五、拍板结果与剩余待定

> **已拍板（2026-08-28，用户确认）**
>
> - **§5.4 存量人像 → 双库并存 + 一键搬家。** 按当前计费模式决定读哪个库，
>   另给一个「搬到平台」的动作。不做强制迁移，不清零。
> - **§4.4c 能力落差 → 保留 vvdance 直连并行。** 与图片那边
>   「平台额度 / 自填 Key」同构。`seed` / 取消 / `web_search` /
>   2.5 的 `edit`·`extend` 都留在 vvdance 那条路上。
> - **§5.1 global 区 → 由上面两条自动解决。** 平台模式 = 网关 = 只有 `doubao-*`、
>   **没有 region 概念**（走平台额度的用户不该关心机房在哪）；vvdance 直连模式
>   原样保留 global/cn 双区与 `dreamina-*`/`doubao-*` 双套 ID。
>
> 这三条合起来意味着：**这次是「加一条平行的路」，不是「换一条路」。**
> 现有 vvdance 链路一行都不删——这也让迁移的回滚成本接近零。

### 5.1 `global` 区怎么办（已由并行决策解决，保留原分析备查）

`dreamina-seedance-*` 不认 `asset://`。走平台额度后：

- **方案 A**：平台模式只放 `cn` 那套 `doubao-*`，global 区在平台模式下不可选
- **方案 B**：平台模式下 region 概念整个隐藏（网关自己决定路由）

倾向 B——用户走平台额度时不该关心机房在哪，那是 vvdance 直连时代的概念。
但要确认 Miau 网关对 `doubao-*` 的实际路由行为。

### 5.2 capacity 缺口

vvdance 有 `/local-assets/capacity`，平台没有。
桌面端现在拿它显示「素材库还剩多少」。平台模式下要么隐藏这个数字，
要么给后端加端点。倾向先隐藏——它不阻塞主流程。

### 5.4 存量人像怎么办（新增，见 §2.4 的警告）

vvdance 库和平台库是两个池。三个选项：

- **清零重来**：最省事，但用户攒的人像全丢，跨镜头人脸一致性从头建
- **一次性迁移**：读 vvdance 列表 → 逐个 `POST /assets` 到平台 → 重建本地 ID 映射。
  可行（两边都收 URL），但要处理配额、失败重试、以及「迁到哪个 pool」
- **双库并存**：按当前计费模式决定读哪个库。最不容易出错，但 UI 要说清楚
  「这张人像在平台模式下不可用」

倾向第二个 + 第三个的组合：并存为主，给一个「一键搬到平台」的动作。

### 5.3 人像图要有公网永久 URL

平台人像库**只收 URL 不收字节**（虽然有 `upload-media`，shortdrama 没用）。
URL 必须公网可达、不过期、无签名：

```
shortdrama-mvp/src/lib/portrait/library.ts:50-56
 * The URL must be reachable from the internet, which is satisfied by the COS
 * bucket generated images already go to — no upload step is needed, and adding
 * one would put a second copy of every portrait in a second bucket.
```

**要确认**：桌面端的人像图现在存在哪。如果是本地文件或私有存储，
就得先过一道 COS——或者改用平台的 `POST /upload-media`（shortdrama 没走这条，
但它存在，可能反而更适合桌面端）。

---

## 六、展示层：shortdrama 填不了，但 sora-ui 能

shortdrama 压根没调过列表接口——它展示的是自己数据库里的 `imageUrl`，
这就是「人像库没有图片展示」的由来。所以列表 / 缩略图这一段它帮不上忙。

**参考实现在 `D:\tecx\text\25\soraui_4.0` 的 web 前端**（用户确认：
「完整的人像库调用、缩略图、图片展示都有」）。`GET /assets` 的分页参数、
返回形状、缩略图取哪个字段、Status 非 Active 时怎么占位——都在那儿。

桌面端这侧 `PortraitLibraryPage` / `PortraitPickerModal` 的 UI 已经存在，
换的只是数据源，不是重画界面。

---

## 七、人像库接口契约（照抄用）

来源：`soraui_4.0` 的 `sora-ui/src/api/volcengineAsset.ts` +
`sora-ui/src/stores/volcengineAssetStore.ts` + 后端 controller 逐条对过。
**前端类型与后端实际返回有多处不一致，下面以后端为准**。

### 7.1 我之前的路由清单漏了两条

```
PATCH /assets/:assetId      ← 重命名 + 从回收站恢复的唯一入口，必须要
PATCH /groups/:groupId      （admin，桌面端用不到）
```

注册顺序有意义：`/assets/:assetId/poll` 必须在 `/assets/:assetId` 之前。

### 7.2 `DELETE` 默认是**软删**，不是真删

```434:459:sora-ui-backend/src/controllers/volcengineAssetController.ts
const purge = req.query.purge === '1' || req.query.purge === 'true';
if (purge) { ... await assetSvc.deleteAsset(assetId); ... }
else { await hideVolcAsset({ volcAssetId: assetId, projectId, userId: ... }); }
```

**三个不同语义的动作，UI 必须分开：**

| 动作 | 请求 | 效果 |
|---|---|---|
| 移出素材库 | `DELETE /assets/:id` | 本地隐藏表打标，**不动火山、不释放配额** |
| 从回收站恢复 | `PATCH /assets/:id` body `{hidden:false}` | 取消隐藏，**之后必须重拉列表** |
| 彻底删除 | `DELETE /assets/:id?purge=1` | 真删上游，不可逆，**唯一能回收配额的手段** |

文案上「删除」要写成「移出素材库」，否则用户会困惑为什么删了还提示素材过多。

### 7.3 缩略图：`PreviewUrl || URL`，永久性取决于有没有过 COS 映射

火山原生返回的是**会过期的签名 TOS 链**。后端建了旁挂表 `volc_asset_cos`，
把上传时拿到的永久 COS 公网链存下来，每次响应前就地覆盖：

```26:32:sora-ui-backend/src/services/volcAssetCosService.ts
export function applyCosOverride<T extends CosOverridable>(item: T, cosUrl: string | undefined | null): T {
  if (!cosUrl) return item;
  item.cosUrl = cosUrl;
  item.URL = cosUrl;
  item.PreviewUrl = cosUrl;
  return item;
}
```

所以：走 `upload-media → POST /assets` 入库的素材是**永久链、零处理**；
历史遗留或映射查询失败的退回签名链，**会过期**。前端**没有任何过期处理**——
唯一兜底是 `onError` 换灰色占位。

**一个可以顺手捡的优化**：网页版把原图 URL 直接塞 `<img>`，
40MB 的原图缩略图也下载完整 40MB。COS 支持 `?imageMogr2/thumbnail/400x`，
仓库里已有该工具但只服务 tldraw 画布，人像库没接。桌面端拼上去能把首屏流量
降一到两个数量级。

### 7.4 上传是两步，必须串行

```217:222:sora-ui/src/stores/volcengineAssetStore.ts
const mediaRes = await uploadVolcMedia(file);
const cosUrl = mediaRes.data.url;
const detectedType = mediaRes.data.assetType;
const res = await createVolcAsset({ url: cosUrl, assetType: detectedType, name: file.name });
```

① `POST /upload-media`，**multipart，字段名固定 `file`**，
不要手动设 `Content-Type`（会丢 boundary）。返回 `{url, cosKey, fileSize, assetType}`，
其中 `assetType` 已是 `Image`/`Video`/`Audio` 首字母大写，**直接喂给第二步**。

② `POST /assets` body `{url, assetType, name}`。

远程 URL 跳过①直接②。

**大小限制以后端为准**：图片 50MB / **视频 50MB** / 音频 15MB。
前端 `mediaLimits.ts:29` 写的 200MB 视频与后端 multer 的 50MB 冲突，
50–200MB 的视频会在服务端 400。

**MIME 白名单只有 13 种**，`video/webm`、`audio/ogg`、`audio/aac` 全拒——
但前端后缀正则却放行它们，又一处不一致。

### 7.5 `POST /assets` 的返回不含 `Status`

前端类型声明返回完整 `VolcAsset`，但后端实际只保证：

```188:189:sora-ui-backend/src/controllers/volcengineAssetController.ts
res.json({ success: true, data: { ...result, URL: url, PreviewUrl: url, cosUrl: url } });
```

而 `result` 的类型是 `{ Id: string }`。**没有 `Status`/`Name`/`AssetType`/`CreateTime`。**

**但它确实回了 `URL`/`PreviewUrl`/`cosUrl`**（都等于提交的那个 URL，而那已经是永久 COS 链）。
所以缺的只是元数据，**缩略图立刻可用**——不用等 poll。

后果：刚上传的卡片会有图，但显示「未命名 / 处理中 / 无日期」。
桌面端可以把本地已知的 `Name`/`AssetType`/`CreateTime` 合并进去——
网页版没做这一步，体验上是个可以超过它的地方。

### 7.6 等就绪用 `poll`，它是**服务端长轮询**

一次 HTTP 请求，后端内部循环等，最长 90 秒（不是客户端 setInterval）。
axios 超时要留余量（网页版是 `timeout + 5000`）。
失败才退回「睡 5 秒 + 重拉列表」。

`interval ∈ [2s, 10s]`，`timeout ∈ [5s, 90s]`（service 里的 docstring 写 30s
是**过期注释**，以常量为准）。

### 7.7 列表：一次拿全量，不做服务端分页

网页版固定 `pageSize=2000&sortBy=CreateTime&sortOrder=Desc`，从不翻页；
搜索、类型过滤、`Hidden` 过滤**全在本地**。

⚠️ **`sortOrder` 传小写 `desc` 会落不进白名单**（静默丢弃排序）。

⚠️ **超 500 条后服务端 Redis 缓存永久命中不了**——缓存最多存 500 条，
而请求固定要 2000，命中条件恒不成立。首屏会退化成 5–20 次串行上游调用、
最长 30 秒。**桌面端应自建本地缓存，别指望服务端那层。**

⚠️ **`TotalCount` 不等于 `Items.length`**，也不是上游总数（三分支算出来的可见总数）。
要显示「N 可用」就自己数 `Status === 'Active'` 的条数。

### 7.8 `Hidden` 的过滤必须在展示层，**严禁在 store 层**

```50:57:sora-ui/src/stores/volcengineAssetStore.ts
 * ⚠️ **绝不要在这里过滤 `Hidden`**：`useResolvedAssetUrls` 正是从这个数组建 map 来
 * 解析画布节点的 `asset://`，在 store 层过滤会让已有节点直接解析失败。
```

后端同一纪律的对侧：隐藏素材**不过滤、不 404**，只打标。

### 7.9 group 完全不用管

`GET/POST/PATCH /groups` 在整个 sora-ui 里**零调用**。
后端按 `project-<id>` / `project-<id>-pp-<ppId>` 懒创建，带进程内锁防并发建孤儿组。
`GroupId` 字段虽在类型里但前端无消费点。

### 7.10 Electron 特有的三个坑

1. **必须显式配绝对 `baseURL`**——网页版用裸 axios 打相对路径，靠 nginx 转发。
2. **`/proxy/cos`、`/proxy/oss`、`/proxy/tos` 是 nginx location，Electron 里不存在。**
   好消息是 `PortraitGrid` 不用它们，只有画布那版的视频缩略图用。
3. **抄 `PortraitGrid` 不要抄 `CanvasLibraryOverlays`**——前者是 antd 弹窗版（增量渲染），
   后者是画布深色版（虚拟滚动 + 多选 + 代理路径）。以前者为骨架，
   需要时把后者的 `VirtualCardGrid` 摘过来替掉增量渲染。

---

## 八、建议的推进顺序

### 8.1 两个前置问题都已回答（2026-08-28）

- **§4.4 形状差异** → 差异只在信封，`content[]` 逐字节相同，见 §4.4 / §4.4b
- **§5.3 人像图存放** → 不需要自己过 COS，平台的 `POST /upload-media` 就是
  「把本地字节变成永久 COS 公网链」的那一步，见 §7.4

### 8.2 规模

以已有的 **wan3 传输层 857 行**（非测试代码）为标尺：

| 部分 | 规模 | 依据 |
|---|---|---|
| 视频传输层 | **约 300–400 行**（wan3 的 0.35–0.5 倍） | 不需要 `fromContent` 的槽位映射（-83 行）；`request.ts` 缩到约 1/4（wan3 那 346 行大头是槽位映射 / 四种模式互斥 / 拦 `asset://` / 大小写转换，这里一条都不存在）；`credentials.ts` 归零（同一枚 Miau token） |
| 分派与类型改动 | 约 30–60 行 | 六个文件，一半是类型穷尽性逼出来的机械补齐 |
| 人像库客户端 | **明显小于现有的 501 行** vvdance 客户端 | 不用 HMAC 签名、不用站点隔离、不用本地叠加层（改名走 `PATCH`、隐藏走软删，都在服务端） |
| 人像库 UI | **接近零** | `PortraitLibraryPage` / `PortraitPickerModal` 已存在，换数据源 |
| 存量迁移（§5.4） | **未估** | 取决于选哪个方案 |

### 8.3 顺序

1. **先拍 §5.4（存量人像怎么办）**——它影响 UI 形状，且是唯一的用户可见破坏
2. 再拍 §5.1（global 区）与 §4.4c（要不要为了 seed / taskMode 保留 vvdance 直连）
3. 然后：人像库客户端 → asset+pool 成对存储 → 提交前等就绪 → 视频传输层 → 轮询
4. 处理 `transportFor` 的分派冲突（现在按 `provider === 'miau' && registry.wan3` 判断，
   新 transport 也是 `miau`，会撞）

### 8.4 仍未确认的一条：轮询路径

**提交端点没有疑问**，两边算出来是同一个：

| | base | 代码里拼的路径 | 实际 URL |
|---|---|---|---|
| shortdrama | `GATEWAY_BASE_URL`（不含 `/v1`） | `/v1/video/generations` | `{origin}/v1/video/generations` |
| 桌面端 wan3 | `MIAU_BASE_URL`（**含** `/v1`） | `/video/generations` | `{origin}/v1/video/generations` |

**有疑问的是轮询**——两边打的是**不同路径**：

- wan3：`GET /v1/video/generations/{id}`（`wan3/client.ts`）
- shortdrama：`GET /v1/videos/{id}`（`gateway/video.ts:146`）

两者可能都存在（new-api 同时支持），也可能各自只对自己那类模型有效。
**这是实现时第一个要撞的东西**，成本很低：拿一个真 taskId 分别打两条，
看哪条回得出来。不值得现在专门跑一次——放进第一个烟测里。

（shortdrama 仓库里没有真 `.env`，`.env.example` 是占位符
`http://your-gateway-host:3000`，所以「是否同一部署」这个问法没法从代码回答，
但由上表可知它也不重要。）
