/**
 * mediaFallback — 缩略图「候选源链」的纯逻辑。
 *
 * ## 为什么缩略图会破
 *
 * 聊天里的出图气泡与生成页的结果格,展示的 URL 有三种来路,可靠性差很多:
 *
 *  1. **模型直出的预签名 COS 链接**(`…cos.ap-guangzhou.myqcloud.com/…?q-sign-time=a;b&…`)。
 *     签名窗口只有几小时。自有 COS 转存成功后 store 会把它热切成永久链接;转存
 *     **失败**(网关抖动、翻墙时主进程下载不到)时 history 里就留着这条直出链接,
 *     过了 `b` 之后每次打开都是 403 —— 「有时候缩略图会破」的主因。
 *  2. **自有 COS 永久链接**(+ 数据万象 `imageMogr2` 缩略参数)。链接不过期,但请求
 *     要真的到达腾讯云:开着代理 / TUN 时出口在境外,COS 可能超时或被拒 ——
 *     「翻墙的时候可能会没有」。
 *  3. **本地副本**(`local-file:///…` / `file:///…`,主进程上传前已落盘)。走 IPC
 *     读盘,不经网络、永不过期 —— 是最可靠的一层,但此前只在 history 里一个 URL 都
 *     没有时才会被用到。
 *
 * 这里把它们排成一条**候选链**,数据万象缩略 URL 始终是主源:过期的签名链接直接
 * 跳过(必 403,不浪费一次请求);主源允许指数退避多次重试(代理抖动、COS 偶发
 * 超时,不能失败两次就撒手);还是不行才换下一条(裸 URL → 本地副本);全链耗尽落到
 * 占位卡,但占位卡会定时自动从主源再来(见 `useMediaCandidates`),「重载」只是手动加速。
 */

export interface SignedUrlWindow {
  /** 秒级 epoch。 */
  start: number
  end: number
}

/**
 * 解析预签名链接的有效期。目前认两种写法:
 *  - 腾讯 COS:`q-sign-time=<start>;<end>`(秒);
 *  - S3 / R2 风格:`X-Amz-Date=…&X-Amz-Expires=<秒>`,或旧式 `Expires=<epoch 秒>`。
 * 认不出返回 null(视为不过期,交给网络层判断)。
 */
export function parseSignedUrlWindow(url: string): SignedUrlWindow | null {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null
  const q = url.indexOf('?')
  if (q < 0) return null
  const query = url.slice(q + 1)

  const cos = /(?:^|&)q-sign-time=(\d{9,11});(\d{9,11})(?:&|$)/.exec(query)
  if (cos) return { start: Number(cos[1]), end: Number(cos[2]) }

  const amzDate = /(?:^|&)X-Amz-Date=(\d{8})T(\d{6})Z(?:&|$)/i.exec(query)
  const amzExpires = /(?:^|&)X-Amz-Expires=(\d{1,8})(?:&|$)/i.exec(query)
  if (amzDate && amzExpires) {
    const d = amzDate[1]
    const t = amzDate[2]
    const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}Z`
    const start = Math.floor(new Date(iso).getTime() / 1000)
    if (!Number.isFinite(start)) return null
    return { start, end: start + Number(amzExpires[1]) }
  }

  const legacy = /(?:^|&)Expires=(\d{9,11})(?:&|$)/.exec(query)
  if (legacy) return { start: 0, end: Number(legacy[1]) }

  return null
}

/** 签名已过期 → 请求必 403,不该再发。留 60s 余量吃掉时钟偏差。 */
export function isExpiredSignedUrl(url: string, nowMs: number = Date.now()): boolean {
  const w = parseSignedUrlWindow(url)
  if (!w) return false
  return nowMs / 1000 > w.end + 60
}

export function isRemoteHttpUrl(src: string): boolean {
  return /^https?:\/\//i.test(src)
}

/**
 * 把「主源 + 兜底源」整理成按优先级去重后的候选链:
 *  - 丢空串 / 非字符串;
 *  - 丢已过期的签名链接(它们不是「可能失败」,是**一定**失败);
 *  - 同一 URL 只留第一次出现。
 * 全部被丢光时返回空数组 —— 调用方据此直接画占位卡,不发任何请求。
 */
export function buildMediaCandidates(
  primary: string | undefined,
  fallbacks: ReadonlyArray<string | undefined> | undefined,
  nowMs: number = Date.now(),
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of [primary, ...(fallbacks ?? [])]) {
    if (typeof raw !== 'string') continue
    const src = raw.trim()
    if (!src || seen.has(src)) continue
    if (isExpiredSignedUrl(src, nowMs)) continue
    seen.add(src)
    out.push(src)
  }
  return out
}
