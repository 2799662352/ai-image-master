# 桌面端使用登录账号额度 —— 设计

状态：方案已定，待实施
前序：`2026-08-25-desktop-browser-login-design.md`（浏览器登录，已落地）

登录已打通，桌面端主进程里有一枚 sora-ui-backend 签发的 JWT。本文解决下一步：**让出图花账号余额，而不是只能花用户自填的第三方 Key**。

形态目标：**像 Codex 一样，客户端直接打 API，中间不经自己的服务器。**

---

## 零、术语：`unlimited_quota` 不是「无限额度」

这个字段名在评审中反复造成误解，先钉死口径，全文按此使用。

`tokens.unlimited_quota = true` 的含义是 **「这枚 token 不带自己的独立子预算」**，不是「这枚 token 能无限花」。花钱的检查与扣减都落在影子用户的**钱包**（`users.quota`）上 —— **钱包就是有效额度**。

检查逻辑（`new-api/service/quota.go:143-149`）：

```go
if userQuota < quota { ... }                                  // 钱包：永远检查
if !token.UnlimitedQuota && token.RemainQuota < quota { ... }  // 子预算：unlimited 时整条跳过
```

扣减行为（`new-api/service/video_task_billing_v2_test.go:229-238`，钱包 1000 / 子预算 50 / unlimited=true）：

```go
require.Equal(t, 900, loadUserQuota(...))         // 钱包被扣 100 ← 钱从这里出
require.Equal(t, 50,  loadTokenRemainQuota(...))  // 子预算未动
require.Equal(t, 100, loadTokenUsedQuota(...))    // 但 used_quota 照样计
```

由此得到两条贯穿全文的规则：

- **`unlimited_quota` 必须为 `true`** —— 不是「放宽限制」，而是让 token 与钱包共用额度。schema 里 `remain_quota` 默认 0、`unlimited_quota` 可空，不显式设 true 的新 token 会带着一个 0 的子预算，每次请求都被自己拦住报「token quota is not enough」。
- **`remain_quota` 绝不设** —— 充值走 `allocateOrgToPersonal` 进**钱包**，不进子预算。给 token 设子预算会造出「充了钱反被自己拦住」的 bug，且报错指向 token、不指向充值链路，极难排查。

> 全文不用「无限额度」这个说法。说 token 的限制时用「不带独立子预算」；说花钱上限时用「钱包余额」。

---

## 一、事实基线

实测确认（测试服 `http://43.161.233.87`，401 = 存在且需鉴权）：

```
GET  /api/user/organizations             401   组织列表，带 balanceYuan / joined / producerProjectId
GET  /api/user/balance?projectId=1       401   { balance_quota, balance_yuan }
GET  /api/user/quota                     401   按次/按秒配额（第二道闸）
GET  /api/user/usage-logs?projectId=1    401   用量明细
GET  /api/user/usage-summary?projectId=1 401   用量汇总
GET  /api/payment/config                 401   个人计费落点 project id
POST /api/relay/v1/images/generations    401   出图代理（本方案不用，见附录）
```

拓扑（测试服与生产同构）：

| 角色 | 测试服 | 生产 |
|---|---|---|
| 身份后端 | `http://43.161.233.87` | `https://13797248455.xyz` |
| New API 网关 | `http://43.161.233.87:3000` | `https://miauapi.13797248455.xyz` |

**网关只认 New API 的 `sk-...` token，不认平台 JWT。** 所以必须有一步「JWT → 网关凭据」的交换。

### 桌面端现状

- 出图请求由**渲染进程**直接 `fetch` 网关（`ApiService.ts:2028`），带 `Bearer <用户自填 key>`，key 明文存 `localStorage['api_key_antigravity']`。
- 「本次请求用哪个 Key」全仓只有一处决策：`ApiService.ts:1280-1281`（音频 `:1379-1380`、理解 `:3221-3222` 同构）。**这是唯一的分流点。**
- JWT 只在主进程（`safeStorage` → `auth-credentials.bin`），渲染层拿不到 —— `src/types/authApi.ts` 在类型层面就没有那个字段。
- CSP 的 `connect-src` 有裸 `https:` 通配，测试服的明文 `http://43.161.233.87:*` 也已放行。**不需要改 CSP。**
- `will-navigate` 只允许同源与 `file:`，所以「充值」必须走 `shell.openExternal`。

