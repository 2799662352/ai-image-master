import type { Session } from 'electron'
import { getActivePoolToken } from './gatewayToken'

/**
 * 渲染层用它声明「本次请求走平台余额」。
 *
 * 用标记头而不是无条件注入,是因为用户仍可以用自己填的 API Key —— 无条件注入
 * 会把它覆盖掉。标记在出网前会被删除,不让内部协议泄漏到上游日志里。
 */
export const BILLING_MARKER_HEADER = 'X-Catimation-Billing'
export const BILLING_MARKER_VALUE = 'platform'

// ⚠️ **这个 host 白名单是本方案的安全支点。**
//
// 过滤器一旦放宽(比如写成 `*://*/*`),凭据会被贴到应用发出的每一个请求上 ——
// 包括第三方图床、更新检查、任何遥测。改这一行之前先想清楚。
//
// 这段刻意用 `//` 而不是 JSDoc:上面那个通配符里的 `*` `/` 两字符连在一起就是块
// 注释的结束符,写进 `/** */` 会把注释在半路闭掉,后半段变成语法错误的代码。
const GATEWAY_URL_FILTER = { urls: ['https://miauapi.13797248455.xyz/*'] }

/**
 * ⚠️ 同一个 session 上**只有最后挂的 `onBeforeSendHeaders` listener 生效**
 * (Electron 官方文档明写)。将来若有别处也要挂,必须合并成一个 listener,
 * 不能各挂各的 —— 那样先挂的会被静默顶掉。
 * 本仓当前只有 CSP 用了 `onHeadersReceived`(不同事件,不冲突)。
 */
export function installGatewayHeaderInjector(session: Session): void {
  session.webRequest.onBeforeSendHeaders(GATEWAY_URL_FILTER, (details, callback) => {
    const headers = details.requestHeaders
    if (headers[BILLING_MARKER_HEADER] !== BILLING_MARKER_VALUE) {
      callback({ requestHeaders: headers })
      return
    }
    delete headers[BILLING_MARKER_HEADER]

    const token = getActivePoolToken()
    if (token) {
      headers.Authorization = `Bearer ${token}`
    }
    // 取不到就让它带着空 Authorization 出去 —— 网关回 401,渲染层走既有错误
    // 路径提示「请先选择计费池」。**刻意不在这里静默放行成功**,否则用户会以为
    // 在花平台余额,实际用的是别的凭据。
    callback({ requestHeaders: headers })
  })
}
