/**
 * 「这一次的钱从哪出」在渲染端的**有效值**。
 *
 * `useQuotaStore.billingSource` 是用户在账户页点的偏好(平台余额 / 自填 Key);选中设置页的
 * 「自定义网关」后,这个偏好不能再决定视频 / 智能擦除的计费:**平台钱包只在 Miau 官方网关上有效**,
 * 平台影子 token 与归属头绝不能发往用户自己填的地址(见主进程 `services/customGateway.ts`)。
 * 所以选中自定义网关时有效值一律是 `'own-key'`,用户的偏好原样保留 —— 切回 Miau 站点就恢复。
 *
 * 为什么放成独立的小模块、不直接问 `ApiService`:
 *  - 视频工作台 / 智能擦除不该为了读一个布尔值去 import 五千多行的 `ApiService`
 *    (它的测试也不该因此都带上整个服务);
 *  - 页面组件要**订阅**这个值 —— 工作台页面一旦挂载就不卸载,在设置页切站点之后它不会重挂载,
 *    只读一次会一直停在旧值。
 *
 * `ApiService` 是唯一的写入方:启动时与 `setSite` 之后各调一次 {@link setCustomGatewaySelected}。
 */

import { useSyncExternalStore } from 'react'
import { useQuotaStore } from './useQuotaStore'
import type { BillingSource } from './useQuotaStore'

let selected = false
const listeners = new Set<() => void>()

/** 当前选中的站点是不是「自定义网关」(只由 `ApiService` 写)。 */
export function setCustomGatewaySelected(value: boolean): void {
  // 值没变时也通知一遍:`useSyncExternalStore` 比较快照后不会多渲染,不必在这里再设一道。
  selected = value
  for (const listener of [...listeners]) listener()
}

export function isCustomGatewaySelectedNow(): boolean {
  return selected
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 把用户偏好换算成有效计费来源(纯函数,便于测试)。 */
export function effectiveBillingSource(preferred: BillingSource, customGatewaySelected: boolean): BillingSource {
  return customGatewaySelected ? 'own-key' : preferred
}

/** 命令式读取:提交 / 门控那一刻现读(不订阅)。 */
export function getEffectiveBillingSource(): BillingSource {
  return effectiveBillingSource(useQuotaStore.getState().billingSource, selected)
}

/** 组件里订阅用。 */
export function useEffectiveBillingSource(): BillingSource {
  const preferred = useQuotaStore((s) => s.billingSource)
  const custom = useSyncExternalStore(subscribe, isCustomGatewaySelectedNow, isCustomGatewaySelectedNow)
  return effectiveBillingSource(preferred, custom)
}

/** 仅供测试:回到「没选中」。 */
export function __resetEffectiveBillingForTests(): void {
  selected = false
  listeners.clear()
}
