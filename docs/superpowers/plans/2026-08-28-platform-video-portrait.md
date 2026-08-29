# 平台视频 + 人像库：实现计划

日期：2026-08-28
分支：`feat/account-quota-phase1`（延续）
设计文档：`docs/superpowers/specs/2026-08-28-video-portrait-platform-migration.md`

---

## 这次做的是什么

**加一条与现有 vvdance 链路平行的路**，不是替换。用户已拍板：

- 存量人像 → 双库并存 + 一键搬家
- 能力落差（`seed` / 取消 / `web_search` / 2.5 的 `edit`·`extend`）→ 保留 vvdance 直连
- global 区 → 平台模式无 region 概念，vvdance 直连原样保留双区

**推论：现有 `seedance/` 目录一行都不删。** 回滚 = 把新 transport 从 registry 摘掉。

---

## 全局纪律（每个任务都适用）

1. **TDD，红在前。** 每个任务先写测试跑出红，再实现。提交信息里写清红的证据。
2. **不用 PowerShell 的 `Get-Content`/`Set-Content` 碰源文件**——会静默把 CJK 重编码成 ANSI。
   （这条踩过，见 `docs/superpowers/plans/2026-08-25-desktop-login-client.md`）
3. **注释只写代码自己说不出来的**：约束、取舍、踩过的坑。不写"这行在做什么"。
4. 每个任务结束跑 `pnpm exec tsc --noEmit`，**基线是 7 条**，多一条就是自己引入的。
5. 每个任务单独提交。

---

## Task 1：平台人像库客户端（主进程）

**新文件** `src/main/services/portraitLibrary/platformAssets.ts`

与 `seedance/assets.ts`（vvdance，501 行 HMAC）**平级共存，不替换**。

### 要实现的

组头（三个）：

```
Authorization: Bearer <平台 JWT>        ← 复用 session.ts 的凭据读取
X-Project-Id: <selectedPool.projectId>
X-Producer-Project-Id: <producerProjectId>   ← 有才带
```

缺 `X-Project-Id` 时后端 400 —— **但 `upload-media` 例外**，它不调 `requireProjectId`。
即便如此仍然带上并在客户端先校验：上传后紧跟的 `registerAsset` 一定要 pool，
在推 50MB 之前失败比之后失败好。（想支持「先传后选池」的话后端是允许的。）

**八个**操作，路径前缀 `/api/volcengine-asset`：

| 函数 | 请求 | 备注 |
|---|---|---|
| `registerAsset` | `POST /assets` `{url, assetType, name:name.slice(0,64)}` | 取 `data.Id`（**大写 Id**）。不含 `Status`/`Name`/`CreateTime`，但**含 `URL`/`PreviewUrl`/`cosUrl`**（=提交的那个 URL，已是永久 COS 链）→ 缩略图立刻可用，只缺元数据 |
| `listAssets` | `GET /assets?pageSize=2000&sortBy=CreateTime&sortOrder=Desc` | `sortOrder` **必须大写 `Desc`**，小写会静默丢排序 |
| `getAsset` | `GET /assets/:id` | 纯请求，**不在这一层做缓存**（in-flight 去重与 404 负缓存归 Task 2） |
| `pollAsset` | `GET /assets/:id/poll?interval=3000&timeout=90000` | **服务端长轮询**，HTTP 超时要 95s |
| `hideAsset` | `DELETE /assets/:id` | **软删**，不动火山、不释放配额 |
| `purgeAsset` | `DELETE /assets/:id?purge=1` | 真删，不可逆，唯一能回收配额的 |
| `patchAsset` | `PATCH /assets/:id` `{name}` 或 `{hidden:false}` | 重命名 + 从回收站恢复 |
| `uploadMedia` | `POST /upload-media` multipart 字段名 `file` | 本地文件两步走的第一步 |

### 必须写进测试的约束

- **`sortOrder` 传小写会丢排序** —— 断言发出去的是 `Desc`
- **`name` 超 64**：`POST` 会静默截断（`controller:177`），
  但 **`PATCH` 直接 400**（`controller:490`，空名也 400）——**同一个字段两种行为**。
  客户端两条路都自己先截，`PATCH` 另加空名守卫，否则 >64 的重命名会失败
