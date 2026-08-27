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
