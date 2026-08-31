// 计费池的可选项与显示名。设置页的下拉与出图页的行内提示共用这一份。
//
// 抽出来的理由和 `balance.ts` 一样:下面那条「个人计费落点不在组织列表里」的补齐
// 逻辑一旦漏在某一处,那一处就会显示成「未知计费池」——而它恰恰是最常用的那个池。

import type { AccountOrganization } from '../../../../types/authApi'
import { samePool, type Pool } from '../../stores/useQuotaStore'

export interface PoolOption {
  pool: Pool
  label: string
}

/**
 * 可选计费池。
 *
 * 个人计费落点**刻意不在** `/api/user/organizations` 的返回里(后端设计前提,见
 * `payment.ts`),所以要单独补一条 —— 只渲染组织列表的话,用户最常用的那个池
 * 反而选不到。
 *
 * 未加入的组织(`joined: false`)不给:没有 allocation 行就没有影子账户可扣,
 * 选中它只会在出图时拿到一个看不懂的错误。
 */
export function buildPoolOptions(
  organizations: readonly AccountOrganization[],
  personalBillingProjectId: number | null,
): PoolOption[] {
  const items: PoolOption[] = organizations
    .filter((o) => o.joined)
    .map((o) => ({
      pool: { projectId: o.id, producerProjectId: o.producerProjectId ?? null },
      label: o.studioName ? `${o.studioName} / ${o.name}` : o.name,
    }))

  if (
    personalBillingProjectId !== null &&
    !items.some(
      (i) => i.pool.projectId === personalBillingProjectId && i.pool.producerProjectId === null,
    )
  ) {
    items.unshift({
      pool: { projectId: personalBillingProjectId, producerProjectId: null },
      label: '个人计费',
    })
  }
  return items
}

/**
 * 池的显示名。找不到时回 `null` 而不是编一个 —— 调用方据此决定是省略这半句话
 * 还是说「未知」,而不是把一个可能过期的名字摆给用户看。
 *
 * 比对走 `samePool`:池键是一对,只比 `projectId` 会把两个共用 id 的 producer 池
 * 认成同一个,于是显示的是**另一个池**的名字。
 */
export function poolLabelOf(options: readonly PoolOption[], pool: Pool | null): string | null {
  if (!pool) return null
  return options.find((o) => samePool(o.pool, pool))?.label ?? null
}
