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