- **大小写敏感的 `assetType`**：`Image`/`Video`/`Audio`，拼错会被后端静默降级成 `Image`
- **大小限制按后端口径**：图片 50MB / **视频 50MB** / 音频 15MB
  （前端 `mediaLimits.ts` 那个 200MB 视频是错的，后端 multer 卡 50MB）
- **MIME 白名单 13 种**，`video/webm`、`audio/ogg`、`audio/aac` 要在客户端就拒，
  别让用户传完 50MB 才拿到 400
- **multipart 用原生 `FormData` + `Blob`，不要用 npm 的 `form-data`。**
  Electron 的 `net.fetch` 只接受标准 Fetch `BodyInit`，塞 npm `form-data` 实例会被序列化成
  字面量字符串 `[object FormData]` —— boundary 还在但文件没了，400。
  （同款 bug 与修法见 CherryHQ/cherry-studio#18021；该包也不是本仓依赖。）
  `Content-Type` 交给 Electron 自己带，**手写就会丢 boundary**

### 验收

- 新文件零 lint、tsc 不增
- 测试覆盖：七个操作 × 正常路径 + 上面六条约束各一条
- **不做**：本地叠加层（改名走 `PATCH`、隐藏走软删，都在服务端）

---

## Task 2：asset + pool 成对存储与 `ensure` 语义

**新文件** `src/main/services/portraitLibrary/ensureAsset.ts`

### 为什么必须成对

上游把 group 按 `project-<id>` **或** `project-<id>-pp-<ppId>` 懒创建，
**一个 pool 下登记的 asset 在另一个 pool 下读不出来**（不是陈旧，是不存在）。
只存 assetId 会串号。

> ⚠️ **池键是两半：`projectId` 和 `producerProjectId`。**
> 两个不同的 producer project 可以共用一个 `projectId`，只按 `projectId` 认
> 会把两个池悄悄合并、把素材记到错的池——**正是这个模块存在的理由那个 bug**。
> （同样的教训见 `src/main/services/auth/session.ts:177-181`。）

### 语义

```
读缓存 → 校验池键**两半都**相等（不等视为无效）
       → 无效则 registerAsset
       → 立刻落库（不等就绪就存，ID 签发即有效）
       → 每次都 pollAsset 等就绪（包括用旧 ID 时）
       → 拿不到 → 抛「稍等重试」，绝不降级成图片 URL
```

**「每次都等」这条最容易漏。** 首次 wait 超时的 asset 否则会永久毒化后续每一次生成。

它比听起来便宜得多：**后端 `pollAsset` 有短路**——`Status` 已是 `Active`/`Failed` 时
直接返回、不进长轮询循环（`controller:401`）。所以复用旧 ID 时那一次「等」
是一个快速往返，不是 90 秒。

**「不降级」这条要写进注释。** 降级会产出「同一套衣服换了张脸」，比等待贵得多。

### 从 Task 1 挪过来的两件缓存

`getAsset` 的 **in-flight 去重**（一个弹窗里多个 chip 常指向同一素材，
并发只该打一次）与 **404 / 403 / 网络失败的负缓存**（列表里没有、单查也拿不到的 id
多半是上游已删或不属于当前池，再查也一样，别让 render 循环把接口打爆）。

Task 1 的客户端刻意不含缓存，这两件归这里。

**负缓存必须按池分键。** 上面那句「不属于当前池」的理由自己否定了自己——
「不属于当前池」恰恰意味着**换个池就该重查**，「再查也一样」只在同一个池内成立。
照抄网页版那个裸 `Set<string>` 会让切池后仍判缺失，把最该重查的情况变成永不重查。
（网页版能用裸 Set 是因为项目选择就在那个 store 手里；主进程这层是叶子，
`scope` 每次调用现传，它**永远不会知道池换了**。）

**负缓存要有 TTL，且 5xx 不进负缓存。** 403 最常见的成因是「还没加入那个组织」，
用户去加入了缓存却要等重启才松口——补救措施是「重启」的 bug 不该留。
5xx 是上游此刻不舒服而不是 id 不存在，缓存它等于把一次抖动放大成 TTL 那么久的
假性缺失，而缺失在展示层就是一张裂图。

