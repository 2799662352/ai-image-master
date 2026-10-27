/**
 * Miau（new-api）网关的 OpenAI 兼容根地址。
 *
 * 两个不相干的子系统要用它，所以提到 shared：
 *  - `main/agent/gatewayModelRouting`：qwen 对话 / 理解工具的 Channel base URL；
 *  - `main/services/wan3/client`：万相 3.0 的视频生成端点。
 *
 * 加速域名（2026-07-28 起），仅 https 可达。两处共用一份，是因为它变过一次
 * ——那种时候分散的拷贝一定会漏掉一处，而漏掉的那处会以「某个功能突然连不上」
 * 的形式出现，且不会有任何编译期提示。
 *
 * 认证用的都是同一枚 Miau token（provider store 的 `apiKeys['qwen']`）。
 */
export const MIAU_BASE_URL = 'https://miauapi.13797248455.xyz/v1'

/**
 * 开发构建专用的网关覆盖(`CATIMATION_GATEWAY_ORIGIN`)。**打包产物读都不读。**
 *
 * 与 `auth/gatewayHeaderInjector.resolveGatewayOrigin` 是同一件事、同一个环境变量,
 * 那边写了完整的安全论证(发凭据的一端可配置 = 把真凭据送到攻击者服务器的原语,
 * 所以只在非打包构建生效)。这里不能直接复用它:那个模块顶层 import electron,
 * 而本文件是 `shared/`,渲染层也要 import。
 *
 * `isPackaged` 由调用方注入 —— 主进程传 `app.isPackaged`,渲染层传 true
 * (渲染层没有覆盖的需求,也拿不到那个判据)。
 *
 * 不做这一步的后果就是 2026-08-29 撞到的那个:测试服签的影子 token 被发到
 * **生产**网关,回一句 `Invalid token`,而人第一反应是去查 token 而不是查地址。
 */
export function resolveMiauBaseUrl(isPackaged: boolean): string {
  if (isPackaged) return MIAU_BASE_URL
  const raw = process.env.CATIMATION_GATEWAY_ORIGIN?.trim()
  if (!raw) return MIAU_BASE_URL
  try {
    // 只取 origin,丢掉路径:带路径的输入会拼出 `…/v1/v1`。
    return `${new URL(raw).origin}/v1`
  } catch {
    return MIAU_BASE_URL
  }
}
