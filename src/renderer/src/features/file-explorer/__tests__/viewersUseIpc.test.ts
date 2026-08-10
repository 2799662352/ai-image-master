import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 文件面板的图片/视频预览**不得**走 `local-file://`。
 *
 * Windows 上这条路是坏的:Chromium 的 standard-scheme 解析没有 `file://` 才有的
 * 盘符处理,`D%3A` 会在解析阶段塌掉,GET 发出去时盘符已经没了
 * (electron/electron#49073)。失败是**完全静默**的 —— protocol.handle 根本不被
 * 调用、主进程零日志,用户只看到「加载失败」。
 *
 * 为什么要用源码断言这么笨的方式:
 *  · 这条路已经被独立试过三次,每次都是看代码觉得「应该行」;
 *  · 单测跑在 jsdom 里,`<video src="local-file://…">` 不会真的发请求,所以行为
 *    测试**发现不了**它 —— 只有装到 Windows 上真点一下才会暴露;
 *  · 4.5.4 更狠:撤回做过了,却在 squash 合并后同步主干时被当成「无改动」覆盖掉,
 *    坏代码就这么发到了用户机器上。一条会在 CI 里红的断言才拦得住这种事。
 *
 * 真要重新启用它,先解决上游那个盘符问题,然后连这条测试一起改 —— 而不是绕开。
 */
const VIEWERS = ['ImageViewer.tsx', 'VideoViewer.tsx']

describe('文件预览走 IPC，不走 local-file://', () => {
  it.each(VIEWERS)('%s 使用 useFileUrl 而不是 local-file 地址', (file) => {
    const src = readFileSync(path.join(__dirname, '..', file), 'utf8')

    expect(src, `${file} 应当通过 useFileUrl 读字节`).toMatch(/useFileUrl/)
    expect(src, `${file} 不得构造 local-file:// 地址（Windows 上盘符会被吞掉）`)
      .not.toMatch(/toRenderableUri|local-file:/)
  })
})