### 能走账号额度的模型

前提是模型在 Miau 网关上（账号余额在 Miau 的 New API 里）。桌面端 14 个模型中：

| 模型 | 打哪 | 能否走账号额度 |
|---|---|---|
| `wan2.7-image-pro` / `gpt-image-2` / `gpt-image-2-all` / `gpt-image-2-vip` / `gemini-3-pro-image` / `gemini-3.1-flash-image` / `doubao-seedream-5-0-pro-260628` / `custom-imagemodel-gt` / `qwen-image-3.0-pro` | Miau | **能**（9 个） |
| `flux-kontext-max` / `flux-kontext-pro` / `gemini-2.5-flash-image` / `seedream-4-5-251128` / `sora_image` | `b.apiyi.com` | **本就不可能** —— 不在 Miau 计费体系内，是用户在 API易 花自己的钱 |

直连方案不受后端 `imageModelManifest` 约束（那道约束只存在于 relay 路径），所以 Miau 系 9 个全部立刻可用。

### 人像库不受影响

CATIMATION 直连 Seedance（`vvdance.ai/api/open/v1/local-assets`），用独立的 API Key + HMAC 签名，全链路无 project 参数，本地 `portrait-library-overlay.json` 也无归属字段。**切换计费组织不会让 `asset://` 失效，UI 不需要警告。** 另外 `asset://` 只进视频链路，图片生成明确禁止 prompt 里出现 asset id —— 两个面不重叠。

（参考项目 shortdrama 的按池隔离来自 sora-ui 平台代理层，CATIMATION 绕过了它。真正会让资产失效的是换 Seedance 站点或换 Seedance 密钥，那条轴已有提交前全库校验 + 中文错误映射兜住。）

---

## 二、选定方案：Codex 式两层 token

### 为什么必须两层

不能直接给现有的 allocation token 加期限。它是 `PersonalAllocation.NewapiTokenKey` 存下来、创建后永久复用的那一枚（`new-api/service/allocation.go:400-419`），BFF relay、shortdrama、Python 后端全都通过 `/api/internal/allocation` 读它。给它设短 `ExpiredTime`，这三条服务端链路会在到期后一起断掉。

所以走 Codex 自己的结构：

| | Codex | 本方案 |
|---|---|---|
| 长期凭据 | refresh token | **allocation token**（`sk-pa...`）—— 只在服务端用，永不下发 |
| 短命凭据 | access token，5 分钟窗口提前刷新 | **派生 token** —— 挂在同一个影子用户上（同一个钱包），带 `expired_time` |

派生 token 的字段设置：

| 字段 | 取值 | 原因 |
|---|---|---|
| `expired_time` | `now + N` | 这是 Codex 语义的关键，泄漏窗口以分钟计 |
| `unlimited_quota` | **`true`** | 与钱包共用额度；不设会被 0 子预算拦死（见第零节） |
| `remain_quota` | **不设** | 会和充值打架（见第零节） |
| `model_limits` | 可设 | 收窄可调模型，不碰账目 |
| `allow_ips` | 不设 | 桌面端用户 IP 动态，无意义 |

**不动现有的 allocation token，所以什么都不会坏。**

### 由主进程发请求，不是渲染层

「直连网关」这个形态本来就是既有的 —— 但**现在是渲染进程直连**（`ApiService.ts:2028` 自己 `fetch` 网关，key 明文存 localStorage）。走账号额度时要把发起方**移到主进程**：

| | 谁做 | 凭据在哪 |
|---|---|---|
| 换 token | 主进程向 sora-ui-backend 换本人的派生短命 token | 主进程 safeStorage |
| 打网关 | **主进程** `net.fetch` 直连 `miauapi.../v1/images/generations` | 渲染层永不接触 |
| 结果回传 | IPC 把图递给渲染层 | — |

这就是 shortdrama 的信任边界 —— 它的浏览器也拿不到 key，调用由服务端发起。**Electron 主进程扮演它服务器的角色**，同时保留「客户端直连 API、不经自己的后端」这个 Codex 形态。

