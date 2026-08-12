import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 工作台的**播放类**表面一律走流式协议,不得把整份文件读进内存。
 *
 * ## 为什么这条值得单独钉
 *
 * 这里和文件面板不同的地方是**份数**:结果播放器是每张 succeeded 卡片各一份,
 * 而卡片总量上限已于 2026-08-11 取消。一板十张成片走旧路就是十份视频常驻渲染
 * 进程内存,且 blob 要等组件卸载才释放。旧路还没有 Range —— `seekable.end()` 恒为 0,
 * 进度条拖不动。
 *
 * `useFileUrl` / `useResolvedMediaSrc` 的取字节路径都是「IPC 读全文件 → base64 →
 * fetch('data:…') → blob」。成片 mp4 base64 之后一两百 MB,Chromium 的 fetch 会直接
 * 放弃(界面上是 `TypeError: Failed to fetch`)。
 *
 * ## 哪些**不在**这条纪律里(故意的)
 *
 * · **素材缩略图**走 `readMediaThumb`,返回 5–30KB 的缩略 JPEG,不是原文件 —— 本来
 *   就对,不要跟着改。
 * · **高级编辑抽帧**(WorkbenchCard 的 aveVideoSrc)必须留在 blob:。它要把 `<video>`
 *   画到 canvas 再 `toDataURL`,而 canvas 画进跨源内容就会被污染、`toDataURL` 抛
 *   SecurityError。`blob:` 同源,`local-file://` 不是。要迁得先给协议加 CORS 头并给
 *   `<video>` 设 `crossOrigin`,那是独立一笔。WorkbenchCard 里有完整说明。
 * · **图片**没有 Range 可言,留在既有链路。
 *
 * ## 为什么用源码断言
 *
 * jsdom 不发真实请求,走错哪条路在行为上看不出来 —— 只有装到真机上点开一段大视频
 * 才会暴露。同 file-explorer 的 viewersUseIpc 守卫,一条会在 CI 里红的断言才拦得住。
 */
const DIR = path.join(__dirname, '..')

/** 剥注释再断言:注释里必然要提到另一条路的名字来解释「为什么不走它」。 */
function readCode(file: string): string {
  return readFileSync(path.join(DIR, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*')
    })
    .join('\n')
}

const PLAYBACK_SURFACES = ['ResultVideoPlayer.tsx', 'MaterialPreviewModal.tsx']

describe('工作台播放表面走流式协议', () => {
  it.each(PLAYBACK_SURFACES)('%s 用 toStreamableUri，不整份读进内存', (file) => {
    const code = readCode(file)

    expect(code, `${file} 应当用 toStreamableUri 拼流式地址`).toMatch(/toStreamableUri/)
    expect(code, `${file} 不得再走 useFileUrl —— 每张卡片各一份整片进内存`)
      .not.toMatch(/from '.*useFileUrl'/)
    expect(code, `${file} 不得自己拼地址，host 必须非空、路径必须走查询串`)
      .not.toMatch(/['"`]local-file:/)
  })

  it('高级编辑抽帧仍留在 blob: —— canvas 取像素不能用跨源地址', () => {
    const code = readCode('WorkbenchCard.tsx')
    expect(code).toMatch(/useResolvedMediaSrc\(/)
    expect(code).toMatch(/fullFidelity:\s*true/)
    expect(code, '抽帧源改成流式地址会让 toDataURL 抛 SecurityError')
      .not.toMatch(/aveVideoSrc\s*=\s*toStreamableUri/)
  })
})