### 实现时补上的四条（计划原本漏了）

- **`ASSET_FAILED` 要和「还在处理」分开。** `Status === 'Failed'` 是上游对这张图的
  终态判决，重试永远不会成功。只给一句「稍等重试」会把用户送进无限重试。
- **复用的 id 遇 404/403 要驱逐绑定再抛。** 这是 Task 2 × Task 5b 交叉出的死局：
  「彻底删除」删掉素材后本地绑定指向不存在的 asset，不驱逐的话这张图在这个池里
  **永远**用不了，而用户没有任何补救（那个 JSON 不在 UI 上）。
  刚登记就 404 则**不**驱逐——那更像传播竞态，立刻重登记会在每次失败上叠一个孤儿。
- **`ensureAsset` 自己也要并发去重**，不只是 `getAsset`。一次多镜提交里同一张脸
  出现在好几个镜头是常态，而重复登记不是「多打一次接口」——它在上游留下一份真实副本，
  占配额、占列表分页预算，**只有 purge 能收回**。
- **持久化的池键在盘上保持两个数字**，不要压成 `"42:7"` 这种派生串。派生串有损：
  哪天有人把 `poolKey()` 写成只取 `projectId`，文件看上去照样合法，两个池就此静默合并
  且**再也分不开**。留两个字段，同样的错误至多让比较逻辑出错（那有测试兜），
  盘上数据仍然可诊断、可修复。

### 验收

- 测试必须覆盖：跨 pool 的旧 ID 被判无效并重新登记、有 ID 时仍然等就绪、
  等不到时抛错而非返回图片 URL
- 这三条各写一个变异测试（把逻辑改掉要能变红）

---

## Task 3：IPC + preload 暴露

按 `auth/ipc.ts` 的既有形状：`quotaRpc` 式 `{ok, data} | {ok:false, error}` 信封，
**不裸抛**（裸抛经 IPC 会被包成 "Error invoking remote method"，error code 全丢）。

通道名沿用 `portrait:` 前缀，全部收进卸载清单（漏加会在热重载后泄漏 handler）。

### 验收

- 通道注册/卸载对称的测试（dispose 后 handler 不在）
- 错误信封形状的测试

---

## Task 4：网关视频传输层

**新目录** `src/main/services/seedanceGateway/`，四个文件（照 `wan3/` 的结构）。

### 与 wan3 的差异（决定了它更小）

- **不需要 `fromContent.ts`（wan3 有 83 行）**——`ctx.content` 直通，不用拆再重组
- **`request.ts` 缩到约 1/4**——wan3 那 346 行的大头是槽位映射、四种模式互斥、
  拦 `asset://`、大小写转换，这里一条都不存在（反而要**放行** `asset://`）
- ~~**`credentials.ts` 归零**——同一枚 Miau token~~ **这条是错的。**
  不是同一枚：平台计费用的是 `gatewayToken.ts` 的影子 token，自填 Key 模式才是
  用户的 Miau key。这个文件恰恰是 Task 4 里唯一需要真决策的地方。

### token 决策的结论（实现时定的）

**`net.fetch` 确实会经过 `onBeforeSendHeaders`**（Electron typings 明写
"will trigger webRequest handlers"、"will issue requests from the default session"），
而注入器挂的 `mainWindow.webContents.session` 此刻就是 `defaultSession`
（那个窗口没设 `partition`）。**但主进程不走它**，三条理由：

1. **它的失败模式是「删掉 Authorization 后放行」。** 打了标记却取不到 token 时，
   注入器先删我们的头、又写不回自己的（刻意如此），请求裸奔去撞 401。
   对渲染层这是对的，对提交视频是最坏的——我们本可以在出门前就说「请先选计费池」。
2. **覆盖范围是偶然成立的。** `index.ts:469` 的注释说明作者刻意避开 `defaultSession`
   （怕将来窗口设 partition）。哪天真加了 partition，渲染层照常工作，
   主进程这条路会**静默**失去注入——正是注入器自己警告过的那种失效。