URL、请求体、重试、超时全部沿用现有实现，只是搬到主进程执行。

#### IPC 开销：实测可忽略

曾以为「一张 4K 图 10–40 MB 的 base64 过 IPC」会是阻碍。实测（V8 structured clone，与 Electron IPC 对字符串用的同一套序列化器）：

| 载荷 | serialize+deserialize | MessageChannel 往返 |
|---|---|---|
| 10 MB | 7.7 ms | 7.6 ms |
| 20 MB | 14.7 ms | 19.3 ms |
| 40 MB | 31.0 ms | **39.1 ms** |

一次出图至少 20 秒，所以 40 MB 的开销占 **0.155%**。线性增长，无非线性坍塌。未测但可判断的两项：管道字节传输（本机内存拷贝，量级与序列化相当）、渲染层多持一份的 40 MB 内存峰值（对已在跑 tldraw 画布的应用不构成压力）。

> 教训：这个理由当初是凭「40 MB 听起来很大」估出来的，没量，因此差点否掉一个更安全的设计。

### 归属头由主进程设置

```
X-Platform-User-Id: <userId>
X-Project-Id: <projectId>
X-Feature: image_gen
```

少了它们 `logs.platform_user_id` 为空，用户在「使用明细」里看不到自己的消耗 —— **漏了不报错**，是最容易忽略的一处。

由主进程设置的额外好处：渲染层伪造不了归属。这消掉了「客户端可自报归属」那笔债。

---

## 三、两道互相独立的闸

| | 归属 | 口径 | 查询 | 不足时 |
|---|---|---|---|---|
| 按次/按秒配额 | sora-ui-backend 的 `User.quotaLimit` / `durationLimit` | 次数、秒数 | `GET /api/user/quota` | BFF 业务码 |
| ¥ 余额 | new-api 影子用户钱包 `users.quota` | 金额 | `GET /api/user/balance?projectId=` | 403 `insufficient_user_quota` |

把两者混成一句「额度不足」，用户会去充值，而真正拦住他的可能是次数配额 —— 充了也没用。

**直连下按次配额不会自动生效**：它挂在 BFF 的 `authMiddleware` 之后，直连不经过 BFF。第一期把它读出来展示（让用户看得见），但它拦不住出图。若产品上要求它必须硬拦，出图就得回到 relay —— 属方案取舍，不是实现细节。

---

## 四、金额精度

- 换算：**500000 quota = ¥1**（`new-api/constant/org.go:40`）。展示时除，不要自己造系数。
- 影子账户 `users.quota` 是 **int32**，物理上限约 **¥4294.96**，所以后端把单笔充值卡在 ¥4000（`payment.ts:25-28`）。
- 响应字段两种拼法都要认：`balance_yuan` 与 `quota_yuan`。

---

## 五、组织（计费池）

- 池的键是**一对**：`(projectId, producerProjectId)`。两个 producer project 可共用一个 `projectId`，只存前者会把两个池悄悄合并、钱记错地方。
- 「个人计费」是一个**真实的 PROJECT 级 org 记录**，id 由后端 `GET /api/payment/config` 下发（env `PERSONAL_BILLING_PROJECT_ID`）。**不要硬编码。** 它刻意不出现在用户的 joined 列表里。
- 可用池列表：`GET /api/user/organizations`。响应里的 `role` 是后端硬编码的 `'member'`，无信息量。
- 后端以「该用户在该项目下有 allocation 行」为授权依据，不查成员表。桌面端不需要自己校验，但**也不要替用户猜项目** —— 必须显式选择。
- **换池必须立刻作废缓存的派生 token**，否则切换后还能再花一笔旧池的钱。

---

## 六、分期

### 第一期 —— 看得见（后端零改动）

目标：登录后能看到余额、能选组织、能去充值。不改出图链路。**它是第二期的前提** —— 要传 `projectId` 换 token，得先有组织选择。

**主进程** `src/main/services/auth/session.ts` 新增导出，全部复用现成的 `sendJson`（已用 `net.fetch`、已处理超时与两套错误信封）：

