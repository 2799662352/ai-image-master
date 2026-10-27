# 使用明细抽屉 + 原生充值（账号额度第一期收尾）

日期：2026-08-27
分支：`feat/account-quota-phase1`
前置：主进程额度查询、IPC、preload、`useQuotaStore`、`AccountSection` 已落地（`a7afe428` / `a1a22e0f` / `545af4f7` + 未提交的 AccountSection）

---

## 0. 为什么是这两件，以及为什么浮窗不在里面

放置问题的调查结论：这个应用有**三个互不相干的计费域**。

| 计费域 | 端点 | 密钥 | 账号余额相关 |
|---|---|---|---|
| Miau（new-api 网关） | `miauapi.13797248455.xyz` | 站点 key `antigravity` | **是** |
| VVDance | `vvdance.ai` / `vvdance.yongmuai.com` | 用户自填 `apiKey`+`apiSecret` | 否 |
| apiyi / rightcode | `api.apiyi.com` / `rightapi.ai` | 各自的 key | 否 |

证据：`ApiService.ts:507-514,578-580`、`gatewayModelRouting.ts:105-110`（Miau）；`seedance/region.ts:7-10`（VVDance）；`codexProviders.ts:26-47`（apiyi/rightcode）。

因此**常驻余额浮窗延后到第二期**，且届时只在花 Miau 钱的页面出现。第一期不上的硬理由不是排期，是正确性：今天应用出图用的 Miau key 是用户手填的，与登录账号之间**没有任何已验证的关系**，把账号余额挂在出图页等于把两个各自独立的余额显示成一个。第二期派生 token 落地后，出图用的 token 由账号签出，显示与扣费由构造保证同源，这个反对意见自动消失。

本轮只做两件与上述含糊性无关的事：设置页里的**使用明细抽屉**与**原生充值**。

---

## 1. 后端契约（已实测，不要重新推导）

### 1.1 `GET /api/user/usage-logs`

挂载：`app.ts:263` → `/api/user`；路由 `userOrg.ts:347`；鉴权 `authMiddleware`。

查询参数（**BFF 收 camelCase**，转发给 Go 时改名成 snake_case，`userOrg.ts:356-359`）：

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `projectId` | int | `0` | `0` = 不过滤 |
| `page` | int | `0` | **0 基**，`offset = page * pageSize` |
| `pageSize` | int | `20` | 硬上限 100 |
| `startTime` | int | — | **Unix 秒**，`>0` 才生效 |
| `endTime` | int | — | 同上 |

响应：`{ success: true, data: { logs: Log[], total, page, page_size } }`（`userOrg.ts:360`）。
`Log` 是 Go `model.Log` 整体序列化、**全 snake_case**、**未脱敏**（27 个字段，`log.go:21-50`）。排序固定 `id desc`。

本轮消费的字段：`id`、`created_at`(秒)、`type`、`model_name`、`quota`(int，退款为负)、`prompt_tokens`、`completion_tokens`、`feature`、`token_name`、`project_id`、`producer_project_id`。

log type 枚举（`log.go:53-61`）：`0 Unknown / 1 Topup / 2 Consume / 3 Manage / 4 System / 5 Error / 6 Refund`。

### 1.2 `GET /api/user/usage-summary`

路由 `userOrg.ts:372`。参数 `projectId` / `startTime` / `endTime`。
响应：`{ success: true, data: UsageSummary[] }`，元素 `{ total_quota, total_requests, total_tokens, model_name? }`（`log.go:355-360`），按 `model_name` 分组。

**后端不给顶层合计**，要前端自己 reduce。

### 1.3 充值三步

| 步 | 端点 | 说明 |
|---|---|---|
| 1 | `POST /api/payment/alipay/orders` | body 见下；响应 `{ok:true,data:{outTradeNo,payUrl,totalAmount,pointsAmount,status}}` |
| 2 | — | `shell.openExternal(payUrl)` |
| 3 | `GET /api/payment/alipay/orders/:outTradeNo` | 轮询至 `CREDITED` |

