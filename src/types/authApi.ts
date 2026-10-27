// `window.electronAPI.auth` 的契约。主进程、preload、渲染层同吃这一份。
//
// 单独立文件而不是让三边各写一遍,是因为这家代码库已经为 AgentApi 吃过一次教训:
// 渲染层曾照抄一份 preload 的 DTO(注释原文写着「redeclare it here instead of
// importing from preload」),两份定义随后各自漂移。见 `src/types/agentApi.ts`。
//
// **这里刻意不含 token,也不含 codeVerifier。** 两者只活在主进程:token 由
// `services/auth/credentials.ts` 经 safeStorage 落盘,verifier 只活在
// `services/auth/ipc.ts` 的 pending 对象里。渲染层看到的永远只是派生状态 ——
// 类型层面就没有那个字段可填,漏出去需要先改这个文件,而不是手滑。

export interface AuthState {
  authenticated: boolean
  username: string | null
  displayName: string | null
  role: string | null
  /**
   * `memory` 表示 safeStorage 不可用(典型是 Linux 没有系统密码管理器),
   * 凭证只在本次会话有效。UI 需要据此提示「重启后需重新登录」——
   * 否则用户会以为登录没生效。
   */
  credentialSource: 'safeStorage' | 'memory' | 'none'
}

/**
 * 登录的最终结果,经 `auth:login-result` 推送。
 *
 * 与 `auth:state-changed` 分开两条通道:`start-login` 必须快速返回(UI 要在等待态
 * 显示授权链接、提供复制与手动输入的出口),所以等码与兑换是脱钩跑的,失败发生在
 * invoke 返回之后。把错误塞进 `AuthState` 会污染 store 直接消费的那个类型。
 *
 * `message` 已是用户可读文案,由主进程从后端 `error.code` 映射而来 ——
 * 渲染层直接显示,不要再自己做映射。
 */
export type AuthLoginResult =
  | { ok: true }
  | { ok: false; code: string; message: string }

// ───────────────────────────────────────────────────────────────────────────
// 账号额度
//
// 这几个类型在主进程侧的真源是 `services/auth/session.ts`(它按后端响应做归一化,
// 认两种字段拼法、做金额换算)。这里重新声明是因为渲染层不能 import 主进程模块 ——
// 但**形状必须一致**,`session.ts` 的返回类型改了这里要跟着改。
// ───────────────────────────────────────────────────────────────────────────

/**
 * 额度查询的返回信封。
 *
 * **主进程刻意不裸抛。** 裸抛经 IPC 会被包成 "Error invoking remote method '…'",
 * 后端的 error code 全部丢失 —— 而 UI 必须按 code 分支:「未登录」要引导重新登录、
 * 「余额不足」要引导充值、「无权访问该项目」要引导换组织,三种动作完全不同。
 *
 * `code` 保证是非空字符串:非 `AuthError`(断网、DNS 失败、超时)也会被合成一个,
 * 否则渲染层的 switch 落到 `undefined` 分支,表现成「什么提示都没有」。
 */
export type QuotaRpc<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } }

export interface AccountBalance {
  /** 元。后端 `balance_yuan` / `quota_yuan` 两种拼法已在主进程归一。 */
  balanceYuan: number
  /** 原始 quota 整数(500000 = ¥1)。后端未返回时为 null。 */
  balanceQuota: number | null
}

/**
 * 一个可用的计费池。
 *
 * **`id` 单独不构成池键。** 键是 `(id, producerProjectId)` 一对 —— 两个 producer
 * project 可以共用一个 `id`,只按 `id` 认会把两个不同的池当成同一个,钱记错地方。
 * 比较两个池是否相同时必须比对两半(参考 shortdrama 的 `sameBillingPool`)。
 */
export interface AccountOrganization {
  id: number
  name: string
  studioName: string | null
  balanceYuan: number
  /**
   * 用户在该池下有没有 allocation 行。没有就没有影子账户可扣 ——
   * 未加入的池应呈现为「加入」而不是「选择」。
   */
  joined: boolean
  /** 仅 producer 池有。普通 project 后端回 0 或缺省,主进程已过滤掉。 */
  producerProjectId?: number
}

export interface PaymentConfig {
  /**
   * 个人计费落点 project id;后端未配置时为 null。
   *
   * **绝不要在渲染层硬编码这个值。** 它由后端 env 下发,且该 project 刻意不出现在
   * 组织列表里 —— 那是它的设计前提,不是漏了。
   */
  personalBillingProjectId: number | null
}

