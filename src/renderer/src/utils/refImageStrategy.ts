/**
 * refImageStrategy - 参考图「base64 inline vs COS URL」判定的单一真源。
 *
 * 背景:不同出图端点对参考图的接收方式不同 ——
 *   - Gemini 原生 generateContent:既支持 base64 `inline_data`,也支持公网 URL
 *     `file_data.file_uri`(ApiService.buildGeminiNativePayload 按前缀自动分流);
 *   - OpenAI /images/generations:只认 base64。
 *
 * 之前各页面把「是否走 base64 inline」硬编码(const wantsInlineBase64 = false),
 * 没有单一真源。这里统一从模型配置 `inlineRefImageAsBase64` 读取:
 *   - 想让某模型切回 base64 inline → 只改该 ModelConfig 一处,所有页面自动跟随;
 *   - 默认(falsy)→ 走 COS URL,缩小请求体、省渲染进程内存。
 */

import type { ModelConfig } from '../services/api/ApiService'

/**
 * 当前模型是否需要参考图以 base64 `inline_data` 发送(否则走 COS URL / file_uri)。
 * 真源:ModelConfig.inlineRefImageAsBase64。仅严格等于 true 才内联,其余一律走 URL。
 */
export function wantsInlineBase64ForModel(
  modelConfig?: Pick<ModelConfig, 'inlineRefImageAsBase64'> | null,
): boolean {
  return modelConfig?.inlineRefImageAsBase64 === true
}