建单 body（`payment.ts:81-82`）：`{ amountCny, orderType, subject?, projectId?, producerId?, producerProjectId?, personal? }`
- `orderType` 本轮固定 `'balance_recharge'`
- 单笔上限 **¥4000**（`payment.ts:28`；理由：影子账户 quota 是 int32，物理上限 ¥4294.96）
- **项目上下文严格三选一**（`payment.ts:122-174`）：
  - 个人计费 → `{ personal: true }`，**不要**再传 projectId/producer*（后端固定落到 env 的落点并跳过成员校验）
  - 普通 project → `{ projectId }`
  - producer 池 → `{ producerId, producerProjectId }` **成对**，缺一 400
- 成员校验 fail-closed：目标项目必须 `joined === true`，否则 403 `FORBIDDEN`

订单状态机：`PENDING | PAID | CREDITED | CLOSED`。
🚨 **`PAID` ≠ 完成，`CREDITED` 才是。** `PAID` 但入账失败时 `creditError` 非空。

🚨 **建单与查单的响应形状不对称**（实测踩中，已修，`ec14ee5a`）：

| | 形状 | 出处 |
|---|---|---|
| 建单 | `{ok:true, data: {outTradeNo, payUrl, totalAmount, pointsAmount, status}}` —— `data` **直接就是订单** | `payment.ts:151,219`；`paymentOrderService.ts:119-125` |
| 查单 | `{ok:true, data: {order: {outTradeNo, status, creditError, …}}}` —— **多包一层** | `payment.ts:310-329` |

漏剥 `data.order` 不抛任何错：字段全读成 `undefined`，状态经安全退化变成 `PENDING`，于是轮询**永远等不到 `CREDITED`** —— 用户付了钱、钱也到账，应用一路显示「未完成」到超时。第一版就是这么写错的，而测试用的扁平 mock 陪着一起全绿，直到拿后端源码对账才露出来。

**给 Task 3b**：`fetchRechargeOrder` 已经处理好这层，渲染层直接用它的返回值，不要自己解包。
**给所有后续任务的教训**：mock 的形状必须来自**后端源码**，不能来自「实现里是怎么读的」——否则测试只是把实现的假设复述一遍。

`payUrl` 由支付宝 SDK 现签（`alipayService.ts:139-160`），含订单号、`timeout_express` 默认 `10m`。**一次性，不能拼、不能缓存、不能预生成。**

### 1.4 换算

`quota / 500000 = 元`（`new-api/common/constants.go:41` `QuotaPerUnit = 500 * 1000.0`）。
⚠️ 后端那是 `var` 不是 `const`，运行时可改，且**没有任何 API 暴露它**。主进程沿用已有的 `QUOTA_PER_YUAN`（`session.ts:220`），不另写一份。

---

## 2. 三个必须如实标注的口径问题

这三条都**不照抄网页端**。网页端的处理方式各有问题，抄了就是把已知缺陷复制一遍。

### 2.1 汇总是毛消费额，不是净额

汇总 SQL 有 `WHERE type = LogTypeConsume`（`log.go:365`），明细的 where **没有 type 过滤**（`log.go:333-342`）。所以一条退款（type=6）会**出现在列表里、却不进总费用**，`total` 也是无过滤集合的 count。

对比：new-api 自己算净额时用 `type IN (Consume, Refund)` 且排除 `settle_status = Cancelled`（`model/scoped_query.go:124`）——usage-summary 没走这条正确逻辑。

**处置**：汇总卡的标题写「消费合计（不含退款）」而不是「总费用」；退款行在列表里保留醒目标记。不在前端硬算净额——列表是分页的，算不出全量净额，算出来的「净额」只对当前页成立，比毛额更误导。

### 2.2 producer 池的用量查不准