/**
 * 计费池引用。**必须与主进程 `services/auth/gatewayToken.ts` 的 `Pool` 保持一致** ——
 * 那边是真源,这里是渲染层侧的镜像。
 *
 * `producerProjectId` 是池键的另一半,不是可选装饰:两个 producer 项目可以共用
 * 同一个 `projectId`,只按 `projectId` 认会把两个不同的钱包合并。
 *
 * ⚠️ 与上面的 `AccountOrganization` 不同,这里的另一半写成 `number | null` 而**不是**
 * 可选属性 —— 主进程那边就是 `number | null`,两边形状不一致会在 IPC 边界上静默错位。
 * 从组织列表构造这个引用时要显式补 `?? null`,别直接把 `producerProjectId` 透传过来。
 */
export interface BillingPoolRef {
  projectId: number
  producerProjectId: number | null
}

/**
 * 「本次请求走平台余额」的标记头。
 *
 * 🚨 **跨进程共用这一份,任何一侧都不要再声明自己的字面量。** 渲染层
 * (`services/api/ApiService.ts`)出网前打上它,主进程的
 * `services/auth/gatewayHeaderInjector.ts` 靠它认出这一趟该把 Authorization 换成平台
 * 凭据。两边各写一份的话,**只改一边不会有任何东西变红** —— 两边的测试各自硬编码
 * 自己那份,双绿。而失效症状是「看着接好了、一次都不生效」:请求带着认不出的标记
 * 出网,注入器直接放行,Authorization 没被换上,用户拿到一串 401,极易误判成后端故障。
 *
 * 用标记头而不是让主进程无条件注入,是因为用户仍可以用自己填的 API Key —— 无条件
 * 注入会把它覆盖掉。标记本身在出网前会被主进程删除,不让内部协议泄漏到上游日志里。
 *
 * 值里不含任何凭据:它只是一句声明,真 `Authorization` 由主进程在出网前换上。
 * 跨进程共用常量的房规先例见 {@link MAX_RECHARGE_CNY}。
 */
export const BILLING_MARKER_HEADER = 'X-Catimation-Billing'
export const BILLING_MARKER_VALUE = 'platform'

// ───────────────────────────────────────────────────────────────────────────
// 用量明细
//
// 真源同上:`services/auth/session.ts`(它把后端全 snake_case 的 `model.Log` 归一成
// camelCase)。这里的形状必须与之逐字一致。
//
// 🚨 命名:这几个类型一律带 `Usage` 前缀且语义唯一。网页端
// `sora-ui/src/api/backend-api.ts` 把 `UsageSummaryItem` **export 了两次**(`:602-608`
// 的 VideoTask 统计 + `:1547-1552` 的用量汇总),TypeScript 的接口声明合并把两者悄悄
// 合成一个九字段类型 —— `UsageDrawer.tsx:6` 导入的就是那个合并体,访问 `s.name`
// 编译不报错、运行时是 undefined。**不要复用 `UsageSummaryItem` 这个名字。**
// ───────────────────────────────────────────────────────────────────────────

export interface UsageLogRow {
  id: number
  /** Unix **秒**(不是毫秒)。喂给 `new Date()` 前要乘 1000。 */
  createdAt: number
  /** `2` = 消费,`6` = 退款。完整枚举见后端 `log.go:53-61`。 */
  type: number
  modelName: string
  /**
   * 原始 quota 整数,**退款为负**。500000 = ¥1。
   *
   * 显示时不要取绝对值 —— 那会让一笔退款看起来像「又花了一笔钱」。退款行应加 `+` 前缀。
   */
  quota: number
  promptTokens: number
  completionTokens: number
  feature: string | null
  tokenName: string | null
  projectId: number | null
  producerProjectId: number | null
  /**
   * 后端 `content`:一句人读的说明。消费行是「视频 textGenerate, 生成时长seconds: 5.00」
   * 这类;退款行的 `modelName` 是空串,**只有这里**能说清退的是哪笔,所以退款行
   * 的主文案取它。缺失时空串。
   */
  content: string
  /**
   * 结算状态(`log.go` SettleStatus*):`0` settled、`1` pending、`2` cancelled。
   *
   * 网关对异步任务的账本模型是「一条消费日志原地改状态」:提交时 pending,成功后
   * settled,失败退款后 cancelled 且 `quota` 归 0 —— **不会**另写一条退款行。所以
   * 「已退款」要从这里读,不能只认 `type === 6`。缺失时按 settled 处理(同步接口没有
   * 这个概念,历史行也是 0)。
   */
  settleStatus: number
  /**
   * cancelled 行退回的预扣额(`other.pre_consumed_quota`,500000 = ¥1)。`quota` 已被
   * 归 0,只有它能告诉用户「退了多少」。非 cancelled 或缺失时 null。
   */
  preConsumedQuota: number | null
}

export interface UsageLogPage {
  rows: UsageLogRow[]
  /**
   * 后端这个 count **不按 type 过滤**,所以它含退款行,与汇总的口径不同(见
   * `UsageModelSummary.totalQuota`)。分页要用它,不要拿它当「消费笔数」。
   */
  total: number
  /** **0 基**。显示页码要 `page + 1`。 */
  page: number
  pageSize: number
}

