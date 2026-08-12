import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 文件面板的查看器**一律**经 `toStreamableUri` 走流式协议,不得再整份读进内存。
 *
 * ## 旧路错在哪
 *
 * 此前是 IPC 读全文件 → base64 回渲染端 → `fetch('data:…')` 转 blob。它对小图"能用",
 * 但代价一直在,大文件直接崩:`attachments:read-thumb` 的 100MB 上限先把成片挡回去、
 * 回落到 `fs:read-binary` 后整份 base64 跨进程(再胖三分之一)、最后那个一两百 MB 的
 * data: URL 让 Chromium 的 fetch 直接放弃 —— 界面上是 `TypeError: Failed to fetch`。
 * 能放出来的也没有 Range,进度条拖不动。
 *
 * ## 新路为什么这次是对的
 *
 * `local-file://` 此前失败过三次,每次症状都是「protocol.handle 根本不被调用、主进程
 * 零日志」,于是被反复误判成 CSP 或权限问题。真正的原因到这一轮才拿到证据:
 * `<video>` 报的是 `MEDIA_ELEMENT_ERROR: Media load rejected by URL safety check` ——
 * Blink 的 `IsSafeToLoadURL` 在**渲染端**就拒了,请求压根没发出去。
 *
 * 病根是 URL 形状:旧地址 `local-file:///D%3A/...` 的 **host 是空的**,而 `standard: true`
 * 表示按 RFC 3986 通用语法解析,标准 scheme 的空 host 在 Chromium 里是可疑形态
 * (只有 `file` 例外)。所有能正常播放的实例——Electron 官方文档的 `app://bundle/...`、
 * 生产项目 CoWork-OS 的 `media://<token>`——host 都非空。
 *
 * 所以现在:`local-file://media/?p=<编码后的绝对路径>`。host 非空,路径整条塞进查询串
 * (不参与路径规范化,盘符不会被折叠)。配套还有三处:
 *   · `registerSchemesAsPrivileged` 的 `stream: true` —— 官方文档明说媒体元素默认期待
 *     协议缓冲完整个响应,不开这条流式在 `<video>`/`<audio>` 上不成立;
 *   · 主进程自己实现 206 分段(`createReadStream` + `Readable.toWeb`),因为
 *     `net.fetch(file://)` 不返回 `Accept-Ranges`,播放器会认为源不可分段而整份拉
 *     (electron#38749 / #51442);
 *   · `net.fetch` 带 `bypassCustomProtocolHandlers`(electron#49073 给出的解法)。
 *
 * ## 为什么用源码断言这么笨的方式
 *
 * 单测跑在 jsdom 里,`<video src=…>` 不会真的发请求,行为测试**发现不了**走错了哪条路 ——
 * 只有装到 Windows 上真点一下才会暴露。一条会在 CI 里红的断言才拦得住。
 *
 * 要改这里的分工,先在真机上验证新走法能播、能拖进度条,然后连这条测试一起改 ——
 * 而不是绕开。
 */
const VIEWER_DIR = path.join(__dirname, '..')

/**
 * 断言前先剥注释。
 *
 * 这些查看器的注释里必然会**引用**另一条路的名字来解释"为什么不走它"(而那正是
 * 这条纪律最该留下的部分)。不剥的话,一句 `走 local-file:// 流式协议` 就会被判成
 * 违规 —— 测试逼着人把解释删掉,恰好删掉最有价值的东西。
 *
 * 只剥块注释与整行注释,不动代码行里的字符串 —— 后者可能合法地含 `https://`。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*')
    })
    .join('\n')
}

function read(file: string): string {
  return stripComments(readFileSync(path.join(VIEWER_DIR, file), 'utf8'))
}

const STREAMING_VIEWERS = [
  'VideoViewer.tsx',
  'AudioViewer.tsx',
  'ImageViewer.tsx',
  'MarkdownPreview.tsx',
]

// 断言的是 **import 语句**,不是「文件里出现过这个词」——配合上面的 stripComments,
// 判的才是代码真正走了哪条路。
const IMPORTS_IPC = /from '\.\/useFileUrl'/
const IMPORTS_STREAM_URI = /from '\.\/uri'/
/** 手搓的 local-file 字面量(带引号才算),盘符就是在这种拼接里被吞掉的。 */
const HANDROLLED_SCHEME = /['"`]local-file:/

describe('文件面板的查看器一律走流式协议，不走整份 base64', () => {
  it.each(STREAMING_VIEWERS)('%s 用 toStreamableUri 直连协议', (file) => {
    const src = read(file)

    expect(src, `${file} 应当用 toStreamableUri 拼流式地址`).toMatch(IMPORTS_STREAM_URI)
    expect(src, `${file} 不得再走 useFileUrl —— 那条路会把整份文件读进内存`)
      .not.toMatch(IMPORTS_IPC)
    expect(src, `${file} 不得自己拼地址，host 必须非空、路径必须走查询串`)
      .not.toMatch(HANDROLLED_SCHEME)
  })

  it('协议注册带 stream: true —— 少了它媒体元素不按流式响应处理', () => {
    const handler = readFileSync(
      path.join(VIEWER_DIR, '..', '..', '..', '..', 'main', 'file-explorer', 'protocolHandler.ts'),
      'utf8',
    )
    expect(handler).toMatch(/stream:\s*true/)
  })
})