用量接口**只收 `projectId`**，不收 `producerProjectId`（`userOrg.ts:350-354`、`internal.go:449-454`、`log.go:333-342`）。而池键是 `(projectId, producerProjectId)` 两半。

选中 producer 池时，按 `projectId` 查出来的是该 project 下**所有** producer 子项目的流水。客户端过滤只能救列表、**救不了汇总**（服务端预聚合），救了列表还会让列表与汇总互相矛盾，且 `total`/分页全错。

**处置**：producer 池时在抽屉顶部给一条明确说明「该项目下全部子项目的用量，无法按当前池拆分」。加查询参数是第二期的后端改动候选。

### 2.3 换算比例只能硬编码

见 1.4。**处置**：复用主进程既有常量，接受漂移风险，在注释里写明来源与风险。

---

## 3. 命名雷（网页端踩过，别重复）

`sora-ui/src/api/backend-api.ts` 里 **`UsageSummaryItem` 被 export 了两次**（`:602-608` 的 VideoTask 统计 + `:1547-1552` 的用量汇总）。TypeScript 接口声明合并把两者合成一个九字段类型，`UsageDrawer.tsx:6` 导入的就是合并体——访问 `s.name` 不报错但运行时是 `undefined`。

同文件 `:1545-1546` 还留着一条更早的踩坑注释：字段名曾误写成 `request_count`/`total_prompt_tokens`，导致抽屉显示「NaN 次」。

**处置**：桌面端类型名一律带 `Usage` 前缀且语义唯一：`UsageLogRow` / `UsageLogPage` / `UsageModelSummary`。不复用 `UsageSummaryItem` 这个名字。

---

## 4. 分层实现

沿用额度查询那条线已经定型的五层结构与信封。

### Task 1 — 类型 + 主进程

**`src/types/authApi.ts`** 新增（形状必须与 `session.ts` 的返回逐字一致，注释里写明真源在主进程）：

```ts
export interface UsageLogRow {
  id: number
  createdAt: number            // Unix 秒
  type: number                 // 2=消费 6=退款，枚举见计划 §1.1
  modelName: string
  quota: number                // 原始 quota 整数，退款为负
  promptTokens: number
  completionTokens: number
  feature: string | null
  tokenName: string | null
  projectId: number | null
  producerProjectId: number | null
}

export interface UsageLogPage {
  rows: UsageLogRow[]
  total: number
  page: number
  pageSize: number
}

export interface UsageModelSummary {
  modelName: string | null     // 后端 model_name 可缺省
  totalQuota: number
  totalRequests: number
  totalTokens: number
}

export interface UsageQuery {
  projectId: number
  page?: number
  pageSize?: number
  startTime?: number
  endTime?: number
}

export type RechargeOrderStatus = 'PENDING' | 'PAID' | 'CREDITED' | 'CLOSED'

export interface RechargeOrder {
  outTradeNo: string
  status: RechargeOrderStatus
  totalAmount: string
  creditError: string | null   // PAID 但入账失败时非空
}

export interface RechargeOrderCreated extends RechargeOrder {
  payUrl: string
}

/** 三选一的项目上下文，见计划 §1.3。 */
export type RechargeTarget =
  | { kind: 'personal' }
  | { kind: 'project'; projectId: number }
  | { kind: 'producer'; producerId: number; producerProjectId: number }
```

**`src/main/services/auth/session.ts`** 新增 `fetchUsageLogs` / `fetchUsageSummary` / `createRechargeOrder` / `fetchRechargeOrder`。

要点：
- 全部走既有 `sendJson` + `requireToken` + `toAuthError` + `num`
- 查询参数用 `URLSearchParams` 拼，**camelCase**（BFF 自己改名，别在客户端提前改成 snake_case）
- 响应解包 `body.data ?? body`；payment 是 `{ok:true,data}`、usage 是 `{success:true,data}`，两者都落在 `body.data`，所以同一套解包够用
- `pageSize` 客户端也 clamp 到 ≤100，别指望后端兜
- `createRechargeOrder` 把 `RechargeTarget` 展开成互斥字段，**绝不同时发两组**
- 金额校验：`amountCny` 必须 `> 0 && <= 4000`，越界在主进程就抛 `AuthError`，不要打到后端换一个 400 回来
- **不与 `probeLiveness` 共用节流**（额度那批已有此约定，原因见 `session.ts:339` 附近注释）
- **不做缓存**：明细与订单状态都是用户盯着的实时数据

