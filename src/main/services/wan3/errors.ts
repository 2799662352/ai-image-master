/**
 * 万相上游错误 → 人话。
 *
 * 用户看到的原文长这样：`万相 API 400: DataInspectionFailed: input data may
 * contain inappropriate content` —— 英文、且没说清「我该怎么办」。这里的每一条
 * 都要回答后半句。
 *
 * ## 证据分级
 *
 * 带「实测」的是 2026-08-14 对着真网关探出来的原始回包；其余来自 DashScope 公开
 * 文档的错误码表。**没把握的不写** —— 猜一句错误解释比原样透出更糟：原文至少是
 * 真的，用户还能拿它去搜。
 *
 * 匹配用大小写不敏感的子串：网关有时透传上游原码（`DataInspectionFailed`），
 * 有时套一层自己的下划线码（`model_not_found`），两种形态都得认。
 */

interface Wan3ErrorHint {
  /** 命中判据。任一子串出现即命中，按数组顺序取第一个。 */
  match: readonly string[]
  hint: string
}

const HINTS: readonly Wan3ErrorHint[] = [
  {
    // 实测：查一个不存在的任务号，网关回 400 `task_not_exist`。
    match: ['task_not_exist'],
    hint: '任务在上游已不存在（通常是过期或已被清理）。这张卡的结果取不回来了，需要重新生成。',
  },
  {
    // 实测：当前密钥分组下没有该模型通道时，网关按 5xx 回 `model_not_found`。
    match: ['model_not_found'],
    hint: '当前密钥的分组下没有开通万相 3.0 通道。请确认这枚 Miau 密钥有万相的调用权限。',
  },
  {
    // 实测：不带密钥时回 `InvalidApiKey: No API-key provided.`
    match: ['invalid_api_key', 'invalidapikey', 'no api-key'],
    hint: 'Miau 密钥无效或未生效。请在设置里检查图片生成的 Miau Key。',
  },
  {
    match: ['insufficient_quota', 'insufficientbalance', 'insufficient balance'],
    hint: '账户余额或额度不足。万相按秒计费，请先充值再生成。',
  },
  {
    // 内容审核。万相这条路很容易撞到，而原文只说 "inappropriate content"，
    // 用户不改提示词就会一直撞同一堵墙。
    match: ['datainspectionfailed', 'data_inspection_failed', 'inappropriate content'],
    hint: '提示词或参考素材没通过上游内容审核。请调整措辞或更换素材后重试 —— 重复提交同一份内容只会再被拒一次。',
  },
  {
    match: ['ipinfringementsuspect', 'ip_infringement'],
    hint: '上游判定内容可能涉及知识产权风险（多为知名角色、品牌或商标）。请更换描述或参考图。',
  },
  {
    // 万相只认公网 https 直链。素材传给它之后是**它**去下载,下不动就报这个 ——
    // 我们这边一切正常,所以要明确指出问题在素材地址上,否则无从查起。
    match: ['downloadfilefailed', 'download_file_failed', 'invalidfile', 'urlerror', 'invalid url'],
    hint: '上游下载素材失败。万相需要能公网访问的素材直链 —— 请确认素材已上传成功且链接未过期，然后重试。',
  },
  {
    match: ['throttling', 'requestlimitexceeded', 'rate limit', 'too many requests'],
    hint: '上游限流。稍等片刻再试；批量生成时可以减少同时启动的卡片数。',
  },
  {
    // 实测（2026-08-14，用 21:9 探的）：这条是**异步**的 —— 创建接口回 200/queued，
    // 任务照常排队跑了一分钟才失败，而那一分钟是计费的。所以提示要说清「改参数
    // 再来」而不是「重试」，重试同一份参数只会再烧一次钱。
    //
    // 上游原文通常已经把合法值列全了（`Input should be '16:9', '4:3', … or
    // 'adaptive': parameters.ratio`），所以这里不复述清单 —— 保留原文比我们
    // 再抄一份准，抄的那份还会随上游变更过期。
    match: ['invalidparameter', 'invalid_parameter'],
    hint: '参数不合法，上游已指出是哪一个（见下方原文）。改掉它再提交；原样重试只会再等一次、再花一次钱。',
  },
]

/**
 * 未识别的错误**原样返回**。
 *
 * 兜底不套一句「生成失败，请重试」之类的话 —— 那会把原文里唯一有用的线索
 * （上游错误码）盖掉，用户和我们都再也查不下去。
 */
export function translateWan3Error(message: string): string {
  const haystack = message.toLowerCase()
  for (const { match, hint } of HINTS) {
    if (match.some((needle) => haystack.includes(needle))) {
      // 保留原文:翻译是给用户看的,原码是给排查用的,两者都不能丢。
      return `${hint}（上游原文：${message}）`
    }
  }
  return message
}