- `fetchOrganizations()`
- `fetchBalance(projectId)`
- `fetchQuota()`
- `fetchPaymentConfig()`

> ⚠️ **必须独立节流，不要塞进 `probeLiveness`。** 现有存活探测刻意**不传** `projectId`，靠后端在 `userOrg.ts:138-143` 提前 400 短路、**在触达 newApiService 之前**返回，所以零外部依赖。一旦真传 projectId 查余额，这条路径就会真打 New API —— 探测的成本假设随之失效。两者用不同的函数和不同的节流窗口。

**契约**写进 `src/types/authApi.ts`（三边同吃一份，别在 preload 里另 declare —— `AgentApi` 已为此吃过一次教训）。

**IPC**：`ipc.ts` 的 `AUTH_CHANNELS` 加通道并在 `registerAuthIpc` 注册。该数组是卸载时逐个 `removeHandler` 的依据，**漏加会导致热重载后 handler 泄漏**。

**UI**：`AccountSection.tsx` 已登录分支的卡片里加余额行 + 组织选择器 + 「充值」主按钮（走 `shell.openExternal`）。样式严格跟随该文件既有的赛博朋克 token，不引入字面 hex。

> `src/renderer/src/pages-react/settings/__tests__/` **目前不存在**，`AccountSection.tsx` 没有测试。第一步是按 `useAuthStore.test.ts` 的 `Object.defineProperty(window, 'electronAPI', ...)` 范式把它建起来。

### 第二期 —— 花得出去

**new-api（Go）**：新增内部端点，在已有影子用户上建一枚带 `expired_time` 的 `Token` 行（字段按第二节的表）。`tokens` 表的列全都有，是新增端点而非改数据模型。可选：过期行清理（`deleted_at` 列已存在）。

**sora-ui-backend**：一层带 `authMiddleware` 的封装。三条硬约束，照 shortdrama 的 `selection/route.ts` 抄：

1. **`platformUserId` 只从 JWT 取，绝不从请求体/查询串读。** 这是安全支点 —— 上游 `/api/internal/allocation` 能为任意 id 铸 token。
2. **请求的 projectId 要先核过用户的可用列表再放行**，核不了返回 503 而不是「大概没问题」地放过。shortdrama 的注释值得原样引用：*"'likely' is not the standard for the one call in this app that spends somebody's money."*
3. **个人计费落点例外**：它刻意不在 joined 列表里，需按 `PERSONAL_BILLING_PROJECT_ID` 单独放行。

**CATIMATION 主进程**：新增 `src/main/services/auth/gatewayToken.ts`：

- 缓存按 `(projectId, producerProjectId)` 这**一对**做键（RFC 8693：按 subject + audience 做键；只按用户做键会把为 A 铸的 token 交给 B）。
- 按 Codex 的 **5 分钟近过期窗口**提前刷新，401 时被动刷一次。
- **非 2xx 绝不写缓存**（Codex 的 `server.rs` 就是这样：非 2xx 立刻 `return Err`，`ExchangedTokens` 压根不构造）。
- 提供**显式强制刷新**入口（对齐 Codex 的 `account/read { refreshToken: true }`）—— 用户刚充值完、或刚切换组织时需要。

**CATIMATION 渲染层**：

- 分流点 `ApiService.ts:1280-1281`（+ 音频、理解两处），跟着改后面的 `if (!apiKey)` 早退 —— 否则「已登录但没填 Key」会被那个守卫挡住。
- 补归属头（见第二节）。
- 模式持久化：一个偏好位（如 `preferred_credential_mode`）。参考 `seedance/credentials.ts` 的主进程 safeStorage 样板。
- **回退绝不静默**：「请重新登录」/「余额不足」/「本次改用你自己的 API Key」三种状态分开呈现 —— 三者的用户动作完全不同。
- 顺手的低风险重构：`makeApiRequest` 里 `Bearer` 拼接散在 8 处。归属头要加到所有走账号额度的路径上，不收口就得改 8 个地方。抽一个 `buildAuthHeaders(site, credential)` 出来，现有 16+ 个 `ApiService.*.test.ts` 会兜住回归。

---

## 七、从参考实现抄什么、反着做什么

### 从 shortdrama 的网关客户端抄（`src/lib/gateway/client.ts`）

