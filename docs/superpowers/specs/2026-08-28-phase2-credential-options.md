# 第二期凭据方案：两层派生 token（A） vs 直接下发影子 token（B）

日期：2026-08-28
状态：**待决策**
背景文档：`2026-08-27-account-quota-design.md`（第二节选定了 A，本文是对 B 的正式评估）

---

## 0. 要回答的问题

第一期已经能登录、看余额、切池、看明细、充值，但**出图不花那笔钱**。要让它花出去，桌面端得拿到一枚能扣该用户计费池的网关凭据。

争点**不是**「影子账号有没有额度」——它有。争点是：**把哪一枚凭据、以什么形态、交到客户端手里。**

---

## 1. 共同的事实基线（都有代码证据，两个方案都绕不开）

### 1.1 现有影子 token 长什么样

```400:419:D:\tecx\text\25\soraui_4.0\new-api\service\allocation.go
	token := model.Token{
		UserId:         newUser.Id,
		Key:            tokenSuffix,
		Name:           fmt.Sprintf("个人配额-%d", projectId),
		Status:         1,
		UnlimitedQuota: true,
		CreatedTime:    time.Now().Unix(),
		ExpiredTime:    -1,
	}
	// …
	alloc := &model.PersonalAllocation{
		PlatformUserId: platformUserId,
		ProjectId:      projectId,
		NewapiUserId:   newUser.Id,
		NewapiTokenKey: "sk-" + tokenSuffix,
		IsActive:       true,
	}
```

三个关键属性：

| 属性 | 值 | 含义 |
|---|---|---|
| `ExpiredTime` | **`-1`** | 永不过期 |
| `UnlimitedQuota` | `true` | 不设子预算，直接吃钱包余额 |
| `NewapiTokenKey` | 存在 `PersonalAllocation` 行上 | 创建一次，之后**永久复用**同一个字符串 |

每个 `(platformUserId, projectId)` 只有这一枚。

### 1.2 这枚 token 现在有谁在用

| 消费方 | 位置 | 形态 |
|---|---|---|
| sora-ui-backend 的出图 relay | `imageRelayController.ts` | 服务端持有，替用户发请求 |
| sora-ui-backend 的项目成员校验 | `utils/projectAuth.ts:59` | 「能取到 token」= 有此项目权限 |
| shortdrama | `lib/billing/allocation.ts:58-92` → `lib/gateway/client.ts:60` | 服务端持有 |
| Python 后端 | 同一个 `/api/internal/allocation` | 服务端持有 |

**四个消费方全部在服务端。** 至今没有任何客户端持有过它。

### 1.3 取它需要一把万能钥匙

```5:9:D:\tecx\text\shortdrama-mvp\src\lib\billing\allocation.ts
 * New API keeps a per-(user, pool) shadow account, and its token is what makes
 * a generation land on that account's balance instead of the shared one this
 * app used to send everything through. Asking for it is a privileged call —
 * `INTERNAL_API_KEY` will mint a token for *any* platform user id — which is
 * why the id here comes only from a verified session and never from a request
```

`X-Internal-Key` 能为**任意** platform user 铸 token。所以无论 A 还是 B，桌面端都**不能**直接打 `/api/internal/allocation`，必须经 sora-ui-backend 加一层「userId 只从 JWT 取」的封装。

> **这一层是两个方案共有的，不构成 A 相对 B 的成本。**

好消息：底下的机器已经写好了。`newApiService.getUserToken(userId, projectId, producerProjectId)` 带 10 分钟 Redis 缓存、个人计费的 `auto_provision`、以及 `not_allocated` / `unavailable` / `found` 的结构化结果。

### 1.4 桌面端今天的实际形态

```1294:1297:src/renderer/src/services/api/ApiService.ts
    const apiKey =
      effectiveSiteKey === this.currentSite ? this.apiKey : this.getStoredApiKey(effectiveSiteKey)

    if (!apiKey) {
```

- 网关请求**由渲染进程发起**
- key 明文存 `localStorage[api_key_<site>]`（`:3153` 写、`:3229` 读）
- `:1297` 那个 `if (!apiKey)` 早退守卫，任何方案都要改（否则「已登录但没填 Key」会被它挡住）

**所以「把凭据挪进主进程」意味着把请求发起方也挪进主进程。这是客户端侧的大头，且 A 和 B 完全一样。**

---

## 2. 两个方案

### 方案 A —— 两层 token（`2026-08-27` 设计文档的选定方案）

长期的 allocation token 留在服务端不动；新增一个内部端点，在**同一个影子用户**（同一个钱包）上另铸一枚带 `expired_time` 的 Token 行下发给桌面端。

派生 token 的字段（照 §1.1 那段模板改两个值）：

| 字段 | 取值 | 原因 |
|---|---|---|
| `UserId` | `alloc.NewapiUserId`（**已有**，不新建用户） | 同一个钱包 |
| `ExpiredTime` | `now + N` | 泄漏窗口以分钟计 |
| `UnlimitedQuota` | `true` | 与钱包共用额度；设 `false` 会被 0 子预算拦死 |
| `RemainQuota` | **不设** | 会和充值打架 |

### 方案 B —— 直接下发现有影子 token，但只存主进程

不改 Go。sora-ui-backend 的封装端点直接把 `newApiService.getUserToken` 的结果回给桌面端；桌面端存进 `safeStorage`（照 `services/auth/credentials.ts` / `seedance/credentials.ts` 的既有样板），只在主进程使用，绝不下发渲染层。

---

## 3. 工作量对比

