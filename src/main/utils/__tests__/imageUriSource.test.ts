// @vitest-environment node
/**
 * 「复制图片」「另存为」的地址解析与取字节。
 *
 * 回归:这两个 IPC 原先只认 file:// 和裸路径(`uri.startsWith('file://') ? fileURLToPath(uri) : uri`),
 * 渲染端传 `local-file:///C:/…`(规范本地地址)或 https(生成图成品)时直接 ENOENT,
 * 缩略图上的「下载」不看返回值 —— 点了没反应。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  MAX_REMOTE_IMAGE_BYTES,
  copyImageUri,
  parseImageUri,
  readRemoteOrInlineBytes,
  saveImageUri,
  suggestImageFileName,
  type CopyImageDeps,
  type FetchLike,
  type SaveImageDeps,
} from '../imageUriSource'

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function fetchOk(bytes: Buffer, headers: Record<string, string> = { 'content-type': 'image/png' }): FetchLike {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  }))
}

describe('parseImageUri', () => {
  it('local-file:///C:/… → Windows 路径(含中文 / 空格解码)', () => {
    const r = parseImageUri('local-file:///C:/Users/a/%E6%B5%8B%E8%AF%95%20dir/x.png', 'win32')
    expect(r).toEqual({ ok: true, source: { kind: 'path', path: 'C:\\Users\\a\\测试 dir\\x.png' } })
  })

  it('Chromium 回读的 local-file://c/… 小写盘符 host 形态', () => {
    const r = parseImageUri('local-file://c/Users/a/x.png', 'win32')
    expect(r).toEqual({ ok: true, source: { kind: 'path', path: 'C:\\Users\\a\\x.png' } })
  })

  it('local-file 带 .. → 拒绝(不能借复制 / 另存为读到目录外)', () => {
    const r = parseImageUri('local-file:///C:/a/../Windows/win.ini', 'win32')
    expect(r.ok).toBe(false)
  })

  it('file:/// → 路径', () => {
    const r = parseImageUri('file:///C:/a/b.png', 'win32')
    expect(r).toEqual({ ok: true, source: { kind: 'path', path: 'C:\\a\\b.png' } })
  })

  it('裸 Windows 路径 / UNC / POSIX 绝对路径原样当路径', () => {
    expect(parseImageUri('D:\\x\\y.png', 'win32')).toEqual({ ok: true, source: { kind: 'path', path: 'D:\\x\\y.png' } })
    expect(parseImageUri('\\\\srv\\share\\y.png', 'win32')).toEqual({ ok: true, source: { kind: 'path', path: '\\\\srv\\share\\y.png' } })
    expect(parseImageUri('/home/u/y.png', 'linux')).toEqual({ ok: true, source: { kind: 'path', path: '/home/u/y.png' } })
  })

  it('https / http → http', () => {
    expect(parseImageUri('https://cdn.example.com/a.png')).toEqual({ ok: true, source: { kind: 'http', url: 'https://cdn.example.com/a.png' } })
    expect(parseImageUri('http://x/a.png')).toMatchObject({ ok: true, source: { kind: 'http' } })
  })

  it('data:image;base64 → 字节 + mime;非 base64 / 空内容 → 拒绝', () => {
    const r = parseImageUri(`data:image/png;base64,${PNG.toString('base64')}`)
    expect(r.ok && r.source.kind === 'data' && r.source.bytes.equals(PNG) && r.source.mime === 'image/png').toBe(true)
    expect(parseImageUri('data:image/png,abc').ok).toBe(false)
    expect(parseImageUri('data:text/html;base64,PGI+').ok).toBe(false)
    expect(parseImageUri('data:image/png;base64,').ok).toBe(false)
  })

  it('blob: 明确拒绝并说明原因(只在渲染进程有效)', () => {
    const r = parseImageUri('blob:file:///abc')
    expect(r).toEqual({ ok: false, error: expect.stringContaining('blob:') })
  })

  it('空 / 非字符串 / 相对路径 / 其它 scheme → 拒绝', () => {
    for (const bad of ['', undefined, null, 42, 'relative/a.png', 'ftp://x/a.png', 'javascript:alert(1)']) {
      expect(parseImageUri(bad as never).ok).toBe(false)
    }
  })
})

describe('readRemoteOrInlineBytes', () => {
  it('http 成功:字节 + mime(去掉 charset 等参数)', async () => {
    const f = fetchOk(PNG, { 'content-type': 'Image/PNG; charset=binary' })
    const r = await readRemoteOrInlineBytes({ kind: 'http', url: 'https://x/a' }, { fetch: f })
    expect(r).toMatchObject({ ok: true, mime: 'image/png' })
    expect(r.ok && r.bytes.equals(PNG)).toBe(true)
  })

  it('HTTP 非 2xx → 带状态码的错误', async () => {
    const f: FetchLike = async () => ({ ok: false, status: 403, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) })
    expect(await readRemoteOrInlineBytes({ kind: 'http', url: 'https://x/a' }, { fetch: f })).toEqual({
      ok: false,
      error: '下载图片失败:HTTP 403',
    })
  })

  it('网络异常 → 错误而不是抛出', async () => {
    const f: FetchLike = async () => {
      throw new Error('ECONNRESET')
    }
    expect(await readRemoteOrInlineBytes({ kind: 'http', url: 'https://x/a' }, { fetch: f })).toEqual({
      ok: false,
      error: '下载图片失败:ECONNRESET',
    })
  })

  it('Content-Length 声明超限 → 不读正文;没声明但实际超限也拦', async () => {
    const body = vi.fn(async () => new ArrayBuffer(0))
    const f1: FetchLike = async () => ({
      ok: true,
      status: 200,
      headers: { get: (k: string) => (k.toLowerCase() === 'content-length' ? String(MAX_REMOTE_IMAGE_BYTES + 1) : null) },
      arrayBuffer: body,
    })
    const r1 = await readRemoteOrInlineBytes({ kind: 'http', url: 'https://x/a' }, { fetch: f1 })
    expect(r1.ok).toBe(false)
    expect(body).not.toHaveBeenCalled()

    const r2 = await readRemoteOrInlineBytes({ kind: 'http', url: 'https://x/a' }, { fetch: fetchOk(PNG), maxBytes: 4 })
    expect(r2.ok).toBe(false)
  })

  it('data 来源直接返回字节,不联网', async () => {
    const f = vi.fn() as unknown as FetchLike
    const r = await readRemoteOrInlineBytes({ kind: 'data', bytes: PNG, mime: 'image/png' }, { fetch: f })
    expect(r).toMatchObject({ ok: true, mime: 'image/png' })
    expect(f).not.toHaveBeenCalled()
  })
})

describe('suggestImageFileName', () => {
  it('已有扩展名原样;没有就按 mime 补;非法字符替换', () => {
    expect(suggestImageFileName('night.jpg')).toBe('night.jpg')
    // 名字已有扩展名时,不被 mime 覆盖成 night.jpg.png
    expect(suggestImageFileName('night.jpg', 'image/png')).toBe('night.jpg')
    expect(suggestImageFileName('0', 'image/png')).toBe('0.png')
    expect(suggestImageFileName('0', 'image/jpeg')).toBe('0.jpg')
    expect(suggestImageFileName('0')).toBe('0')
    expect(suggestImageFileName('a:b?.png')).toBe('a_b_.png')
    expect(suggestImageFileName('')).toBe('image')
  })
})

function copyDeps(over: Partial<CopyImageDeps> = {}): CopyImageDeps & { calls: string[] } {
  const calls: string[] = []
  const img = { isEmpty: () => false, toPNG: () => PNG }
  return {
    calls,
    platform: 'win32',
    fetch: fetchOk(PNG),
    createFromPath: (p) => {
      calls.push(`path:${p}`)
      return img
    },
    createFromBuffer: (b) => {
      calls.push(`buffer:${b.length}`)
      return img
    },
    writeImage: async () => {
      calls.push('write')
      return true
    },
    ...over,
  }
}

describe('copyImageUri', () => {
  it('local-file → 按解析后的路径读,写剪贴板', async () => {
    const d = copyDeps()
    expect(await copyImageUri('local-file:///D:/r/night.jpg', d)).toEqual({ success: true })
    expect(d.calls).toEqual(['path:D:\\r\\night.jpg', 'write'])
  })

  it('https → 下载字节再解码(原先会被当路径读而失败)', async () => {
    const d = copyDeps()
    expect(await copyImageUri('https://cdn.example.com/a.png', d)).toEqual({ success: true })
    expect(d.fetch).toHaveBeenCalledWith('https://cdn.example.com/a.png')
    expect(d.calls).toEqual([`buffer:${PNG.length}`, 'write'])
  })

  it('data: → 不联网直接解码', async () => {
    const d = copyDeps()
    await copyImageUri(`data:image/png;base64,${PNG.toString('base64')}`, d)
    expect(d.fetch).not.toHaveBeenCalled()
    expect(d.calls).toEqual([`buffer:${PNG.length}`, 'write'])
  })

  it('解码出空图 → 失败,不碰剪贴板', async () => {
    const d = copyDeps({ createFromPath: () => ({ isEmpty: () => true, toPNG: () => PNG }) })
    expect(await copyImageUri('D:\\x.png', d)).toEqual({ success: false, error: 'unable to load image' })
    expect(d.calls).not.toContain('write')
  })

  it('下载失败 / 地址不合法 → 带原因的失败', async () => {
    const f: FetchLike = async () => ({ ok: false, status: 500, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) })
    expect(await copyImageUri('https://x/a.png', copyDeps({ fetch: f }))).toEqual({ success: false, error: '下载图片失败:HTTP 500' })
    expect(await copyImageUri('blob:x', copyDeps())).toMatchObject({ success: false })
  })
})

function saveDeps(over: Partial<SaveImageDeps> = {}): SaveImageDeps & { log: string[]; picked: string[] } {
  const log: string[] = []
  const picked: string[] = []
  return {
    log,
    picked,
    platform: 'win32',
    fetch: fetchOk(PNG, { 'content-type': 'image/png' }),
    pickSavePath: async (name) => {
      picked.push(name)
      return 'C:\\out\\saved.png'
    },
    copyFile: async (from, to) => {
      log.push(`copy:${from}->${to}`)
    },
    writeFile: async (to, bytes) => {
      log.push(`write:${to}:${bytes.length}`)
    },
    basename: (p) => p.split(/[\\/]/).pop() ?? p,
    ...over,
  }
}

describe('saveImageUri', () => {
  it('local-file → 复制原文件(原先 copyFile(local-file://…) 直接 ENOENT)', async () => {
    const d = saveDeps()
    expect(await saveImageUri('local-file:///D:/r/night.jpg', 'night.jpg', d)).toEqual({ success: true, path: 'C:\\out\\saved.png' })
    expect(d.picked).toEqual(['night.jpg'])
    expect(d.log).toEqual(['copy:D:\\r\\night.jpg->C:\\out\\saved.png'])
  })

  it('路径来源没传名字 → 用文件 basename 当默认名', async () => {
    const d = saveDeps()
    await saveImageUri('D:\\r\\night.jpg', undefined, d)
    expect(d.picked).toEqual(['night.jpg'])
  })

  it('https → 先下载再弹框,写字节;默认名按 mime 补扩展名', async () => {
    const d = saveDeps()
    expect(await saveImageUri('https://cdn.example.com/0', '0', d)).toEqual({ success: true, path: 'C:\\out\\saved.png' })
    expect(d.picked).toEqual(['0.png'])
    expect(d.log).toEqual([`write:C:\\out\\saved.png:${PNG.length}`])
  })

  it('下载失败时不弹保存框', async () => {
    const f: FetchLike = async () => ({ ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) })
    const d = saveDeps({ fetch: f })
    expect(await saveImageUri('https://x/a.png', 'a.png', d)).toEqual({ success: false, error: '下载图片失败:HTTP 404' })
    expect(d.picked).toEqual([])
  })

  it('用户取消 → success + canceled,不写文件', async () => {
    const d = saveDeps({ pickSavePath: async () => null })
    expect(await saveImageUri('https://x/a.png', 'a.png', d)).toEqual({ success: true, canceled: true })
    expect(await saveImageUri('D:\\a.png', 'a.png', d)).toEqual({ success: true, canceled: true })
    expect(d.log).toEqual([])
  })
})
