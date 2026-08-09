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

  it('没有 videoUrl 时直接拒绝', async () => {
    await expect(persistVideoBytes({ ...TASK, videoUrl: undefined }, makeDeps()))
      .rejects.toThrow('no videoUrl')
  })
})
