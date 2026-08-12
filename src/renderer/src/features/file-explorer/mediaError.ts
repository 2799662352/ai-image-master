/**
 * 把 `<video>` / `<audio>` 的失败原因翻成一句能直接定性的话。
 *
 * `MediaError.code` 只有四个取值,但它恰好把三种完全不同的病分得干干净净 ——
 * 而在界面上它们长得一模一样(都是「放不出来」),不看这个码就只能猜:
 *
 *   4 SRC_NOT_SUPPORTED  地址/格式压根没被接受。配合「主进程协议处理器一条日志
 *                        都没有」,就是自定义协议没在渲染端生效 —— 传输层的问题。
 *   3 DECODE             字节**已经拿到了**,是 Chromium 解不了这个编码(H.265/HEVC
 *                        之类)。此时换任何传输方式都一样放不出来,跟协议无关。
 *   2 NETWORK            开头能读、中途断了。多半是流被提前关闭或 Range 没处理好。
 *   1 ABORTED            用户/代码主动中止,一般不是故障。
 *
 * 把它摆在界面上而不是只丢进 console:排查时要人去 DevTools 里翻,信息就经常拿不到。
 */
export function describeMediaError(element: HTMLMediaElement | null | undefined): string {
  const err = element?.error
  if (!err) return '未知错误（没有 MediaError）'
  const label =
    err.code === 1 ? 'ABORTED · 加载被中止'
      : err.code === 2 ? 'NETWORK · 取字节中途失败'
        : err.code === 3 ? 'DECODE · 字节已拿到，但这个编码解不了'
          : err.code === 4 ? 'SRC_NOT_SUPPORTED · 地址或格式未被接受'
            : `code ${err.code}`
  const detail = err.message?.trim()
  return detail ? `${label}（${detail}）` : label
}
