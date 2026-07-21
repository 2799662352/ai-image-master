import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AudioPage, createAudioPage, getAudioPage } from '../AudioPage'
import { AudioLibraryStore, type AudioLibraryItem } from '../../features/audio/AudioLibraryStore'
import type { AppInterface } from '../BasePage'

/**
 * AudioPage(音频生成页,seed-audio-1.0)。
 * jsdom 无 IndexedDB → AudioLibraryStore 自动降级内存表,页面逻辑照常可测;
 * 波形绘制依赖 AudioContext,jsdom 缺失时静默跳过(页面已按此设计)。
 */

function makeApp(): AppInterface & { toasts: Array<{ msg: string; type: string }> } {
  const toasts: Array<{ msg: string; type: string }> = []
  return {
    toasts,
    showToast: (msg: string, type: string) => { toasts.push({ msg, type }) },
    switchTab: () => {},
    addToHistory: () => {},
    currentTab: 'audio',
    history: [],
    pages: {},
  } as any
}

function mountAudioPanelDom(): void {
  document.body.innerHTML = `
    <div id="audioPanel">
      <textarea id="audioPrompt"></textarea>
      <p id="audioPromptHint" class="hidden"></p>
      <div id="audioStyleChips"></div>
      <div id="audioRefArea"></div>
      <input type="file" id="audioRefInput" />
      <div id="audioRefList"></div>
      <select id="audioFormat"><option value="mp3" selected>MP3</option><option value="wav">WAV</option></select>
      <input type="range" id="audioSpeed" min="0.5" max="2" step="0.05" value="1" />
      <span id="audioSpeedValue"></span>
      <button id="audioClearBtn"></button>
      <button id="audioGenerateBtn"><span data-role="label">生成音频</span></button>
      <div id="audioLibraryEmpty" class="hidden"></div>
      <div id="audioLibrary"></div>
    </div>`
}