**测试**（`session.test.ts` 追加）：
- 参数拼装：`projectId`/`page`/`pageSize`/时间范围都进 query，且是 camelCase
- `pageSize` 超 100 被 clamp
- snake_case → camelCase 归一，含 `producer_project_id`
- 退款行 `quota` 为负时原样透出（不要 `Math.abs`）
- `model_name` 缺省时 `modelName` 为 `null` 而不是 `''`
- 未登录抛 `NOT_AUTHENTICATED`
- 建单：三种 target 各自只发对应字段（producer 必须成对）
- 建单：金额越界在客户端就抛，`net.fetch` 一次都没被调
- 订单查询：`PAID` + `creditError` 非空时如实透出

### Task 2 — IPC + preload

**`ipc.ts`**：`auth:get-usage-logs`、`auth:get-usage-summary`、`auth:create-recharge-order`、`auth:get-recharge-order`，一律走既有 `quotaRpc` 信封（`{ok,data} | {ok:false,error:{code,message}}`）。**不裸抛**——裸抛经 IPC 会被包成 `Error invoking remote method '…'`，后端 code 全丢，而 UI 要按 code 分支。

四个通道必须进 `AUTH_CHANNELS` 卸载清单（漏加的症状：热重载后同通道第二次 `ipcMain.handle` 抛 second-handler）。

**`preload/index.ts`**：加通道常量 + `AgentApi`/`AuthApi` 类型 + 实现。

**测试**：通道注册 + dispose 后摘净；错误信封形状；参数透传（含 `producerProjectId` 这半不能丢）。

### Task 3a — 使用明细抽屉（可与 3b 并行，文件不重叠）

新增 `src/renderer/src/pages-react/settings/UsageDrawer.tsx` + `useUsageData.ts`（hook 单独拆出来，为了能独立测竞态守卫与轮询）。

必须做到：
- **portal 到 `document.body`**。理由：`AgentChatPanel` 的 `<aside>` 带 `backdrop-blur`、自成 stacking context，任何在它内部的元素无论 z 多大都被钳在 40000 层（血泪注释在 `PetOverlay.tsx:403-408`）；且各 tab 容器靠 `display:none` 切换，塞进页面组件会跟着一起消失（`main.tsx:153-156`）。
- **z 取 50000**（与既有 modal 同带）。**绝不 ≥ 75000** —— 那是登录覆盖层，有防回归测试（`DesktopLoginPage.test.tsx:96`）。
- **单调递增请求序号弃用守卫**。网页端 `UsageDrawer.tsx:87,93,102,109` 的 `reqSeqRef` 是对的，抄这个思路：只有最新一次请求的结果允许写 state，防慢响应覆盖快响应。
- **错误态要有 UI**。网页端把两个请求各自 `.catch(() => null)`（`:99-100`），失败后显示「暂无记录」，用户区分不了「真没数据」和「接口挂了」。这里必须分开呈现。
- 汇总卡三个数字前端 reduce（后端只给分组数组），标题按 §2.1 写「消费合计（不含退款）」。
- producer 池按 §2.2 给说明条。
- 时间范围：今天 / 7天 / 30天 / 全部，Unix 秒，切换时 `page` 归零。
- 分页：0 基，`pageSize` 50，显示 `page+1 / ceil(total/50)`。
- 打开期间轮询（间隔 10s，与网页端一致）；关闭即停。
- 金额 4 位小数、`0 < v < 0.01` 显示 `<0.01`、退款加 `+` 前缀 —— 与网页端一致，避免同一笔钱两处显示不同。
- 样式走设置页那套 cyberpunk token（`bg-cyberpunk-yellow` / `border-2` / `border-zinc-700` / 直角），**不要**混进 Codex 侧的 cyan/rounded-md 那套，也**没有** `.miau-*` 类可用（桌面端不存在）。