3. 那是渲染层与主进程之间的私有协议。主进程绕远路，只为读一个它本来就能直接读的值。

策略收在 `resolveSeedanceGatewayToken(sources, prefer?)`：显式 `prefer` 时
**绝不跨模式回落**（两个方向都是「用户以为花 A 的钱、实际花了 B 的」）；
没有 `prefer` 时（MCP 那条路没有渲染层）平台优先、退自填 Key。

> ⚠️ **留给 Task 5 的一个缺口**：`useQuotaStore.setBillingSource('own-key')` 把
> `clearBillingPool()` 的失败吞掉了，所以存在「渲染层已 own-key、主进程仍握 activePool」
> 的窗口。**UI 路径必须显式传 `prefer`**，自动兜底只给 MCP 用。

### 模型 ID 必须钉在 `cn`（计划原本没写）

`resolveSeedanceModelId(alias)` 跟 vvdance 的 region 走，global 区解析出 `dreamina-*`——
而 §4.4c 自己说了网关目录里没有对等物。不钉死的话，海外站用户走平台余额
一提交就是 `model_not_found`，且完全想不到是「站点设置」造成的。
这也与 §5.1 的决策一致：平台模式没有 region 概念。

### `request.ts` 要做的

```
{
  model,
  prompt,                    ← 新增：取 content[0].text，videoTransport.ts:63-68 的 promptFrom 现成
  metadata: {
    content,                 ← ctx.content 原样
    duration, ratio, resolution, generate_audio
  }
}
```

两个默认值差异要注意：vvdance 的 `ratio` 默认 `16:9`，网关侧参考实现是 `9:16`——
**跟随桌面端现有默认，不要跟 shortdrama**。

### `client.ts`

- `POST /v1/video/generations`（`MIAU_BASE_URL` 已含 `/v1`，拼 `/video/generations`）
- `GET /v1/videos/{id}` ← **与 wan3 的 `/v1/video/generations/{id}` 不同**，见 §烟测
- 复用 `retrySubmit`、Bearer、30s 超时、永久性错误码识别

### `response.ts`

**完成判据是「URL 存在」而非 status 字符串**——网关中转多个上游，
终态词不统一（succeeded / completed / done）。多位置兜底找 URL。

### 分派冲突（已解，但我原来的说法立不住）

`transportFor` 现在是 `provider === 'miau' && registry.wan3`，新 transport 也是 `miau`，会撞。

我原来写「两个 miau provider 各自路由到对的 transport」——**这个说法是错的**：
不存在两个 miau *provider*，只有一个 provider 值、两条路；
而「走哪条」根本不是模型属性，**是计费模式属性**。

引入第三个 provider 值意味着加一个模型别名，而 `ALL_VIDEO_MODEL_ALIASES` 是从能力表
派生的——那会直接漏进工作台下拉和 MCP 的 zod enum，等于提前做了 Task 5 的渲染层接线。

**实际做法**：按别名分派 + 一个显式的 `billing` 路由参数。

### registry 接线故意留给 Task 5

我原来说「回滚 = 把新 transport 从 registry 摘掉」，暗示 `runtime.ts` 要注册它。
但在没有 `billing` 来源之前注册，产出的是一条**永远选不中的管线**；
而 `seedance/runtime.ts` 没有单测，那会是启动路径上一处买不到任何东西的未测改动。
Task 5 拿到 `billingSource` 时，把注册和传参一起加才是一个连贯可测的改动。

### `promptFrom` 没有直接复用

我原来说 `videoTransport.ts:63-68` 现成。实际改成让组包器**自己从 `content[]` 取**，
`input.prompt` 只作兜底——这样「顶层与 `content[0]` 逐字相同」是**结构上保证**的，
粗心的调用方没法把两份写歪。

### 验收

- `request.ts` 的形状测试要钉死三条：`prompt` 出现两次、
  持 URL 的键名跟 `type` 走、`role` 在 entry 顶层（嵌进 url 对象里 schema 接受但模型忽略）
- `content[]` 顺序即编号的不变量测试
- 分派不再有歧义的测试（两个 miau provider 各自路由到对的 transport）

---

