// 模型别名 → Miau 网关上的上游模型 ID。
//
// 这个文件取代了原来的 `region.ts`:那里有「海外 GLOBAL(dreamina-*) / 国内(doubao-*)」两张表,
// 因为 vvdance 直连有两个站点。vvdance 直连删除后只剩网关这一份目录(`doubao-*`),
// 站点、Base URL 解析、灰度开关都没有存在的理由了。
// 「别名能不能在工作台里选」不再由这里算,见 `types/seedance.ts` 的 `isSeedanceModelAvailable`。

import type { SeedanceModelAlias } from '../../../types/seedance'
import { DEPTH_UPSTREAM_MODEL_ID_BASE } from '../depth/model'
import { KLING_4_OMNI_UPSTREAM_MODEL_ID, KLING_4_UPSTREAM_MODEL_ID } from '../kling/model'
import { WAN3_PRIME_UPSTREAM_MODEL_ID, WAN3_UPSTREAM_MODEL_ID } from '../wan3/model'

/**
 * 网关目录里的上游模型 ID。MCP 别名仍是 2.0 / 2.0-fast / 2.0-mini / 2.5。
 *
 * 万相 / 可灵 / 深度捕捉也登记在这里,是为了保住 `Record<VideoModelAlias, string>` 的穷尽性:
 * 正是这个穷尽性在加 wan3 时把「你还没决定这个模型的 id」直接编译报错报了出来。
 * 改成 Partial 会让下一个模型悄悄漏掉。深度捕捉填的只是**前缀**,真正的上游 id 带分辨率后缀
 * (`rh-video-depth-480p`…),由 `depth/model.depthUpstreamModelId` 在提交时拼 —— 别把这个值直接发出去。
 */
export const SEEDANCE_MODEL_IDS: Record<SeedanceModelAlias, string> = {
  '2.0': 'doubao-seedance-2-0-260128',
  '2.0-fast': 'doubao-seedance-2-0-fast-260128',
  '2.0-mini': 'doubao-seedance-2-0-mini-260615',
  '2.5': 'doubao-seedance-2-5-260628',
  wan3: WAN3_UPSTREAM_MODEL_ID,
  'wan3-prime': WAN3_PRIME_UPSTREAM_MODEL_ID,
  kling4: KLING_4_UPSTREAM_MODEL_ID,
  'kling4-omni': KLING_4_OMNI_UPSTREAM_MODEL_ID,
  depth: DEPTH_UPSTREAM_MODEL_ID_BASE,
}

export function resolveSeedanceModelId(alias: SeedanceModelAlias): string {
  return SEEDANCE_MODEL_IDS[alias]
}