**按幂等性分类重试，而不是按「像不像瞬时故障」。** 判据是「这次请求到底跑没跑」：

- 网关**答了**（408/425/429/5xx）→ 请求被收到并拒绝，什么都没生成，重发无条件安全。
- 连接**压根没建起来** → 请求体一个字节都没出去，重发无条件安全。
- 连上后 socket 断了、或自己的超时先炸 → **分不清**「网关没收到」和「收到了但回复丢了」。出图重发只浪费一次生成；**视频提交重发会造出第二个计费任务且 id 不可恢复**（跑完、被扣钱、没人认领）。创建任务的调用要显式选择「宁可失败也不重发」。

**`PRE_SEND_CODES` 要走 `error.cause` 链。** undici 把 `ECONNREFUSED` 这类码挂在 `error.cause` 上，surface 出来的只是 `TypeError: fetch failed`。只看顶层会把「连接从未建立」误判成「不确定」，白白放弃一次安全重试。

**限流退避要比别的久。** 网关对超额并发回 429 而不排队，而一个并发槽要等**别人的生成结束**才释放，量级是「一整次生成」。shortdrama 给 `rate_limit` 的上限是 60 秒，`server_error` / `transport` 是 20–30 秒。

**它的进程级全局并发闸在我们这里反而是对的。** shortdrama 那个 `let active = 0` 是模块级、全体用户共享，在服务端是缺陷（一个人提交 50 张图会饿死别人）。桌面端单用户单机，**进程级恰好等于用户级** —— 直接照抄。

### 从 Codex 源码抄（`codex-rs/`）

**凭据存储：我们已经对齐，不用改。** Codex 在 Windows 默认走 `Secrets` 模式 —— `auth.json` 存成加密文件 `codex_auth.age`，只有加密口令进凭据管理器。本仓用 Electron `safeStorage` 写 `auth-credentials.bin`，结构等价。

> 一个我们没做的细节：Codex 的 keyring 账户名由 **home 路径的哈希**派生（`cli|<sha256 前 16 位>`），所以多份安装不会互相踩。本仓凭据文件在 `userData` 下、不按路径区分 —— 单实例无碍，将来支持多 profile 要补。

**绝不持久化一次失败的交换**（`login/src/server.rs`）：非 2xx 立刻 `return Err`，`persist_tokens_async` 不调用。

**要有显式的强制刷新入口**（`account/read { refreshToken: true }`），而不是只靠 TTL 到点。

**「需要重新认证」要是显式状态**，不是静默失败。Codex 在凭据过期且刷不动时给出明确的 reauth 原因，让客户端提示用户重连。

### 反着做：shortdrama 的静默回退

它在拿不到额度时**静默回落到平台共享密钥**（`gateway/client.ts:60` 的 `?? process.env.GATEWAY_API_KEY`），三种情况触发：未选池、internal 端点不可达、用户在该池无配额。生成照样成功但**钱由平台付**，用户端零提示 —— 只要能让那个端点超时就能薅免费额度。它自己注释里写了「不能静默」，但实现只做到打一行 `console.warn`。

**本方案的回退必须显式。** 不做「悄悄换付款人」。

---

## 八、刻意不做

- **视频走账号额度。** v2 两段式计费（`HELD → SETTLED` + finalize 恢复）只在 BFF 内部可用（`/api/internal/*` 被内部密钥门守着），桌面端直连拿不到 reserve/settle 语义。要做只能走 BFF 转发，属独立一期。
- **org 级 API 分发密钥。** 那是**组织维度**的 key，背后是独立影子用户，不是登录用户的个人余额；其消费不带 `platform_user_id`，**不会出现在用户的「使用明细」面板**。与「用我的账号额度」是不同的产品语义。
- **人像库跟账号走。** 需要给本地叠加层找一个后端家（加表 + 同步 + 冲突解决），与本次无依赖。前序 spec 已裁定。
- **`X-Internal-Key` 进客户端。** 它能为任意 `platform_user_id` 铸 token。桌面端只能向 sora-ui-backend 索取**自己**那把，用户 id 从 JWT 取。

---

## 九、已知的上游脆弱点