## Task 5：渲染层接线

### 5-0 必须先堵的一个洞（评审 Task 4 时发现）

`transportFor` 在 `billing === 'platform'` 但 `registry.seedanceGateway` **没注册**时，
会静默回落到 `registry.seedance`（vvdance 直连）——**用户以为在花平台余额、
实际扣的是自己的 vvdance key**。

这正是同一个提交里 `seedanceGateway/credentials.ts` 明确拒绝的事：
> 刻意不回落到自填 Key：静默回落 = 用户以为在花平台余额、实际在花自己的钱。

两处对同一条不变量态度不一致。今天不可达（registry 还没接线，那条回落是给
「只注入 seedance 的老测试」用的），**接线之后就活了**。

**修法二选一**（接线的同一个改动里做，别拖）：
- 让 `seedanceGateway` 在 registry 里变成必填，用类型堵死
- 或者 `billing === 'platform'` 且拿不到 gateway transport 时**抛**，
  给一句「平台余额通道未就绪」，而不是换一条计费路

要有测试钉死：**平台模式下永远不会落到 vvdance 直连**。

### 5a 按计费模式切库

`PortraitLibraryPage` / `PortraitPickerModal` 的数据源按 `billingSource` 切：
`platform` → 平台库，`own-key` → vvdance 库。UI 形状不动。

`Hidden` 过滤**必须在展示层**，严禁在 store 层——
store 那个数组同时用于解析已有引用的 `asset://`，在 store 过滤会让已有引用直接失效。

### 5b 三个删除动作要分开

「移出素材库」（软删）/「从回收站恢复」/「彻底删除」语义完全不同。
文案写「移出素材库」而不是「删除」，否则用户会困惑为什么删了还提示素材过多。

**不要做乐观删除**——等响应回来再改本地状态。软删失败会返 500，
乐观移除会让用户以为删了、刷新后素材复活。

判失败要**同时看 rejected 和 `value === false`**（store 层把异常吞成 `return false`，
`Promise.allSettled` 永远 fulfilled）。

### 5c 一键搬家 —— ❌ 已决定不做（2026-08-29，用户拍板）

双库并存已经能用，缺的只是「历史素材要手动重新加一次」。不做的代价有界，
而做的成本有一个**没探过的前置未知**：

> 平台库只收 URL、要上游火山自己去公网拉。如果 vvdance 库里那些素材的 URL 是
> **签名链**，搬过去要么当场拉不到、要么登记成功但过一阵变裂图。
> 无签名永久链才搬得动；签名链就得先下载、再走 `upload-media` 传字节——
> **工作量差一倍**。

重新捡起来之前，先探一条 vvdance 素材的 URL 长什么样，再决定走哪条。

以下为原设计，留档：



读 vvdance 列表 → 逐个 `registerAsset` 到平台 → 重建本地 ID 映射。
要有并发闸（3–5）、失败可重试、明确告诉用户搬到了哪个 pool。

### 5d 顺手捡的优化

网页版把原图 URL 直接塞 `<img>`，40MB 原图的缩略图也下载完整 40MB。
URL 是我方 COS 域名时拼 `?imageMogr2/thumbnail/400x`，
能把首屏流量降一到两个数量级。**只在 COS 域名上拼**，外链拼了会 404。

### 5e 本地缓存

服务端 Redis 缓存在素材超 500 条后永久命中不了（缓存存 500，前端要 2000，
命中条件恒不成立），首屏会退化成最多 20 次串行上游调用、30 秒。
桌面端自建本地缓存，别指望服务端那层。

---

## Task 6：真网关烟测

> ✅ **降级（2026-08-29 探测）：最坏情况已排除，不再是阻断级。**
>
> 免费对照实验（无需 token、无需出片）：
>
> | 路径 | 结果 |
> |---|---|
> | `/v1/definitely-not-a-route-xyz123` | **404** `Invalid URL` |
> | `/v1/videos/probe-id` | **401** `Invalid token` |
> | `/v1/video/generations/probe-id` | **401** |
> | `/v1/models`（已知存在，对照） | **401** |
>
> 那条 404 证明「不存在的 `/v1` 路径在鉴权之前就被路由层 404」，
> 所以 **401 = 路由已注册**。我们用的 `/v1/videos/{id}` 存在。
>
> **仍未证明**：`POST /v1/video/generations` 建的任务能否从 `GET /v1/videos/{id}` 查到
> （两条路由都在，谁服务我们的任务还没验）。但那已经是「一次烟测 + 一个现成的
> `queryPath` 覆盖开关」的事，不再是「可能扣了钱永远查不到」。

