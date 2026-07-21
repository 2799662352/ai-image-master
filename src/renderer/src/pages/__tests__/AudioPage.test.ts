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
