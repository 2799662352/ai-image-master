/**
 * 提交链路上两件「要不要做」的策略判断。
 *
 * 住在 seedance 目录而不是 wan3 目录：它们回答的是**我们这边**的策略问题 ——
 * Seedance 的素材库要不要参与、上游吃不吃内联 —— 而不是万相的协议问题。
 *
 * ## 为什么是两个谓词而不是一个
 *
 * 这两件事**曾经**是一个谓词（`provider === 'vvdance'`），因为在只有 vvdance 直连的
 * 年代它们的答案永远相同。接入「平台余额经 Miau 网关提交 Seedance」之后答案分岔了：
 *
 *   - **要不要碰 vvdance 素材库** —— 取决于**计费模式**。平台余额那条路用的是
 *     平台自己的素材库（`/api/volcengine-asset/*`，平台 JWT + `X-Project-Id`），
 *     与 vvdance 的 `/api/open/v1/local-assets`（HMAC 签名）是**两个池**，
 *     `asset://` 不通用。
 *   - **上游吃不吃 base64 内联** —— 只取决于 **provider**。平台模式下上游仍然是
 *     Seedance（只是经网关中转），内联与否不因为换了个钱包而改变。
 *
 * 合成一个的后果实测过：改对了前一个问题，后一个跟着被改错。
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
 * 这次提交要不要走 **vvdance 的**素材库 / 人像库。
 *
 * 挂在提交路径上的两件事都由它决定，**对万相与平台余额都不能做**：
 *
 *   - `verifyContentAssetReferences`：校验 `asset://` 在 vvdance 站点存在。
 *     它要 vvdance 的 apiKey/apiSecret —— 只配了 Miau 密钥的用户会拿着空凭据去打
 *     别人家接口；而**平台模式下那些 asset id 是平台的**，vvdance 库里根本不存在，
 *     校验会判定「缺失」并硬拦下整次提交。
 *   - `importImagesToPortraitLibrary`：提交后把参考图登记进人像库。
 *     平台模式的素材不该流进 vvdance 的库 —— 用户看的是平台库，导进去他也看不见。
 *
 * ⚠️ **只配平台、没配 vvdance 密钥的用户撞不到那个硬拦**（`assets.ts` 缺凭据会提前
 * return），**但从 vvdance 迁过来的用户两边密钥都有** —— 他们才是靶心，
 * 而报出来的是一句关于素材不存在的中文错误，根因完全看不出来。
 *
 * @param billing 这次提交的计费模式。缺省按自填 Key 处理，与接网关之前逐字节相同。
 */
export function usesSeedanceAssetLibrary(
  model: VideoModelAlias | undefined,
  billing?: VideoBillingSource,
): boolean {
  if (billing === 'platform') return false
  return capabilitiesFor(model ?? '2.0').provider === 'vvdance'
}

/**
 * 上游接不接受 `data:` 内联的小素材（≤512KB 走内联捷径，见 `mediaResolve`）。
 *
 * **刻意不吃 `billing`**：钱从哪个钱包出，与上游的协议无关。平台模式下上游仍然是
 * Seedance，只是中间多了一层网关中转。
 *
 * 答案为否时调用方要传 `{ alwaysRelay: true }` 强制走 COS 中转。漏传的后果很隐蔽 ——
 * 大图正常、小图报错，而用户完全想不到是体积的问题。
 *
 * > 未决：网关（new-api）对 `data:` URI 的透传行为没有实测过。今天平台模式沿用
 * > Seedance 的「吃内联」答案，是因为**保持现状**比按猜测改更安全；真要改，
 * > 应该先在 Task 6 的烟测里发一张小图看看。
 */
export function upstreamAcceptsInlineMedia(model: VideoModelAlias | undefined): boolean {
  return capabilitiesFor(model ?? '2.0').provider === 'vvdance'
}