> 🚨 ~~**这一条现在是阻断级的，不再是「顺带确认」。**~~（已按上面降级）
>
> 接线（`273aa918`）之前，网关那条路是死代码，轮询路径哪条对都无所谓。
> **接线之后它活了**：走平台余额出的片可能提交成功、**扣了钱**，却永远轮询不到，
> 卡片熬满 30 分钟再落一句「轮询超时」。
>
> **在这条证实之前，不要让用户用平台余额出视频。**

**第一个要撞的**：轮询路径。wan3 打 `/v1/video/generations/{id}`，
参考实现打 `/v1/videos/{id}`。拿一个真 taskId 分别打两条，看哪条回得出来。

好消息是不用改代码重编译：`SEEDANCE_GATEWAY_QUERY_PATH` 是导出常量，
客户端接受 `queryPath` 覆盖，有一条用例钉住这个覆盖能力。

其余：提交 → queued → running → 取到地址；`asset://` 在 `doubao-seedance-2*` 上真的生效；
`vvdance-*` 是否真的拒 `asset://`（这条一直是注释来源，顺带证实）。

**还要拉一次网关模型目录，逐个核对别名。** §4.4c 写「`2.0-mini` 网关侧没有对等物」，
但那条的依据只是 shortdrama 的 `VIDEO_MODELS` 只列了三个——**「参考实现只选了三个」
不等于「网关只有三个」**。而 `DEFAULT_TRANSPORT_BY_ALIAS` 里 `2.0-mini` 是 `'seedance'`，
平台模式下会被路由去网关，若目录里真没有它，用户拿到的是一句
`model_not_found` 而完全想不到成因。

拉到目录之后：目录里没有的别名要么在平台模式下不可选，要么在分派处显式排除。

**烟测别挂死端口的 MCP**——rmcp 重试会卡死 thread/turn start（踩过）。

---

## 一条被讨论过并否掉的收紧（留档，别重开）

接线之后有人会想把 `VideoTransportRegistry.seedanceGateway` 从可选收紧成**必填**，
用类型堵死「忘了注册」。**否掉了**，三条理由：

1. 那条 throw 已经是**正确、响亮、不花钱**的失败，改成编译期只是把一个本来就吵的错挪个地方。
2. 现有那两条**专门记录抛错行为**的测试会被迫写成 `as unknown as VideoTransportRegistry` ——
   类型说「不可能发生」、测试说「发生了长这样」。
3. **必填字段可以被填错。** `seedanceGateway: registry.seedance` 能过编译，
   而那正是「记账写着平台余额、实际扣自填 Key」那个静默灾难分支；
   可选字段的缺席只会产生响亮的那一种。

真正的风险是「第三个构造点忘了注册」，那由 `billingWiring.test.ts` 直接守 ——
它比必填更贴题，也顺带守住了「两处 registry 都注册了」而不只是「类型上有这个字段」。

## 已知缺口（做了但没做到底）

**MIME 白名单没有共享。** 后端有 13 种白名单，渲染层**刻意没抄**——
抄一份必然与后端各自漂移，而漂移的症状是客户端拒掉一个后端本来收的文件。
渲染层现在只拦「压根不是图/音/视频」。

代价：一个 40MB 的 `.webm` 仍会白跑一次 IPC 拷贝，才在主进程被拒。
**终局做法是把白名单从 `platformAssets` 导出来、渲染层共用同一份**，
而不是在渲染层再写一张表。

## 不在这次范围内

- Electron fuses（需真打包，另开）
- capacity 显示（平台无对等端点，先隐藏；`Truncated` + 「清理回收站」是它的替代品）
- group 相关的四条路由（前端零调用，后端懒创建，桌面端完全无视）