记下来，不是本次要修，但排障时会撞上。

- **`probeLiveness` 的零成本假设依赖后端的校验顺序**（projectId 校验早于 New API 调用）。后端若调换，探测会变成每 60 秒打一次 New API。
- **new-api 原生充值（`top_ups` / `redemptions`）与 org 体系的 `balance_transaction` 之间没有一致性校验。** 若有人用 new-api 面板直接给影子用户加钱，`organization.balance` 与流水不会有对应记录，月度对账会对不上。
- **`api_key` 表没有 scope / expiry 列**，只有 `is_active`。scope 能力在 `tokens` 表上，但 org key 创建时没用。

---

## 附录：走过的弯路（防止重犯）

评审中反复了两次，两个错误都在文档阶段发现、未进代码。记在这里。

### 弯路一：以为可以直接给 allocation token 加期限

那枚 token 是 `PersonalAllocation.NewapiTokenKey` 永久复用的，BFF relay、shortdrama、Python 后端三条服务端链路都读它。加期限会在到期后把三条一起弄断。**修正**：改用两层结构（第二节）。

### 弯路二：把「学 shortdrama」等同于「直连」

shortdrama 的链路是：浏览器**手里一点凭据都没有** → 后端持 `X-Internal-Key` 换影子 token → **后端**打网关 → 图片返回浏览器。客户端零凭据。

所以「客户端持 token」**恰恰是 shortdrama 不做的事**，而 `POST /api/relay/v1/images/generations` 才是它那套架构（且已实现，还多做了预扣、回滚、COS、不可伪造归属）。

**最终没选 relay**，是因为产品上要的是 Codex 形态（客户端直连 API）。但当时用来论证直连的三个理由里有两个不成立，记下来免得再拿它们说事：

| 当时的理由 | 复核结果 |
|---|---|
| 模型集合会变小 | Miau 上只有 `qwen-image-3.0-pro` 需补一条 manifest 声明；另 5 个在 API易 上本就用不了账号额度 |
| 出图流量要穿过后端 | shortdrama 就是这么跑的且没问题；对当前规模不构成约束 |
| 要写适配层 | 实际是字段改名：`ratio`→`aspectRatio`、`count`→`imageCount`、`referenceImages`→`inputImages` |

还有一个错误前提：曾用「shortdrama 有服务器、我们没有」论证凭据必须落客户端。**`sora-ui-backend` 就是我们的服务器**，relay 也已经在上面。所以「凭据落客户端」是为了 Codex 形态而做的**主动取舍**，不是没得选。

**这笔债将来可以还**：把出图切回 relay 即可，不需要动 new-api。

### 弯路三：以为 IPC 传 40 MB 是阻碍

曾据此排除「主进程发请求」，转而考虑把 token 交给渲染层。实测 40 MB structured clone 往返 39 ms，占一次 20 s 出图的 0.155%（详见第二节）。**那个理由是凭直觉估的，没量。**

修正后采用主进程发起，因此消掉了两笔原本要记的债：归属头不再可被渲染层伪造，凭据不再落在渲染层。

### 记账：本方案相比 relay 仍多担的风险

- 派生 token 落在用户机器上（主进程 safeStorage）。有 `expired_time` 后泄漏窗口以分钟计，但**没有 Codex 那种一次性 refresh token 自带的泄漏检测**（拷到另一台机器不会被发现）。要有检测得另做，例如按设备记录签发、异常并发时告警。
- 没有 BFF 侧的预扣闸与成本估算 —— 网关自己的 pre-consume 仍在（`service/pre_consume_quota.go:38-43`，余额不足回 403），但拿不到 relay 返回的 `estimatedQuota`，所以无法在出图前告诉用户「这次大约花多少」。
- 按次/按秒配额不生效（第三节）。

> ⚠️ 一个容易被绕过的推理，写下来防止日后自我说服：**不能用「Codex 也把凭据交给客户端」为「用永久 token」背书。** Codex 交出去的是短命 + 可轮换 + 有 audience 的凭据；永久 token 泄漏后无声无息地一直有效直到人工撤销。这也正是本方案坚持两层结构、给派生 token 设 `expired_time` 的原因。
