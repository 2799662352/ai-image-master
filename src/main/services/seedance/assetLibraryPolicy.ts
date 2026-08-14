/**
 * 「这个模型的提交链路要不要走 Seedance 素材库 / 人像库」。
 *
 * 住在 seedance 目录而不是 wan3 目录：它回答的是**我们这边**的策略问题 ——
 * Seedance 的素材库要不要参与 —— 而不是万相的协议问题。万相只是恰好答案为否。
 *
 * ## 为什么需要它
 *
 * 提交路径上挂着两件 Seedance 专属的事，**对万相一件都不能做**：
 *
 *   - `verifyContentAssetReferences`：校验 `asset://` 在 Seedance 站点存在。万相
 *     的素材里不可能有 `asset://`（组包时就拒了），而这次调用还要 Seedance 的
 *     apiKey/apiSecret —— 只配了 Miau 密钥的用户会拿着空凭据去打别人家接口。
 *   - `importImagesToPortraitLibrary`：提交后把参考图登记进人像库。万相的素材
 *     不该流进 Seedance 的库。
 *
 * 抽成谓词而不是在两个提交入口各写一个 `if`：入口有两个（工作台 UI 与 MCP
 * agent），每处两件事就是四个分支，第三个 provider 来了再翻倍，而「万相不要
 * 人像库兜底」这条保证会散在四处靠人记。这里是唯一出处，并由
 * `__tests__/portraitLibraryGuard.test.ts` 的源码断言钉死。
 */

import { capabilitiesFor } from '../../../types/seedance'
import type { VideoModelAlias } from '../../../types/seedance'

export function usesSeedanceAssetLibrary(model: VideoModelAlias | undefined): boolean {
  return capabilitiesFor(model ?? '2.0').provider === 'vvdance'
}