### Task 3b — 原生充值弹窗

新增 `src/renderer/src/pages-react/settings/RechargeModal.tsx`。

- 预设金额 `[10, 30, 50, 100]` + 自定义输入，上限 4000
- 目标由 `useQuotaStore.selectedPool` + `personalBillingProjectId` 推导成 `RechargeTarget`：命中个人落点 → `{kind:'personal'}`；有 `producerProjectId` → `{kind:'producer'}`；否则 `{kind:'project'}`
- 建单成功 → `shell.openExternal(payUrl)`（**不是**应用内导航：`will-navigate` 只允许同源与 `file:`，应用内跳转会被静默拦下）
- 轮询 3s、超时 5min，**到 `CREDITED` 才算成功**；`PAID` 且 `creditError` 非空显示「入账中」
- 成功后调 `useQuotaStore.refreshBalance()`
- z 同 50000 带，portal 到 body

### Task 4 — 接进 AccountSection

- 余额数字可点（`title="查看使用明细"`，对齐网页端）**且**另给一个显式「使用明细」文字按钮 —— 两个入口都要
- 「充值」从 `openExternal('…/home')` 改成开 `RechargeModal`
  - ⚠️ 这是在修一个已写进代码的 bug：`/home` 到不了充值表单（表单是 `/space` 画布页上的弹窗，`/plan` 只是充值**记录**页）
- 未选池时明细/充值都禁用（用量接口 `projectId` 必填才有意义，建单也要项目上下文）

---

## 4.5 两条轮询路径都要单调守卫

明细抽屉与充值弹窗**都在轮询**，两处都必须有「只有最后发起的那一跳允许写 state」的守卫。原计划只给抽屉写了这条，充值那边漏了，于是撞出一个真 bug（已修，`7f6db63d`）：

3 秒一跳，任何一跳响应超过 3 秒就与下一跳重叠。第 N 跳（慢，回 `PENDING`）在第 N+1 跳（快，回 `CREDITED`）之后 resolve 时——

```
success → setStage('waiting') → polling 变回 true → interval 重启 → 一路轮到超时
```

用户看到「充值成功」闪一下变成「未确认到账」，而钱已经到账、`refreshBalance()` 也调过了。那一刻他最可能的动作是**再付一次**。

抽屉那边同一个守卫防的是另一个症状：切了时间范围，看到的却是上一个范围的数据。

**推论**：这个仓库里任何「interval + async 写 state」的组合都需要它。测试方式是用受控 promise 让两跳乱序 resolve，不是靠 `waitFor` 碰运气。

## 5. 验收

- 触及的套件全绿；新增用例对每条 §2 的口径问题都有一条断言钉住
- 两条轮询路径各有一条「乱序 resolve」用例（见 §4.5）
- 关键逻辑做变异测试（把 clamp / 竞态守卫 / 三选一互斥 / `CREDITED` 判定各改坏一次，确认有测试变红）
- `npm run typecheck` 相对基线 **0 新增**（当前 43 existing / 8 fixed）
- `node scripts/ci/typecheck-baseline.mjs` 通过

## 6. 计划外但挡路的事

`tests/ci-cd/typecheck-baseline.json` 的 `expiresAt` 是 `2026-08-31`，硬编码在 `scripts/ci/typecheck-baseline.mjs:148`，`--write` 重新生成**不会**续期，`:162` 每次 CI 都校验、`:98-100` 一过期直接 throw。8-31 之后所有 CI 无条件变红，本 PR 也过不去。需单独决策（清债 or 移闸），不在本计划范围内。
