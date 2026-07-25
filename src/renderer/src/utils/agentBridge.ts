/**
 * 读取 `window.electronAPI.agent` 的唯一入口。
 *
 * 在此之前,每个消费者都自带一套三件套:一个手写的 duck-type(`type DoctorApi =
 * { agent?: { codexDoctor?: ... } }`)、一个 `getXxxApi()` 里的 `window` 强转、
 * 以及一份和 preload 各自漂移的方法签名。签名的权威定义现在只有
 * `src/types/agentApi.ts` 一处,这个函数负责把它安全地从 `window` 上取下来。
 */

import type { AgentApiBridge } from '../../../types/agentApi'

/**
 * 返回 agent 桥,拿不到时返回 `undefined`。
 *
 * 两种拿不到的情况都是真事、不是防御性编程:①纯浏览器/jsdom 环境下没有
 * preload(测试只挂需要的几个 mock);②热更新会让 preload 与渲染包版本错位,
 * 新渲染层调老 preload 时某个方法就是不存在。所以返回类型是
 * {@link AgentApiBridge}(全可选),调用点一律 `?.` —— 别在这里 assert 成
 * 完整的 `AgentApi`,那只会把真实的缺失伪装成必然存在。
 */
export function getAgentApi(): AgentApiBridge | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as Window & { electronAPI?: { agent?: AgentApiBridge } }).electronAPI?.agent
}
