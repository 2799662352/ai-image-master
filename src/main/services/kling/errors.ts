/**
 * 可灵上游错误 → 人话。约定与 `wan3/errors.ts` 相同:**认不出就原样返回**,翻译带上原文。
 *
 * ## 证据分级
 *
 * 只写**有出处**的三条:
 * - 并发满、内容审核:new-api #183 的测试用例里贴着腾讯 VOD 的真实回包
 *   (`FINISH` + `ErrCode 70000`,`GenerateVideo task reached the maximum concurrency.` /
 *   `Your request was blocked by our moderation system`),网关把它们落成失败并退款;
 * - 通道不存在:网关对没开通该模型的分组回 `model_not_found`,与万相同一个码。
 *
 * 万相那张表 `translateWan3Error` 对所有视频错误都跑(它没按模型区分),其中
 * `model_not_found` 一条写死了「万相 3.0」—— 可灵漏进去会指错方向,所以可灵这张要**排在前面**,
 * 并且只认带 `kling` 字样的,别的模型的同码错误仍交给万相那张。
 */

interface KlingErrorHint {
  /** 命中判据:全部满足(都用小写子串比较)。 */
  all: readonly (readonly string[])[]
  hint: string
}

const HINTS: readonly KlingErrorHint[] = [
  {
    all: [['maximum concurrency']],
    hint:
      '可灵账号的并发已满（同一账号最多同时跑 5 个任务），这次没有生成成片，网关按失败处理、预扣的费用会退回。' +
      '等进行中的任务跑完再提交；批量生成时减少同时启动的卡片数。',
  },
  {
    all: [['blocked by our moderation system', 'moderation system']],
    hint: '提示词或参考素材没通过可灵的内容审核，这次没有生成成片。请调整措辞或更换素材后重试 —— 同一份内容重复提交只会再被拒一次。',
  },
  {
    all: [['kling'], ['model_not_found', 'no available channel']],
    hint: '当前密钥的分组下没有开通可灵 4.0 通道。请确认这枚 Miau 密钥有可灵（kling-v4-vod / kling-v4-omni-vod）的调用权限。',
  },
]

export function translateKlingError(message: string): string {
  const haystack = message.toLowerCase()
  for (const { all, hint } of HINTS) {
    if (all.every((anyOf) => anyOf.some((needle) => haystack.includes(needle)))) {
      return `${hint}（上游原文：${message}）`
    }
  }
  return message
}
