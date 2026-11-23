/**
 * 渲染进程的 Content-Security-Policy。
 *
 * 原来内联在 `createWindow()` 里;抽出来是为了能对它写测试 —— 这条策略里的每一处
 * `http:` 例外都是有意的,而「不小心多放行一个源」没有任何运行时症状。
 */

/**
 * `connect-src` 为什么放行**所有** `http:`:
 *
 * 设置页的「自定义网关」要让用户填任意地址 —— 本机、局域网、公网部署的 new-api
 * (很多自建网关只有 `http://<IP>:3000`,没配证书)。CSP 没法写网段,也没法在用户
 * 保存地址时热更新(它在页面加载时就定了,改它要整页重载,会丢掉进行中的对话),
 * 所以只能整个协议放行。
 *
 * 这不是把防线拆了:
 *  - 同一条策略里 `https:` / `wss:` 本来就对任意主机放行,攻击者想外传数据有的是路;
 *  - 渲染进程开着 `nodeIntegration`,真有脚本注入时 `require('http')` 比 CSP 能拦的多得多。
 * CSP 在这里挡的是**注入的标记**(markdown 里的 `<img>`、`<link>` 之类)去敲内网,
 * 那是 `img-src` / `media-src` 的事 —— **这两条刻意没有放开 `http:`**。
 * `main/utils/remoteImageGuard.ts` 的注释正是建立在「渲染端 `<img>` 加载不了
 * `http://内网/…`」之上的,放开它会让那条防线的前提悄悄失效。
 *
 * 原先写死的 `http://127.0.0.1:*` / `http://localhost:*`(本地服务)与两台旧网关 IP
 * (`175.178.198.17` / `43.161.233.87`,给存量历史图片的 `fetch` 下载 / 复制留的)
 * 都被 `http:` 覆盖,不再单列。`img-src` / `media-src` 里的两台旧 IP 仍保留 —— 那是
 * 存量历史图片**显示**用的,见下面。
 */
export function buildContentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' node: https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    // tldraw loads its IBM Plex / Shantell Sans woff2 fonts from its CDN
    // (https://cdn.tldraw.com/<version>/fonts/*). Without this origin the
    // canvas throws a font-src CSP violation + NetworkError on mount.
    "font-src 'self' https://fonts.gstatic.com https://cdn.tldraw.com data:",
    // Miau 网关本身已改走 https 加速域名(落在通配的 `https:` 里),但这几条
    // 明文例外**不能撤**:它们是 v4.3.40 接入万相/腾讯 Image2 时为「显示图片」
    // 加的,而历史记录在 COS 转存失败时会原样存下模型直出 URL —— 存量条目里
    // 可能就躺着 http://175.178.198.17:3000/... 。撤掉会让这些老图无声裂开,
    // 而留着它零成本(已经不再向该主机发起新请求)。
    "img-src 'self' data: blob: https: http://175.178.198.17:* http://43.161.233.87:* file: local-file:",
    // blob: is required for tldraw image export: toImageDataUrl/exportToSvg
    // fetch() the image's blob: object URL to inline it as a data URI. Without
    // it the canvas edit pipeline can't produce a targetImagePath (export throws
    // "Refused to connect"/timeout), so annotations never reach the edit queue.
    // `http:` 的来历见文件头。
    "connect-src 'self' https: wss: data: blob: local-file: http:",
    // allow COS HTTPS presigned URLs (smart erase output), file:// (compare-with-original),
    // and local-file:// for the file-explorer video previewer.
    "media-src 'self' data: blob: https: http://175.178.198.17:* http://43.161.233.87:* file: local-file:",
    "worker-src 'self' blob:", // 允许 Web Worker 从 blob URL 创建（图片压缩库需要）
    "frame-src https:",
  ].join('; ')
}
