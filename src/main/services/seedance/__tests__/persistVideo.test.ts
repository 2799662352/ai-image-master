import { beforeEach, describe, expect, it, vi } from 'vitest'
import { persistVideoBytes, type PersistVideoDeps } from '../persistVideo'

const TASK = { videoUrl: 'https://upstream/v.mp4', model: '2.0', taskId: 'task-12345678' }

function makeDeps(over: Partial<PersistVideoDeps> = {}): PersistVideoDeps {
  return {
    downloadVideo: vi.fn(async (_u: string, dest: string) => dest),
    ingest: vi.fn(async () => [{ localPath: 'D:/attachments/v.mp4' }]),
    relayFileToCos: vi.fn(async () => 'https://cos/v.mp4'),
    stat: vi.fn(async () => ({ size: 1024 })),
    mkdir: vi.fn(async () => undefined),
    unlink: vi.fn(async () => undefined),
    downloadsDir: 'D:/downloads',
    fallbackThreadId: 'fallback',
    uuid: () => 'uuid',
    join: (...p: string[]) => p.join('/'),
    ...over,
  }
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

describe('persistVideoBytes', () => {
  it('一切顺利时归档进 attachments、拿到 COS 地址、删掉临时副本', async () => {
    const deps = makeDeps()
    const r = await persistVideoBytes(TASK, deps)

    expect(r).toEqual({
      localPath: 'D:/attachments/v.mp4',
      remoteUrl: 'https://cos/v.mp4',
      archived: true,
    })
    expect(deps.unlink).toHaveBeenCalledWith('D:/downloads/uuid-seedance-2_0-12345678.mp4')
  })

  /**
   * 这是本文件存在的理由。曾经 ingest 抛错会连带一个无条件 `finally { unlink }`,
   * 于是一次 sidecar DB 抖动就能把几分钟才下完的 mp4 一起删掉 —— 卡片只剩明天
   * 过期的上游地址,唯一补救是花钱重生成。下载成功后那份字节是唯一不会过期的
   * 副本,任何下游步骤失败都不许把它带走。
   */
  it('ingest 抛错时保留原始下载,不删文件、不抛错', async () => {
    const deps = makeDeps({ ingest: vi.fn(async () => { throw new Error('sidecar db locked') }) })
    const r = await persistVideoBytes(TASK, deps)

    expect(r.localPath).toBe('D:/downloads/uuid-seedance-2_0-12345678.mp4')
    expect(r.archived).toBe(false)
    expect(deps.unlink).not.toHaveBeenCalled()
    // 归档失败不影响转存:COS 仍然从原始下载上传，用户照样拿到永久 https 地址。
    expect(r.remoteUrl).toBe('https://cos/v.mp4')
  })

  it('ingest 返回空数组时同样保留原始下载', async () => {
    const deps = makeDeps({ ingest: vi.fn(async () => []) })
    const r = await persistVideoBytes(TASK, deps)

    expect(r.archived).toBe(false)
    expect(r.localPath).toBe('D:/downloads/uuid-seedance-2_0-12345678.mp4')
    expect(deps.unlink).not.toHaveBeenCalled()
  })

  it('COS 上传失败不致命:本地副本仍在，只是没有远端地址', async () => {
    const deps = makeDeps({ relayFileToCos: vi.fn(async () => { throw new Error('cos 503') }) })
    const r = await persistVideoBytes(TASK, deps)

    expect(r.localPath).toBe('D:/attachments/v.mp4')
    expect(r.remoteUrl).toBeUndefined()
    expect(r.archived).toBe(true)
  })

  it('归档成功时从归档后的路径上传，而不是即将被删的临时副本', async () => {
    const deps = makeDeps()
    await persistVideoBytes(TASK, deps)

    expect(deps.relayFileToCos).toHaveBeenCalledWith(
      'D:/attachments/v.mp4', 'video/mp4', { fileSize: 1024 },
    )
  })

  it('下载失败才是真失败:此时并没有任何字节到手，如实抛错', async () => {
    const deps = makeDeps({
      downloadVideo: vi.fn(async () => { throw new Error('ERR_CONNECTION_CLOSED') }),
    })
    await expect(persistVideoBytes(TASK, deps)).rejects.toThrow('ERR_CONNECTION_CLOSED')
  })

  it('新鲜地址和任务号都没有才拒绝', async () => {
    await expect(persistVideoBytes({ ...TASK, videoUrl: undefined }, makeDeps()))
      .rejects.toThrow('no fresh nor stored videoUrl')
  })
})

/**
 * 开发文档 §3.1/§3.4:任务记录一直在，随时可以按 taskId 重查拿一条**新签发**的
 * `content.video_url`。所以 taskId 才是持久句柄，卡片上那条预签名地址只是 24 小时
 * 的缓存。先重查再下载，卡片放置超过一天后「重新保存」才还能用。
 */
describe('persistVideoBytes · 按 taskId 重查地址', () => {
  it('总是优先用重查回来的新地址，而不是手上那条旧的', async () => {
    const deps = makeDeps({ refreshVideoUrl: vi.fn(async () => 'https://fresh/v.mp4') })
    await persistVideoBytes(TASK, deps)

    // 带 model:重查得打对上游 —— 万相的任务在 Ark 那边查不到。
    // 带 billing:同一个理由的第二层 —— 平台余额那条任务是影子 token 建的,
    // 拿用户自填的 key 去重查会拿回「任务不存在」,「重新保存」于是永远失败。
    expect(deps.refreshVideoUrl).toHaveBeenCalledWith('task-12345678', TASK.model, undefined)
    expect(deps.downloadVideo).toHaveBeenCalledWith('https://fresh/v.mp4', expect.any(String))
  })

  it('重查带上任务自己的计费模式', async () => {
    const deps = makeDeps({ refreshVideoUrl: vi.fn(async () => 'https://fresh/v.mp4') })
    await persistVideoBytes({ ...TASK, billing: 'platform' }, deps)

    expect(deps.refreshVideoUrl).toHaveBeenCalledWith('task-12345678', TASK.model, 'platform')
  })

  it('重查抛错时退回旧地址，不因此放弃', async () => {
    const deps = makeDeps({
      refreshVideoUrl: vi.fn(async () => { throw new Error('network down') }),
    })
    await persistVideoBytes(TASK, deps)

    expect(deps.downloadVideo).toHaveBeenCalledWith(TASK.videoUrl, expect.any(String))
  })

  it('重查回来没有 video_url 时也退回旧地址', async () => {
    const deps = makeDeps({ refreshVideoUrl: vi.fn(async () => undefined) })
    await persistVideoBytes(TASK, deps)

    expect(deps.downloadVideo).toHaveBeenCalledWith(TASK.videoUrl, expect.any(String))
  })

  it('只有 taskId、没有旧地址时靠重查也能救回来', async () => {
    const deps = makeDeps({ refreshVideoUrl: vi.fn(async () => 'https://fresh/v.mp4') })
    const r = await persistVideoBytes({ ...TASK, videoUrl: undefined }, deps)

    expect(r.localPath).toBe('D:/attachments/v.mp4')
    expect(deps.downloadVideo).toHaveBeenCalledWith('https://fresh/v.mp4', expect.any(String))
  })

  it('重查失败且没有旧地址才真失败', async () => {
    const deps = makeDeps({
      refreshVideoUrl: vi.fn(async () => { throw new Error('404') }),
    })
    await expect(persistVideoBytes({ ...TASK, videoUrl: undefined }, deps))
      .rejects.toThrow('no fresh nor stored videoUrl')
  })
})
