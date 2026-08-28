import type { Session } from 'electron'
// 渲染层用这个标记声明「本次请求走平台余额」。**常量只有 `types/authApi.ts` 那一份**
// (那边写了为什么):这里曾经也有一份同字面量的副本,而两份副本的漂移不会让任何
// 测试变红 —— 两边测试各自硬编码自己那份,只改一边照样双绿,线上却每个请求 401。
import { BILLING_MARKER_HEADER, BILLING_MARKER_VALUE } from '../../../types/authApi'
import { getActivePoolToken } from './gatewayToken'

const BILLING_MARKER_HEADER_LC = BILLING_MARKER_HEADER.toLowerCase()
const AUTHORIZATION_HEADER = 'Authorization'
const AUTHORIZATION_HEADER_LC = AUTHORIZATION_HEADER.toLowerCase()

/**
 * 按大小写不敏感找头名,返回**实际那个键**。
 *
 * HTTP 头名本来就大小写不敏感,所以 `headers['X-Catimation-Billing']` 这种字面量
 * 取值在头表上就是错的,不管 Chromium 当天给的是哪种拼写。而渲染层出图走的是
 * `fetch()`,Fetch 规范要求 `Headers` 把头名**归一化成小写** —— 精确查表必然落空。
 *
 * 失效方向虽然是 fail-closed(不注入 → 网关 401,不泄漏),但症状是「看着接好了、
 * 一次都不生效」,比响亮的报错难查得多,而且极容易被误判成后端故障。
 *
 * 返回真实键而不是布尔值,是因为删除必须删**送进来的那个拼写**,不能删我们猜的那个。
 */
function findHeaderKey(headers: Record<string, string>, lowerName: string): string | undefined {
  return Object.keys(headers).find((k) => k.toLowerCase() === lowerName)
}

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
    const markerKey = findHeaderKey(headers, BILLING_MARKER_HEADER_LC)
    if (!markerKey || headers[markerKey] !== BILLING_MARKER_VALUE) {
      callback({ requestHeaders: headers })
      return
    }
    delete headers[markerKey]

    // 打了标记就是声明「本次走平台余额」,所以渲染层带来的任何 Authorization 都不作数,
    // **先一律删掉再决定要不要写自己的**。三件事都靠这一步:
    //
    // 1. 取不到 token 时,不删就等于**静默地用用户自己的 key 出图成功** —— 用户以为
    //    在花平台余额,实际在花自己的。删掉让它裸奔去撞 401,渲染层按既有错误路径
    //    提示「请先选择计费池」。刻意不在这里静默放行成功。
    // 2. 取得到 token 时,渲染层送来的是小写 `authorization`(fetch 归一化),而我们
    //    写回去的是 `Authorization` —— 只设不删的话两个头会一起出网,网关看到重复的
    //    Authorization,行为未定义。
    // 3. 删的是**实际那个键**,不是我们猜的拼写。
    const staleAuthKey = findHeaderKey(headers, AUTHORIZATION_HEADER_LC)
    if (staleAuthKey) delete headers[staleAuthKey]

    const token = getActivePoolToken()
    if (token) {
      headers[AUTHORIZATION_HEADER] = `Bearer ${token}`
    }
    callback({ requestHeaders: headers })
  })
}
