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
