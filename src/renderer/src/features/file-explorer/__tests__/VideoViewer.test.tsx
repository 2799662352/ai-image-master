import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ImageViewer } from '../ImageViewer'
import { VideoViewer } from '../VideoViewer'
import type { FileTab } from '../types'

/**
 * 这两个查看器**不能**把文件整个读进内存。
 *
 * 原先它们走 `useFileUrl` → `attachments:read-thumb`(名字叫 thumb,其实不缩放),
 * 主进程 `readFile` 整份 + `toString('base64')`,再把那串通过 IPC 结构化克隆送到
 * 渲染端,最后用一个逐字节的 JS 循环还原成 Blob。一个 50MB 的 mp4 就是:50MB 读盘、
 * 主进程里同步拼出约 67MB 字符串、67MB 过 IPC、渲染端 6700 万次循环 —— 两个进程
 * 同时卡住,窗口停止绘制,Windows 弹「未响应」。用户报的「点 workspace 卡死」就是它。
 *
 * `local-file://` 是已注册的特权流式协议(protocolHandler 用 net.fetch,带 Range),
 * 同一个查看器的 PDF 分支早就在用。指过去之后浏览器自己流式取、自己 seek,内存几乎为零。
 */

function tabOf(path: string, kind: FileTab['kind'], name: string): FileTab {
  return {
    id: 't1',
    path,
    name,
    source: 'workspace',
    kind,
    state: null,
    diskContent: '',
    diskMtime: 0,
    dirty: false,
  }
}

const readBinary = vi.fn(async () => ({ ok: true, base64: '', mime: 'video/mp4' }))
const readThumb = vi.fn(async () => ({ ok: true, base64: '', mime: 'video/mp4' }))

beforeEach(() => {
  readBinary.mockClear()
  readThumb.mockClear()
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
    fs: { readBinary },
    attachments: { readThumb },
  }
})

afterEach(() => {
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = undefined
})

describe('VideoViewer', () => {
  it('直接流式播放,不把文件读进内存', async () => {
    const { container } = render(<VideoViewer tab={tabOf('D:/repo/demo.mp4', 'video', 'demo.mp4')} />)

    const video = await waitFor(() => {
      const el = container.querySelector('video')
      expect(el).toBeTruthy()
      return el!
    })
    // 盘符冒号必须编码 —— local-file 是标准 scheme,`local-file:///D:/x` 会被解析成
    // host=`d`，盘符整个丢掉。
    expect(video.getAttribute('src')).toBe('local-file:///D%3A/repo/demo.mp4')
    expect(screen.getByText('demo.mp4')).toBeTruthy()

    // 一次字节读取都不该发生。
    expect(readBinary).not.toHaveBeenCalled()
    expect(readThumb).not.toHaveBeenCalled()
  })

  it('反斜杠路径也能正确成 URL', () => {
    const { container } = render(
      <VideoViewer tab={tabOf('D:\\第28集\\成片_v1.mp4', 'video', '成片_v1.mp4')} />,
    )
    expect(container.querySelector('video')!.getAttribute('src'))
      .toBe('local-file:///D%3A/第28集/成片_v1.mp4')
  })
})

describe('ImageViewer', () => {
  it('直接流式加载,不把文件读进内存', async () => {
    const { container } = render(<ImageViewer tab={tabOf('D:/repo/a.png', 'image', 'a.png')} />)

    const img = await waitFor(() => {
      const el = container.querySelector('img')
      expect(el).toBeTruthy()
      return el!
    })
    expect(img.getAttribute('src')).toBe('local-file:///D%3A/repo/a.png')
    expect(readBinary).not.toHaveBeenCalled()
    expect(readThumb).not.toHaveBeenCalled()
  })
})