| 工作项 | A | B |
|---|---|---|
| sora-ui-backend：带 `authMiddleware` 的封装端点（userId 只从 JWT 取、projectId 先核可用列表、个人落点例外） | 要 | **要** |
| 桌面端主进程：`gatewayToken.ts`（safeStorage、按 `(projectId, producerProjectId)` 一对做缓存键） | 要 | **要** |
| 桌面端：把网关请求发起方从渲染层搬到主进程 | 要 | **要** |
| 渲染层：改分流点 `ApiService.ts:1294-1297` + 音频/理解两处、回退不静默、模式持久化 | 要 | **要** |
| new-api（Go）：新增铸派生 token 的 handler | **要** | 不要 |
| 主进程：近过期提前刷新 + 401 被动刷一次 | **要** | 不要 |

**B 只省下最后两行。** Go 那个 handler 不动数据模型（`tokens` 表的列全在，§1.1 就是现成模板），刷新逻辑约百行带测试。**B 省下的不是「一个方案」，是大约一天的活加一轮部署。**

---

## 4. 风险对比

两者共同的前提：凭据只在主进程、`safeStorage` 加密落盘、不进 localStorage、不进渲染层。在这个前提下比较**剩余风险**。

| | A | B |
|---|---|---|
| 泄漏后的可用窗口 | N 分钟 | **永久** |
| 能否只吊销泄漏的那一份 | 能（等它过期即可，或让服务端拒绝续发） | **不能** |
| 吊销的副作用 | 无 | **同时弄断该用户的网页出图**（`imageRelayController` 读同一枚）、项目成员校验（`projectAuth.ts:59`）、shortdrama、Python 后端 |
| 用户能否自查/自轮换 | 无所谓（短命） | **不能**——他根本不知道这枚 token 存在 |
| 规模 | 每台机器持有的是短命票据 | **每个用户的机器上躺一把永久钱包钥匙** |

### 4.1 B 的致命点不是「会不会漏」，是「漏了之后没有动作可做」

安全设计的问题从来不是「能不能防住」，而是「出事那天你能做什么」。

B 的答案是：**没有单独的动作。** 唯一能作废那枚 token 的办法是废掉 `PersonalAllocation` 行，而那一行同时是：
- 网页端替这个用户扣费的凭据
- 「他是不是这个项目的成员」的判据（`projectAuth.ts:7-9` 明确把「能取到 token」当作成员资格证明）

所以「某个用户的桌面端 token 泄漏了」这件事，在 B 下的处置是「把他踢出项目并弄坏他的网页端」。这不是一个可以在事故当天执行的动作。

### 4.2 要公平记的一笔：应用今天本来就握着能花钱的 key

用户粘进设置的 Miau key 就是。所以「桌面端持有花钱凭据」不是新增风险。变的是四样：

1. **永不过期**（今天那把也是长期的，但——）
2. **用户不可见**：今天那把是他自己粘的，知道它在、能去控制台换；allocation token 是隐形基础设施
3. **和服务端共用同一枚**：今天那把只影响他自己在桌面端的用量，allocation token 是网页端也在用的那一枚
4. **规模**：今天是「愿意折腾的人自己粘一把」，登录铺开后是**默认每个用户都有一把**

第 3 和第 4 是质变，不是程度差别。

### 4.3 A 的残余风险（不吹）

- N 分钟内泄漏仍可被花掉。选 N 是在「刷新频率」和「泄漏窗口」之间取舍。
- 主进程被完全攻陷时，攻击者可以持续续期——A 挡的是「凭据副本流出」，不是「机器被控」。
- 设计文档附录已记账：**A 相比 relay（token 永不出服务器）仍多担风险**。A 是「直连」这个既定形态下的补偿措施，不是最安全的形态。

---

## 5. 推荐

**选 A。**

理由不是「A 更安全」这种泛泛之词，而是 §4.1 那一条具体的：**B 没有事故处置动作。** 一个安全属性如果在出事当天不能被执行，它就不存在。

次要理由是 §3：B 省下的比看起来少得多。两个方案共用四项工作中的四项，B 只省 Go handler 和刷新逻辑——约一天加一轮部署。用「永久且不可单独吊销的钱包钥匙铺到每台机器」去换这一天，账不划算。

### 什么情况下我会改推荐

- **如果 new-api 无法改或无法部署**——那 A 不可行，讨论的就该是 B vs relay（第三条路），而不是 A vs B。
- **如果桌面端只在你自己和少数几个人手里用**，第 4 点（规模）不成立，B 的账会好看很多。**这一条需要你确认**：这个应用预期发给多少人？
- 如果能接受放弃直连，**relay 比 A 和 B 都安全**（token 永不出服务器，且 `imageRelayController` 已经存在）。代价是图片负载多走一跳。

---

## 6. 如果最终选 B，最小止血措施

按重要性排序，前两条是底线：

1. **凭据只在主进程，`safeStorage` 加密落盘，绝不经 IPC 下发渲染层。** 渲染层只能看到派生状态（「有没有可用额度」），拿不到字符串本身。
2. **绝不写进任何日志/错误上报/崩溃转储。** 现有 `AuthError` 的日志路径要逐条审一遍——`session.ts` 的 `fail()` 曾经把整个响应体打进日志。
3. 在 new-api 侧给这枚 token 加 `model_limits`，收窄到桌面端实际会调的模型。不碰账目，但把泄漏后的可用面缩小。
4. 记录并向用户暴露「最近一次使用的设备/IP」，让异常可被本人发现——这是 B 下唯一可能的用户侧自查手段。
5. 在文档和 UI 里明说「登录后本机会保存一枚长期凭据」，让用户在共用电脑上能自己决定不登录。

---

## 7. 待你确认的两件事

1. **new-api 能不能改并部署到测试服？** 这决定 A 是否可行。
2. **这个桌面端预期发给多少人？** 只有你和几个同事，与要发给外部用户，是两个不同的风险量级（§5 第二条）。