export interface UsageModelSummary {
  /** 后端按 `model_name` 分组,GROUP BY 出来的那一组可以是 NULL → 这里是 null。 */
  modelName: string | null
  /**
   * **毛消费额,不含退款。**
   *
   * 汇总 SQL 带 `WHERE type = LogTypeConsume`,而明细的 where 没有 type 过滤 ——
   * 一条退款会出现在列表里、却不进这个数。所以汇总卡的标题必须写「消费合计(不含退款)」
   * 而不是「总费用」。
   *
   * 也**不要**在渲染层拿当前页的 rows 硬算净额:列表是分页的,算出来的「净额」只对
   * 当前页成立,比毛额更误导。
   */
  totalQuota: number
  totalRequests: number
  totalTokens: number
}

export interface UsageQuery {
  /**
   * `0` = 不过滤。**0 是合法值,不是「没传」** —— 别用 falsy 判断筛它。
   *
   * ⚠️ 用量接口**只收这一个** id,不收 `producerProjectId`。而 producer 池的键是
   * `(projectId, producerProjectId)` 两半,所以选中 producer 池时查出来的是该 project 下
   * **全部**子项目的用量。这个含糊性无法在客户端修掉(汇总是服务端预聚合的),
   * 只能在 UI 上明说。
   */
  projectId: number
  /** **0 基**(`offset = page * pageSize`)。汇总不用这个字段。 */
  page?: number
  /** 上限 100,主进程会 clamp。汇总不用这个字段。 */
  pageSize?: number
  /** Unix **秒**。后端 `>0` 才生效。 */
  startTime?: number
  endTime?: number
}

// ───────────────────────────────────────────────────────────────────────────
// 原生充值
// ───────────────────────────────────────────────────────────────────────────

/**
 * 单笔充值上限 ¥4000（后端 `payment.ts:28` 的 `BALANCE_RECHARGE_MAX_CNY`）。
 *
 * 这不是可以随手调大的业务参数：影子账户的 quota 是 **int32**，物理上限 ¥4294.96
 * （`4294.96 × 500000 ≈ 2^31`）。4000 是留了余量后的取整。
 *
 * **住在 types 里是为了让主进程与渲染层吃同一份。** 渲染层要它在用户输入时就地拦下
 * 超限（不然要等一个 RTT 才告诉用户金额超了），主进程要它做最后一道闸。两边各写一个
 * 4000 必然漂移：改了一处另一处继续放行，错的那侧要么白发请求、要么把合法金额拦在
 * 门外。跨进程共用常量的房规先例是 `types/videoWorkbench.ts` 的
 * `WORKBENCH_STATUS_MAX_PAGE_SIZE`。
 */
export const MAX_RECHARGE_CNY = 4000

export type RechargeOrderStatus = 'PENDING' | 'PAID' | 'CREDITED' | 'CLOSED'

export interface RechargeOrder {
  outTradeNo: string
  /**
   * 🚨 **`PAID` 不是完成,`CREDITED` 才是。** 支付宝收到钱、但入账影子账户失败时状态就停在
   * `PAID`(此时 `creditError` 非空)。轮询的成功判定只能是 `status === 'CREDITED'`。
   *
   * 主进程对未知状态一律退化成 `PENDING`(宁可等到超时,也不误报到账)。
   */
  status: RechargeOrderStatus
  /**
   * 十进制字符串(如 `"100.00"`)。**刻意是 string 不是 number** ——
   * `parseFloat` 再格式化一趟就能把 ¥100 显示成 ¥99.99999。
   */
  totalAmount: string
  /** `PAID` 但入账失败时非空,UI 应显示「入账中」而不是「成功」。 */
  creditError: string | null
}

export interface RechargeOrderCreated extends RechargeOrder {
  /**
   * 支付宝 SDK **现签**的一次性链接,带 `timeout_express`(默认 10m)。
   *
   * 只能交给 `shell.openExternal` —— 应用内导航会被 `will-navigate` 静默拦下(白名单只放
   * 同源与 `file:`)。也**不能缓存或预生成**:存下来的链接过期后点开是支付宝的报错页。
   */
  payUrl: string
}

/**
 * 项目上下文**严格三选一**,不是三个可选字段。多发一组的后果不是被忽略,而是 403:
 * 个人计费落点刻意不在组织列表里,一旦夹带 `projectId` 就会走进成员校验分支、查不到
 * `joined` → fail-closed。
 *
 * `producer` 的两半必须成对,缺一后端 400 —— 池键是 `(producerId, producerProjectId)`。
 */
export type RechargeTarget =
  | { kind: 'personal' }
  | { kind: 'project'; projectId: number }
  | { kind: 'producer'; producerId: number; producerProjectId: number }