function setApiMock(generateAudio: ReturnType<typeof vi.fn>): void {
  ;(window as any).aiImageAPI = { generateAudio }
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

describe('AudioPage', () => {
  let page: AudioPage
  let store: AudioLibraryStore

  beforeEach(() => {
    localStorage.clear()
    mountAudioPanelDom()
    store = new AudioLibraryStore() // jsdom 无 indexedDB → 内存降级
  })

  afterEach(() => {
    page?.destroy()
    delete (window as any).aiImageAPI
    document.body.innerHTML = ''
  })

  it('init renders style chips and empty library state', async () => {
    page = new AudioPage(makeApp(), store)
    page.init()
    await flush()

    expect(document.querySelectorAll('#audioStyleChips button').length).toBeGreaterThan(3)
    expect(document.getElementById('audioLibraryEmpty')?.classList.contains('hidden')).toBe(false)
  })

  it('style chip click appends its fragment to the prompt', () => {
    page = new AudioPage(makeApp(), store)
    page.init()

    const chip = document.querySelector<HTMLButtonElement>('#audioStyleChips button')!
    chip.click()
    const textarea = document.getElementById('audioPrompt') as HTMLTextAreaElement
    expect(textarea.value.length).toBeGreaterThan(0)
  })

  it('generate happy path: calls api with Miau pin, persists item, renders card', async () => {
    const generateAudio = vi.fn(async () => ({
      success: true,
      audioBase64: 'QUJD',
      format: 'mp3',
      duration: 8.2,
      originalDuration: 9,
    }))
    setApiMock(generateAudio)

    page = new AudioPage(makeApp(), store)
    page.init()
    ;(document.getElementById('audioPrompt') as HTMLTextAreaElement).value = '一位女声说:你好。'

    ;(document.getElementById('audioGenerateBtn') as HTMLButtonElement).click()
    await vi.waitFor(async () => {
      expect((await store.list()).length).toBe(1)
    })

    // 请求契约:input + Miau 站点 pin + 默认 mp3
    const params = generateAudio.mock.calls[0][0]
    expect(params.input).toBe('一位女声说:你好。')
    expect(params.siteKey).toBe('antigravity')
    expect(params.responseFormat).toBe('mp3')

    // 库落库 + 卡片渲染
    const items = await store.list()
    expect(items[0].audioBase64).toBe('QUJD')
    expect(items[0].billedSeconds).toBe(9)
    await flush()
    expect(document.querySelectorAll('#audioLibrary .audio-item-card').length).toBe(1)
    expect(document.getElementById('audioLibraryEmpty')?.classList.contains('hidden')).toBe(true)
  })

  it('saves bytes to local disk (方案 A) when electronAPI.audioHistory is available', async () => {
    setApiMock(vi.fn(async () => ({ success: true, audioBase64: 'QUJD', format: 'mp3', duration: 5 })))
    const save = vi.fn(async () => ({ success: true as const, filePath: 'C:\\ud\\audio-history\\1.mp3' }))
    ;(window as any).electronAPI = { audioHistory: { save } }

    page = new AudioPage(makeApp(), store)
    page.init()
    ;(document.getElementById('audioPrompt') as HTMLTextAreaElement).value = 'x'
    ;(document.getElementById('audioGenerateBtn') as HTMLButtonElement).click()

    await vi.waitFor(async () => {
      expect((await store.list()).length).toBe(1)
    })
    expect(save).toHaveBeenCalledWith('QUJD', 'mp3')
    const item = (await store.list())[0]
    // 元数据只存路径,不再背 base64
    expect(item.filePath).toBe('C:\\ud\\audio-history\\1.mp3')
    expect(item.audioBase64).toBeUndefined()
    delete (window as any).electronAPI
  })

  it('uploads to COS (方案 B) and stores the remote URL as the primary source', async () => {
    setApiMock(vi.fn(async () => ({ success: true, audioBase64: 'QUJD', format: 'mp3', duration: 5 })))
    const uploadCos = vi.fn(async () => ({
      success: true as const,
      url: 'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/image-history/audio/2026/07/21/ab.mp3',
      key: 'image-history/audio/2026/07/21/ab.mp3',
    }))
    const save = vi.fn(async () => ({ success: true as const, filePath: 'C:\\ud\\audio-history\\1.mp3' }))
    ;(window as any).electronAPI = { audioHistory: { uploadCos, save } }

    page = new AudioPage(makeApp(), store)
    page.init()
    ;(document.getElementById('audioPrompt') as HTMLTextAreaElement).value = 'x'
    ;(document.getElementById('audioGenerateBtn') as HTMLButtonElement).click()

    await vi.waitFor(async () => {
      expect((await store.list()).length).toBe(1)
    })
    expect(uploadCos).toHaveBeenCalledWith('QUJD', 'mp3')
    const item = (await store.list())[0]
    // COS URL + 本地文件都留;base64 不再冗余存
    expect(item.remoteUrl).toContain('image-history/audio/')
    expect(item.filePath).toBe('C:\\ud\\audio-history\\1.mp3')
    expect(item.audioBase64).toBeUndefined()
    delete (window as any).electronAPI
  })

  it('keeps the item playable via COS when local disk save fails but upload succeeds', async () => {
    setApiMock(vi.fn(async () => ({ success: true, audioBase64: 'QUJD', format: 'mp3', duration: 5 })))
    ;(window as any).electronAPI = {
      audioHistory: {
        uploadCos: vi.fn(async () => ({ success: true as const, url: 'https://cos.example.com/a.mp3', key: 'k' })),
        save: vi.fn(async () => ({ success: false as const, error: 'disk full' })),
      },
    }

    page = new AudioPage(makeApp(), store)
    page.init()
    ;(document.getElementById('audioPrompt') as HTMLTextAreaElement).value = 'x'
    ;(document.getElementById('audioGenerateBtn') as HTMLButtonElement).click()

    await vi.waitFor(async () => {
      expect((await store.list()).length).toBe(1)
    })
    const item = (await store.list())[0]
    expect(item.remoteUrl).toBe('https://cos.example.com/a.mp3')
    expect(item.filePath).toBeUndefined()
    // 有 COS 兜底就不必再存 base64
    expect(item.audioBase64).toBeUndefined()
    delete (window as any).electronAPI
  })

  it('falls back to base64 storage when local save fails', async () => {
    setApiMock(vi.fn(async () => ({ success: true, audioBase64: 'QUJD', format: 'mp3', duration: 5 })))
    ;(window as any).electronAPI = {
      audioHistory: { save: vi.fn(async () => ({ success: false as const, error: 'disk full' })) },
    }

    page = new AudioPage(makeApp(), store)
    page.init()
    ;(document.getElementById('audioPrompt') as HTMLTextAreaElement).value = 'x'
    ;(document.getElementById('audioGenerateBtn') as HTMLButtonElement).click()

    await vi.waitFor(async () => {
      expect((await store.list()).length).toBe(1)
    })
    const item = (await store.list())[0]
    expect(item.filePath).toBeUndefined()
    expect(item.audioBase64).toBe('QUJD')
    delete (window as any).electronAPI
  })

  it('delete also removes the local file via audioHistory.delete', async () => {
    const deleteFile = vi.fn(async () => ({ success: true as const }))
    ;(window as any).electronAPI = { audioHistory: { delete: deleteFile } }
    await store.add({
      id: 'f1',
      prompt: '本地文件作品',
      format: 'mp3',
      duration: 3,
      billedSeconds: 3,
      createdAt: Date.now(),
      filePath: 'C:\\ud\\audio-history\\f1.mp3',
    })

    page = new AudioPage(makeApp(), store)
    page.init()
    await vi.waitFor(() => {
      expect(document.querySelectorAll('#audioLibrary .audio-item-card').length).toBe(1)
    })
    document.querySelector<HTMLButtonElement>('[data-action="delete"]')!.click()
    await vi.waitFor(async () => {
      expect((await store.list()).length).toBe(0)
    })
    expect(deleteFile).toHaveBeenCalledWith('C:\\ud\\audio-history\\f1.mp3')
    delete (window as any).electronAPI
  })

  it('generate failure keeps an error card in the library and shows a toast', async () => {
    const app = makeApp()
    setApiMock(vi.fn(async () => ({ success: false, error: '账户余额不足' })))

    page = new AudioPage(app, store)
    page.init()
    ;(document.getElementById('audioPrompt') as HTMLTextAreaElement).value = 'x'
    ;(document.getElementById('audioGenerateBtn') as HTMLButtonElement).click()

    await vi.waitFor(() => {
      expect(app.toasts.some((t) => t.type === 'error' && t.msg.includes('余额'))).toBe(true)
    })
    expect((await store.list()).length).toBe(0)
    expect(document.querySelector('#audioLibrary [data-action="dismiss-error"]')).toBeTruthy()
  })

  it('empty prompt is rejected without calling the api', async () => {
    const app = makeApp()
    const generateAudio = vi.fn()
    setApiMock(generateAudio)

    page = new AudioPage(app, store)
    page.init()
    ;(document.getElementById('audioGenerateBtn') as HTMLButtonElement).click()
    await flush()

    expect(generateAudio).not.toHaveBeenCalled()
    expect(app.toasts.some((t) => t.type === 'warning')).toBe(true)
  })

  it('renders persisted items on activate and deletes via card action', async () => {
    const item: AudioLibraryItem = {
      id: 'a1',
      prompt: '旧作品',
      format: 'mp3',
      duration: 3,
      billedSeconds: 3,
      createdAt: Date.now(),
      audioBase64: 'QUJD',
    }
    await store.add(item)

    page = new AudioPage(makeApp(), store)
    page.init()
    await vi.waitFor(() => {
      expect(document.querySelectorAll('#audioLibrary .audio-item-card').length).toBe(1)
    })

    document.querySelector<HTMLButtonElement>('[data-action="delete"]')!.click()
    await vi.waitFor(async () => {
      expect((await store.list()).length).toBe(0)
    })
    await flush()
    expect(document.querySelectorAll('#audioLibrary .audio-item-card').length).toBe(0)
  })

  it('draft persists prompt across page instances', () => {
    page = new AudioPage(makeApp(), store)
    page.init()
    const textarea = document.getElementById('audioPrompt') as HTMLTextAreaElement
    textarea.value = '深夜电台开场白'
    textarea.dispatchEvent(new Event('input'))
    page.destroy()

    mountAudioPanelDom()
    page = new AudioPage(makeApp(), store)
    page.init()
    expect((document.getElementById('audioPrompt') as HTMLTextAreaElement).value).toBe('深夜电台开场白')
  })

  it('factory create/get round-trips the singleton', () => {
    const created = createAudioPage(makeApp(), store)
    expect(getAudioPage()).toBe(created)
  })
})

describe('AudioPage playback (盘符编码 + 逐级回落)', () => {
  let page: AudioPage
  let store: AudioLibraryStore
  /** 每次 play() 时的 audio.src(jsdom 不实现 play,必须 mock) */
  let playedSrcs: string[]

  function mockPlay(rejectWhen?: (src: string) => boolean): void {
    playedSrcs = []
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLAudioElement) {
      playedSrcs.push(this.src)
      if (rejectWhen?.(this.src)) {
        return Promise.reject(new DOMException('no supported source', 'NotSupportedError'))
      }
      return Promise.resolve()
    })
  }

  beforeEach(() => {
    localStorage.clear()
    mountAudioPanelDom()
    store = new AudioLibraryStore()
  })

  afterEach(() => {
    page?.destroy()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('encodes the Windows drive colon in local-file:// playback src (C: → C%3A)', async () => {
    // 回归:未编码盘符冒号会被 standard scheme 解析吞成 host → NotSupportedError
    mockPlay()
    await store.add({
      id: 'p1', prompt: '本地播放', format: 'mp3', duration: 3, billedSeconds: 3,
      createdAt: Date.now(), filePath: 'C:\\ud\\audio-history\\x.mp3',
    })
    page = new AudioPage(makeApp(), store)
    page.init()
    await vi.waitFor(() => {
      expect(document.querySelector('[data-action="play"]')).toBeTruthy()
    })

    document.querySelector<HTMLButtonElement>('[data-action="play"]')!.click()
    await vi.waitFor(() => {
      expect(playedSrcs).toEqual(['local-file:///C%3A/ud/audio-history/x.mp3'])
    })
  })

  it('falls back to remoteUrl when local-file playback fails, then to base64', async () => {
    mockPlay((src) => src.startsWith('local-file:'))
    await store.add({
      id: 'p2', prompt: '回落播放', format: 'mp3', duration: 3, billedSeconds: 3,
      createdAt: Date.now(),
      filePath: 'C:\\ud\\audio-history\\gone.mp3',
      remoteUrl: 'https://cos.example.com/audio/a.mp3',
    })
    page = new AudioPage(makeApp(), store)
    page.init()
    await vi.waitFor(() => {
      expect(document.querySelector('[data-action="play"]')).toBeTruthy()
    })

    document.querySelector<HTMLButtonElement>('[data-action="play"]')!.click()
    await vi.waitFor(() => {
      expect(playedSrcs).toEqual([
        'local-file:///C%3A/ud/audio-history/gone.mp3',
        'https://cos.example.com/audio/a.mp3',
      ])
    })
  })

  it('shows a toast when every playback source fails', async () => {
    const app = makeApp()
    mockPlay(() => true)
    await store.add({
      id: 'p3', prompt: '全部失败', format: 'mp3', duration: 3, billedSeconds: 3,
      createdAt: Date.now(),
      filePath: 'C:\\ud\\audio-history\\bad.mp3',
      remoteUrl: 'https://cos.example.com/audio/bad.mp3',
      audioBase64: 'QUJD',
    })
    page = new AudioPage(app, store)
    page.init()
    await vi.waitFor(() => {
      expect(document.querySelector('[data-action="play"]')).toBeTruthy()
    })

    document.querySelector<HTMLButtonElement>('[data-action="play"]')!.click()
    await vi.waitFor(() => {
      expect(app.toasts.some((t) => t.type === 'error' && t.msg.includes('播放失败'))).toBe(true)
    })
    // 三级源都试过
    expect(playedSrcs.length).toBe(3)
    expect(playedSrcs[2].startsWith('data:audio/mpeg;base64,')).toBe(true)
  })
})

describe('AudioPage concurrent generation (不阻塞 + 上限排队 + 失败重试)', () => {
  let page: AudioPage
  let store: AudioLibraryStore

  /** 手动控制 resolve 时机的 generateAudio mock。 */
  function deferredApi(): {
    generateAudio: ReturnType<typeof vi.fn>
    resolveNth: (n: number, result: unknown) => void
  } {
    const resolvers: Array<(v: unknown) => void> = []
    const generateAudio = vi.fn(
      () => new Promise((resolve) => { resolvers.push(resolve) }),
    )
    return { generateAudio, resolveNth: (n, result) => resolvers[n](result) }
  }

  function submit(prompt: string): void {
    ;(document.getElementById('audioPrompt') as HTMLTextAreaElement).value = prompt
    ;(document.getElementById('audioGenerateBtn') as HTMLButtonElement).click()
  }

  beforeEach(() => {
    localStorage.clear()
    mountAudioPanelDom()
    store = new AudioLibraryStore()
  })

  afterEach(() => {
    page?.destroy()
    delete (window as any).aiImageAPI
    document.body.innerHTML = ''
  })

  it('allows submitting again while a generation is in flight (button not disabled)', async () => {
    const { generateAudio, resolveNth } = deferredApi()
    setApiMock(generateAudio)
    page = new AudioPage(makeApp(), store)
    page.init()

    submit('第一段')
    const btn = document.getElementById('audioGenerateBtn') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    submit('第二段')

    // 两个请求并行在飞,两张 pending 卡都在
    expect(generateAudio).toHaveBeenCalledTimes(2)
    expect(document.querySelectorAll('#audioLibrary [data-transient="1"]').length).toBe(2)

    resolveNth(0, { success: true, audioBase64: 'QUJD', format: 'mp3', duration: 5 })
    resolveNth(1, { success: true, audioBase64: 'REVG', format: 'mp3', duration: 6 })
    await vi.waitFor(async () => {
      expect((await store.list()).length).toBe(2)
    })
    await vi.waitFor(() => {
      expect(document.querySelectorAll('#audioLibrary .audio-item-card').length).toBe(2)
      expect(document.querySelectorAll('#audioLibrary [data-transient="1"]').length).toBe(0)
    })
  })

  it('queues the 4th task beyond the concurrency limit and starts it when a slot frees', async () => {
    const { generateAudio, resolveNth } = deferredApi()
    setApiMock(generateAudio)
    page = new AudioPage(makeApp(), store)
    page.init()

    submit('任务1'); submit('任务2'); submit('任务3'); submit('任务4')

    // 上限 3:第 4 个不发请求,卡片显示排队中(jsdom 无 i18n,t() 回显 key)
    expect(generateAudio).toHaveBeenCalledTimes(3)
    expect(document.querySelectorAll('#audioLibrary [data-transient="1"]').length).toBe(4)
    const statuses = [...document.querySelectorAll('#audioLibrary [data-role="status"]')]
      .map((el) => el.textContent)
    expect(statuses.filter((s) => s?.includes('queued') || s?.includes('排队')).length).toBe(1)

    // 释放一个槽位 → 排队任务启动
    resolveNth(0, { success: true, audioBase64: 'QUJD', format: 'mp3', duration: 5 })
    await vi.waitFor(() => {
      expect(generateAudio).toHaveBeenCalledTimes(4)
    })
  })

  it('failed pending card offers retry which re-runs the same task', async () => {
    let calls = 0
    const generateAudio = vi.fn(async () => {
      calls += 1
      return calls === 1
        ? { success: false, error: '服务超时' }
        : { success: true, audioBase64: 'QUJD', format: 'mp3', duration: 5 }
    })
    setApiMock(generateAudio)
    page = new AudioPage(makeApp(), store)
    page.init()

    submit('重试任务')
    await vi.waitFor(() => {
      expect(document.querySelector('#audioLibrary [data-action="retry-generation"]')).toBeTruthy()
    })

    document.querySelector<HTMLButtonElement>('[data-action="retry-generation"]')!.click()
    await vi.waitFor(async () => {
      expect((await store.list()).length).toBe(1)
    })
    expect(generateAudio).toHaveBeenCalledTimes(2)
    // 重试用的是同一次提交的 prompt 快照
    expect(generateAudio.mock.calls[1][0].input).toBe('重试任务')
    await vi.waitFor(() => {
      expect(document.querySelectorAll('#audioLibrary .audio-item-card').length).toBe(1)
    })
  })
})

describe('AudioLibraryStore (memory fallback)', () => {
  it('add/list/update/remove round-trip, newest first', async () => {
    const store = new AudioLibraryStore()
    const base = { format: 'mp3', duration: 1, billedSeconds: 1, audioBase64: 'QQ==' }
    await store.add({ id: '1', prompt: 'old', createdAt: 1, ...base })
    await store.add({ id: '2', prompt: 'new', createdAt: 2, ...base })

    expect((await store.list()).map((i) => i.id)).toEqual(['2', '1'])

    await store.update('1', { peaks: [0.5, 1] })
    expect((await store.get('1'))?.peaks).toEqual([0.5, 1])

    await store.remove('2')
    expect((await store.list()).map((i) => i.id)).toEqual(['1'])
  })
})
