/**
 * 提交链路上两件「要不要做」的策略判断。
 *
 * 住在 seedance 目录而不是 wan3 目录：它们回答的是**我们这边**的策略问题 ——
 * Seedance 的素材库要不要参与、上游吃不吃内联 —— 而不是万相的协议问题。
 *
 * ## 为什么是两个谓词而不是一个
 *
 * 这两件事的答案维度不同：
 *
 *   - **素材库要不要参与** —— 取决于**计费模式**。只有平台余额那条路有素材库
 *     （`/api/volcengine-asset/*`，平台 JWT + `X-Project-Id`）；自填 Miau Key 没有登录态，
 *     也就没有 JWT，素材库那一整套对它不可用。
 *   - **上游吃不吃 base64 内联** —— 只取决于 **provider**。换了个钱包，上游依旧是
 *     Seedance（经网关中转），内联与否不因此改变。
 *
 * 合成一个的后果实测过：改对了前一个问题，后一个跟着被改错。
 *
 * （历史：这里曾有第三个谓词 `usesSeedanceAssetLibrary`，回答「要不要碰 vvdance 自己的素材库」。
 * vvdance 直连整条路删除后它没有任何调用方，随之删除。）
 *
 * ## 抽成谓词而不是在调用点写 `if`
 *
 * 提交入口有两个（工作台 UI 与 MCP agent），每处两件事就是四个分支，
 * 第三个 provider 来了再翻倍，而「万相不要人像库兜底」这条保证会散在四处靠人记。
 * 这里是唯一出处，并由 `__tests__/portraitLibraryGuard.test.ts` 的源码断言钉死
 * 「两个入口都真的问过」。
 */

import { capabilitiesFor } from '../../../types/seedance'
import type { VideoModelAlias } from '../../../types/seedance'
import type { VideoBillingSource } from './types'

/**
 * 这次提交的 `asset://` 该在**平台素材库**里解析(平台余额经网关提交 Seedance)。
 *
 * 万相不认识 `asset://`,不参与;自填 Miau Key 没有素材库,也不参与。
 * 用途是提交前核验卡上的 `asset://` 在当前计费池里真的存在 —— 否则上游要先建任务、
 * 跑到取素材那一步才回 `The specified asset … is not found`。
 */
export function usesPlatformAssetLibrary(
  model: VideoModelAlias | undefined,
  billing?: VideoBillingSource,
): boolean {
  return billing === 'platform' && capabilitiesFor(model ?? '2.0').provider === 'vvdance'
}

/**
 * 上游接不接受 `data:` 内联的小素材（≤512KB 走内联捷径，见 `mediaResolve`）。
 *
 * **刻意不吃 `billing`**：钱从哪个钱包出，与上游的协议无关。两种钱包下上游都是
 * Seedance，只是中间多了一层网关中转。
 *
 * 答案为否时调用方要传 `{ alwaysRelay: true }` 强制走 COS 中转。漏传的后果很隐蔽 ——
 * 大图正常、小图报错，而用户完全想不到是体积的问题。
 *
 * > 未决：网关（new-api）对 `data:` URI 的透传行为没有实测过。今天沿用
 * > Seedance 的「吃内联」答案，是因为**保持现状**比按猜测改更安全；真要改，
 * > 应该先在烟测里发一张小图看看。
 *
 * 注:`provider === 'vvdance'` 这个取值的字面是历史遗留，语义现在就是「Seedance 家族」
 * （与万相 / 可灵 / 深度捕捉相对）；改名留给清理 PR。
 */
export function upstreamAcceptsInlineMedia(model: VideoModelAlias | undefined): boolean {
  return capabilitiesFor(model ?? '2.0').provider === 'vvdance'
}
