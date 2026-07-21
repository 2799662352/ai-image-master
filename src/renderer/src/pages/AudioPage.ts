// src/renderer/src/pages/AudioPage.ts
/**
 * 音频生成页(seed-audio-1.0,替换原模型对比 tab)。
 *
 * 布局参考 Suno:左侧创作面板(自然语言 prompt + 风格 chips + 参考音频 +
 * 参数折叠区)/ 右侧作品库(波形卡片流)/ 底部全局播放条(挂 document.body,
 * 切 tab 不断播)。作品元数据 + base64 音频存 IndexedDB(AudioLibraryStore),
 * 波形峰值首次解码后回写,重启不丢。
 *
 * 刻意不做:voice/voice_references(speaker 体系不兼容 + 多音色未上线)、
 * >120s 自动分段(v1 只提示)。
 */

import { BasePage, type AppInterface } from './BasePage'
import {
  getAudioLibraryStore,
  type AudioLibraryItem,
  type AudioLibraryStore,
} from '../features/audio/AudioLibraryStore'
import { generateAudioToLibrary, type AudioGenerationApi } from '../features/audio/audioGeneration'

/** 风格 chips:点击往 prompt 里追加描述片段(纯前端拼 prompt,零协议成本)。 */
const STYLE_CHIPS: ReadonlyArray<{ label: string; append: string }> = [
  { label: '女声', append: '一位女声,自然口语,' },
  { label: '男声', append: '一位男声,沉稳清晰,' },
  { label: '童声', append: '一个孩子的声音,天真活泼,' },
  { label: '新闻播报', append: '新闻播报腔,字正腔圆,节奏稳定,' },
  { label: '深夜电台', append: '深夜电台主播的低沉温柔嗓音,语速缓慢,' },
  { label: '带环境音', append: '背景带贴合场景的环境音,' },
  { label: '带配乐', append: '结尾配一段简短的氛围配乐,' },
]

/** 参考音频上限(接入文档风格融合示例为 2 段)。 */
const MAX_REFERENCE_AUDIOS = 2
/** 单个参考音频文件大小上限(base64 直传请求体,别塞太大)。 */
const MAX_REFERENCE_AUDIO_MB = 10
/** prompt 长度软提示阈值(单次输出上限 ~120s,过长对白需分段)。 */
const PROMPT_LENGTH_HINT = 600

interface PendingCard {
  id: string
  prompt: string
  el: HTMLElement
}

export class AudioPage extends BasePage {
  private store: AudioLibraryStore
  private referenceAudios: Array<{ name: string; dataUrl: string }> = []
  private generating = false
  private abortController: AbortController | null = null

  // 全局播放器:单例 Audio 对象(不进 DOM)+ 挂 body 的播放条,切 tab 不断播
  private audioEl: HTMLAudioElement | null = null
  private playingItemId: string | null = null
  private playerBar: HTMLElement | null = null
  private playerRaf: number | null = null

  constructor(app: AppInterface, store?: AudioLibraryStore) {
    super(app)
    this.store = store ?? getAudioLibraryStore()
  }

  init(): void {
    if (this.isInitialized) return
    this.renderStyleChips()
    this.bindEvents()
    void this.renderLibrary()
    this.restoreDraft()
    this.isInitialized = true
    console.log('[AudioPage] ✅ 初始化完成')
  }

  bindEvents(): void {
    this.addEventListenerSafe('audioGenerateBtn', 'click', () => void this.handleGenerate())
    this.addEventListenerSafe('audioClearBtn', 'click', () => this.clearComposer())
    this.addEventListenerSafe('audioPrompt', 'input', () => {
      this.saveDraft()
      this.updatePromptHint()
    })
    this.addEventListenerSafe('audioSpeed', 'input', () => this.updateSpeedLabel())

    // 参考音频:点击上传
    this.addEventListenerSafe('audioRefArea', 'click', () => {
      this.getElement<HTMLInputElement>('audioRefInput')?.click()
    })
    this.addEventListenerSafe('audioRefInput', 'change', (e) => {
      const input = e.target as HTMLInputElement
      if (input.files) void this.addReferenceFiles([...input.files])
      input.value = ''
    })
    // 拖拽上传
    const refArea = this.getElement('audioRefArea')
    if (refArea) {
      refArea.addEventListener('dragover', (e) => { e.preventDefault() })
      refArea.addEventListener('drop', (e) => {
        e.preventDefault()
        const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('audio/'))
        if (files.length) void this.addReferenceFiles(files)
      })
    }

    // 作品库操作走事件委托(卡片是动态渲染的)
    const library = this.getElement('audioLibrary')
    if (library) {
      library.addEventListener('click', (e) => void this.handleLibraryClick(e))
    }
  }

  saveState(): void { this.saveDraft() }
  async restoreState(): Promise<void> { this.restoreDraft() }

  onActivate(): void {
    if (!this.isInitialized) this.init()
    else void this.renderLibrary()
  }

  onDeactivate(): void { this.saveDraft() }

  destroy(): void {
    this.stopPlayback()
    this.playerBar?.remove()
    this.playerBar = null
    super.destroy()
  }

  // ---------------------------------------------------------------- composer

  private renderStyleChips(): void {
    const host = this.getElement('audioStyleChips')
    if (!host) return
    host.innerHTML = ''
    for (const chip of STYLE_CHIPS) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className =
        'px-3 py-1.5 text-xs border border-[#3F3F46] text-white text-opacity-80 hover:border-[#FCE300] hover:text-[#FCE300] transition-all rounded-none'
      btn.textContent = chip.label
      btn.addEventListener('click', () => {
        const textarea = this.getElement<HTMLTextAreaElement>('audioPrompt')
        if (!textarea) return
        textarea.value = `${textarea.value}${textarea.value && !textarea.value.endsWith(',') && !textarea.value.endsWith('，') ? ' ' : ''}${chip.append}`
        textarea.focus()
        this.saveDraft()
        this.updatePromptHint()
      })
      host.appendChild(btn)
    }
  }

  private updatePromptHint(): void {
    const hint = this.getElement('audioPromptHint')
    const textarea = this.getElement<HTMLTextAreaElement>('audioPrompt')
    if (!hint || !textarea) return
    hint.classList.toggle('hidden', textarea.value.length < PROMPT_LENGTH_HINT)
  }

  private updateSpeedLabel(): void {
    const slider = this.getElement<HTMLInputElement>('audioSpeed')
    const label = this.getElement('audioSpeedValue')
    if (slider && label) label.textContent = `${Number(slider.value).toFixed(2)}x`
  }

  private async addReferenceFiles(files: File[]): Promise<void> {
    for (const file of files) {
      if (this.referenceAudios.length >= MAX_REFERENCE_AUDIOS) {
        this.showToast(this.t('audio.toast.refLimit') || `参考音频最多 ${MAX_REFERENCE_AUDIOS} 个`, 'warning')
        break
      }
      if (file.size > MAX_REFERENCE_AUDIO_MB * 1024 * 1024) {
        this.showToast(`「${file.name}」超过 ${MAX_REFERENCE_AUDIO_MB}MB,已跳过`, 'warning')
        continue
      }
      try {
        const dataUrl = await this.fileToDataUrl(file)
        this.referenceAudios.push({ name: file.name, dataUrl })
      } catch (e) {
        console.warn('[AudioPage] 参考音频读取失败:', e)
        this.showToast(`「${file.name}」读取失败`, 'error')
      }
    }
    this.renderReferenceList()
  }

  private fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(file)
    })
  }

  private renderReferenceList(): void {
    const host = this.getElement('audioRefList')
    if (!host) return
    host.innerHTML = ''
    this.referenceAudios.forEach((ref, index) => {
      const row = document.createElement('div')
      row.className = 'flex items-center justify-between gap-2 text-xs text-white text-opacity-80 border border-[#3F3F46] px-2 py-1.5'
      const name = document.createElement('span')
      name.className = 'truncate'
      name.textContent = `♪ ${ref.name}`
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'text-white text-opacity-50 hover:text-red-400 shrink-0'
      remove.textContent = '✕'
      remove.addEventListener('click', (e) => {
        e.stopPropagation()
        this.referenceAudios.splice(index, 1)
        this.renderReferenceList()
      })
      row.append(name, remove)
      host.appendChild(row)
    })
  }

  private clearComposer(): void {
    const textarea = this.getElement<HTMLTextAreaElement>('audioPrompt')
    if (textarea) textarea.value = ''
    this.referenceAudios = []
    this.renderReferenceList()
    this.saveDraft()
    this.updatePromptHint()
  }

  private saveDraft(): void {
    try {
      const textarea = this.getElement<HTMLTextAreaElement>('audioPrompt')
      if (textarea) localStorage.setItem('audio_page_draft', textarea.value)
    } catch { /* 配额/隐私模式,忽略 */ }
  }

  private restoreDraft(): void {
    try {
      const draft = localStorage.getItem('audio_page_draft')
      const textarea = this.getElement<HTMLTextAreaElement>('audioPrompt')
      if (draft && textarea && !textarea.value) textarea.value = draft
    } catch { /* ignore */ }
    this.updateSpeedLabel()
    this.updatePromptHint()
  }

  // ---------------------------------------------------------------- generate

  private async handleGenerate(): Promise<void> {
    if (this.generating) {
      this.showToast(this.t('audio.toast.busy') || '正在生成中,请稍候', 'info')
      return
    }
    const textarea = this.getElement<HTMLTextAreaElement>('audioPrompt')
    const prompt = textarea?.value.trim() ?? ''
    if (!prompt) {
      this.showToast(this.t('audio.toast.emptyPrompt') || '请先描述你想要的音频', 'warning')
      return
    }

    const api = this.getApi()
    if (!api?.generateAudio) {
      this.showToast('音频服务未就绪,请重启应用后重试', 'error')
      return
    }

    const format = (this.getElement<HTMLSelectElement>('audioFormat')?.value || 'mp3') as 'mp3' | 'wav' | 'opus'
    const speed = Number(this.getElement<HTMLInputElement>('audioSpeed')?.value || '1') || 1

    this.generating = true
    this.setGenerateButtonBusy(true)
    const pending = this.insertPendingCard(prompt)
    this.abortController = new AbortController()

    try {
      // 生成 + 三级持久化 + 落库走共享核心(与 codex MCP generate_audio 同一条路)
      const outcome = await generateAudioToLibrary(
        {
          prompt,
          format,
          speed,
          referenceAudios: this.referenceAudios.map((r) => r.dataUrl),
          signal: this.abortController.signal,
          id: pending.id,
        },
        api as AudioGenerationApi,
        this.store,
      )

      if (!outcome.success) {
        this.settlePendingCardError(pending, outcome.error)
        return
      }

      pending.el.remove()
      const card = this.buildItemCard(outcome.item)
      this.getElement('audioLibrary')?.prepend(card)
      this.hideLibraryEmptyState()
      void this.drawWaveformFor(outcome.item, card)
      this.showToast(this.t('audio.toast.done') || '音频已生成', 'success')
    } catch (error) {
      this.settlePendingCardError(pending, error instanceof Error ? error.message : String(error))
    } finally {
      this.generating = false
      this.setGenerateButtonBusy(false)
      this.abortController = null
    }
  }

  private setGenerateButtonBusy(busy: boolean): void {
    const btn = this.getElement<HTMLButtonElement>('audioGenerateBtn')
    if (!btn) return
    btn.disabled = busy
    btn.classList.toggle('opacity-60', busy)
    const label = btn.querySelector('[data-role="label"]')
    if (label) {
      label.textContent = busy
        ? (this.t('audio.buttons.generating') || '生成中…')
        : (this.t('audio.buttons.generate') || '生成音频')
    }
  }

  // ----------------------------------------------------------------- library

  private async renderLibrary(): Promise<void> {
    const host = this.getElement('audioLibrary')
    if (!host) return
    let items: AudioLibraryItem[] = []
    try {
      items = await this.store.list()
    } catch (e) {
      console.warn('[AudioPage] 作品库读取失败:', e)
    }
    // 「生成中/失败」卡片不在 store 里,整库重绘时必须保留(否则 init 的异步
    // 重绘或 tab 切回时会把正在生成的气泡抹掉 —— 实测竞态)。
    const transientCards = [...host.querySelectorAll<HTMLElement>('[data-transient="1"]')]
    host.innerHTML = ''
    for (const card of transientCards) host.appendChild(card)
    if (items.length === 0 && transientCards.length === 0) {
      this.showLibraryEmptyState()
      return
    }
    this.hideLibraryEmptyState()
    for (const item of items) {
      const card = this.buildItemCard(item)
      host.appendChild(card)
      void this.drawWaveformFor(item, card)
    }
  }

  private showLibraryEmptyState(): void {
    this.getElement('audioLibraryEmpty')?.classList.remove('hidden')
  }

  private hideLibraryEmptyState(): void {
    this.getElement('audioLibraryEmpty')?.classList.add('hidden')
  }

  private insertPendingCard(prompt: string): PendingCard {
    const id = `audio_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const el = document.createElement('div')
    el.className = 'border border-[#3F3F46] bg-[#111113] p-4 space-y-2'
    el.dataset.itemId = id
    el.dataset.transient = '1'
    el.innerHTML = `
      <div class="flex items-center gap-3">
        <div class="w-8 h-8 border-2 border-[#FCE300] border-t-transparent rounded-full animate-spin shrink-0"></div>
        <div class="min-w-0">
          <p class="text-white text-sm truncate">${escapeHtml(prompt)}</p>
          <p class="text-white text-opacity-50 text-xs" data-role="status">${escapeHtml(this.t('audio.card.generating') || '生成中,通常十几秒…')}</p>
        </div>
      </div>`
    const host = this.getElement('audioLibrary')
    host?.prepend(el)
    this.hideLibraryEmptyState()
    return { id, prompt, el }
  }

  private settlePendingCardError(pending: PendingCard, message: string): void {
    pending.el.className = 'border border-red-500/60 bg-[#111113] p-4 space-y-2'
    pending.el.innerHTML = `
      <p class="text-white text-sm truncate">${escapeHtml(pending.prompt)}</p>
      <p class="text-red-400 text-xs break-all">${escapeHtml(message)}</p>
      <button type="button" data-action="dismiss-error" class="text-xs text-white text-opacity-60 hover:text-white border border-[#3F3F46] px-2 py-1">${escapeHtml(this.t('audio.card.dismiss') || '关闭')}</button>`
    this.showToast(message, 'error')
  }

  private buildItemCard(item: AudioLibraryItem): HTMLElement {
    const el = document.createElement('div')
    el.className = 'audio-item-card border border-[#3F3F46] bg-[#111113] p-4 space-y-3 hover:border-[#FCE300]/50 transition-all'
    el.dataset.itemId = item.id
    const durationText = item.duration > 0 ? formatSeconds(item.duration) : '--:--'
    el.innerHTML = `
      <div class="flex items-start justify-between gap-3">
        <p class="text-white text-sm leading-snug line-clamp-2 min-w-0" title="${escapeHtml(item.prompt)}">${escapeHtml(item.prompt)}</p>
        <span class="text-[10px] uppercase tracking-wider text-black bg-[#FCE300] px-1.5 py-0.5 shrink-0">${escapeHtml(shortFormat(item.format))}</span>
      </div>
      <div class="flex items-center gap-3">
        <button type="button" data-action="play" class="w-10 h-10 shrink-0 bg-[#FCE300] text-black flex items-center justify-center font-bold hover:scale-105 active:scale-95 transition-transform" aria-label="play">
          <i class="fas fa-play" data-role="play-icon"></i>
        </button>
        <canvas data-role="waveform" class="flex-1 h-10 min-w-0" height="40"></canvas>
        <span class="text-white text-opacity-60 text-xs shrink-0" data-role="duration">${durationText}</span>
      </div>
      <div class="flex items-center gap-2 text-xs">
        <button type="button" data-action="download" class="text-white text-opacity-60 hover:text-[#FCE300] border border-[#3F3F46] px-2 py-1 transition-colors"><i class="fas fa-download mr-1"></i>${escapeHtml(this.t('audio.card.download') || '下载')}</button>
        <button type="button" data-action="copy-prompt" class="text-white text-opacity-60 hover:text-[#FCE300] border border-[#3F3F46] px-2 py-1 transition-colors"><i class="fas fa-copy mr-1"></i>${escapeHtml(this.t('audio.card.copyPrompt') || '复制描述')}</button>
        <button type="button" data-action="delete" class="text-white text-opacity-60 hover:text-red-400 border border-[#3F3F46] px-2 py-1 transition-colors ml-auto"><i class="fas fa-trash mr-1"></i>${escapeHtml(this.t('audio.card.delete') || '删除')}</button>
      </div>`
    return el
  }

  private async handleLibraryClick(e: Event): Promise<void> {
    const target = e.target as HTMLElement
    const actionEl = target.closest<HTMLElement>('[data-action]')
    if (!actionEl) return
    const card = actionEl.closest<HTMLElement>('[data-item-id]')
    const itemId = card?.dataset.itemId
    const action = actionEl.dataset.action

    if (action === 'dismiss-error') {
      card?.remove()
      void this.renderLibraryEmptyIfNeeded()
      return
    }
    if (!itemId) return

    const item = await this.store.get(itemId)
    if (!item) return

    switch (action) {
      case 'play':
        this.togglePlayback(item)
        break
      case 'download':
        this.downloadItem(item)
        break
      case 'copy-prompt':
        try {
          await navigator.clipboard.writeText(item.prompt)
          this.showToast(this.t('audio.toast.promptCopied') || '描述已复制', 'success')
        } catch {
          this.showToast('复制失败', 'error')
        }
        break
      case 'delete':
        if (this.playingItemId === itemId) this.stopPlayback()
        if (item.filePath) {
          // 连本地文件一起删;失败不阻塞(孤儿文件无害,只占磁盘)
          void getAudioHistoryApi()?.delete?.(item.filePath).catch(() => {})
        }
        await this.store.remove(itemId)
        card?.remove()
        void this.renderLibraryEmptyIfNeeded()
        break
    }
  }

  private async renderLibraryEmptyIfNeeded(): Promise<void> {
    const host = this.getElement('audioLibrary')
    if (host && host.children.length === 0) this.showLibraryEmptyState()
  }

  private downloadItem(item: AudioLibraryItem): void {
    const ext = shortFormat(item.format)
    const suggestedName = `seed-audio-${new Date(item.createdAt).toISOString().slice(0, 19).replace(/[T:]/g, '-')}.${ext}`

    // 本地文件:走 shell.saveAs(主进程复制文件 + 系统另存对话框),零字节过 IPC
    if (item.filePath) {
      const shellApi = (window as unknown as {
        electronAPI?: { shell?: { saveAs?: (uri: string, name: string) => Promise<unknown> } }
      }).electronAPI?.shell
      if (shellApi?.saveAs) {
        void shellApi.saveAs(item.filePath, suggestedName)
        return
      }
    }

    // 无本地文件:COS 远程 URL 或 base64 降级 → 浏览器锚点下载
    const href = item.remoteUrl || (item.audioBase64 ? toAudioDataUrl(item.audioBase64, item.format) : null)
    if (href) {
      const a = document.createElement('a')
      a.href = href
      a.download = suggestedName
      document.body.appendChild(a)
      a.click()
      a.remove()
    }
  }

  // ---------------------------------------------------------------- waveform

  /** 首次渲染解码画峰值,回写 peaks 缓存;失败静默(卡片没波形不影响播放)。 */
  private async drawWaveformFor(item: AudioLibraryItem, card: HTMLElement): Promise<void> {
    const canvas = card.querySelector<HTMLCanvasElement>('[data-role="waveform"]')
    if (!canvas) return
    try {
      let peaks = item.peaks
      if (!peaks || peaks.length === 0) {
        // 波形解码需要字节:renderer fetch(local-file://) 会被协议门拦
        // (Sec-Fetch-Dest 非 audio),所以本地文件走 read IPC 拿 base64。
        const dataUrl = await this.resolveDataUrl(item)
        if (!dataUrl) return
        peaks = await computePeaks(dataUrl, 96)
        void this.store.update(item.id, { peaks })
      }
      drawPeaks(canvas, peaks)
    } catch (e) {
      console.warn('[AudioPage] 波形绘制失败(忽略):', e)
    }
  }

  /**
   * 拿到可 fetch 的 URL(波形解码用)。优先级:本地文件(read IPC,免网络) >
   * COS 远程 URL(fetch 到 blob) > base64 降级。renderer fetch(local-file://)
   * 会被协议门拦(dest 非 audio),所以本地文件必须经 read IPC。
   */
  private async resolveDataUrl(item: AudioLibraryItem): Promise<string | null> {
    if (item.audioBase64) return toAudioDataUrl(item.audioBase64, item.format)
    if (item.filePath) {
      const api = getAudioHistoryApi()
      if (api?.read) {
        const res = await api.read(item.filePath)
        if (res?.success) return toAudioDataUrl(res.base64, item.format)
      }
    }
    // COS https URL 可被 <canvas> 波形解码的 fetch 直接拉(CORS 允许)
    if (item.remoteUrl) return item.remoteUrl
    return null
  }

  /**
   * 播放源。优先级:本地文件(local-file://,免网络、秒开) > COS 远程 URL
   * (跨设备/清缓存后仍可播) > base64 降级。
   */
  private playUrlFor(item: AudioLibraryItem): string | null {
    if (item.filePath) return 'local-file:///' + item.filePath.replace(/\\/g, '/')
    if (item.remoteUrl) return item.remoteUrl
    if (item.audioBase64) return toAudioDataUrl(item.audioBase64, item.format)
    return null
  }

  // ------------------------------------------------------------------ player

  private ensureAudioEl(): HTMLAudioElement {
    if (!this.audioEl) {
      this.audioEl = new Audio()
      this.audioEl.addEventListener('ended', () => this.stopPlayback())
    }
    return this.audioEl
  }

  private togglePlayback(item: AudioLibraryItem): void {
    const audio = this.ensureAudioEl()
    if (this.playingItemId === item.id) {
      if (audio.paused) {
        void audio.play()
        this.updatePlayButtonIcon(item.id, true)
      } else {
        audio.pause()
        this.updatePlayButtonIcon(item.id, false)
      }
      this.updatePlayerBarPlayIcon(!audio.paused)
      return
    }

    // 换曲
    if (this.playingItemId) this.updatePlayButtonIcon(this.playingItemId, false)
    const src = this.playUrlFor(item)
    if (!src) {
      this.showToast('音频源不可用', 'error')
      return
    }
    audio.src = src
    void audio.play().catch((e) => {
      console.warn('[AudioPage] 播放失败:', e)
      this.showToast('播放失败', 'error')
    })
    this.playingItemId = item.id
    this.updatePlayButtonIcon(item.id, true)
    this.showPlayerBar(item)
  }

  private stopPlayback(): void {
    if (this.audioEl) {
      this.audioEl.pause()
      this.audioEl.src = ''
    }
    if (this.playingItemId) this.updatePlayButtonIcon(this.playingItemId, false)
    this.playingItemId = null
    this.hidePlayerBar()
  }

  private updatePlayButtonIcon(itemId: string, playing: boolean): void {
    const icon = document
      .querySelector(`[data-item-id="${cssEscape(itemId)}"] [data-role="play-icon"]`)
    if (icon) icon.className = playing ? 'fas fa-pause' : 'fas fa-play'
  }

  /** 播放条挂 document.body(在 tab-panel 外),切 tab 继续播、继续可控。 */
  private showPlayerBar(item: AudioLibraryItem): void {
    if (!this.playerBar) {
      this.playerBar = document.createElement('div')
      this.playerBar.id = 'audioPlayerBar'
      this.playerBar.className =
        'fixed bottom-0 left-0 right-0 z-[60] bg-[#09090B] border-t-2 border-[#FCE300] px-4 py-2 flex items-center gap-3'
      this.playerBar.innerHTML = `
        <button type="button" data-role="bar-play" class="w-9 h-9 shrink-0 bg-[#FCE300] text-black flex items-center justify-center" aria-label="toggle">
          <i class="fas fa-pause" data-role="bar-play-icon"></i>
        </button>
        <div class="min-w-0 flex-1">
          <p class="text-white text-xs truncate" data-role="bar-title"></p>
          <input type="range" data-role="bar-seek" class="w-full h-1 accent-[#FCE300]" min="0" max="100" step="0.1" value="0" />
        </div>
        <span class="text-white text-opacity-60 text-xs shrink-0 tabular-nums" data-role="bar-time">0:00</span>
        <button type="button" data-role="bar-close" class="text-white text-opacity-50 hover:text-white shrink-0 px-1" aria-label="close">✕</button>`
      document.body.appendChild(this.playerBar)

      this.playerBar.querySelector('[data-role="bar-play"]')?.addEventListener('click', () => {
        const audio = this.ensureAudioEl()
        if (audio.paused) void audio.play()
        else audio.pause()
        this.updatePlayerBarPlayIcon(!audio.paused)
        if (this.playingItemId) this.updatePlayButtonIcon(this.playingItemId, !audio.paused)
      })
      this.playerBar.querySelector('[data-role="bar-close"]')?.addEventListener('click', () => this.stopPlayback())
      this.playerBar.querySelector<HTMLInputElement>('[data-role="bar-seek"]')?.addEventListener('input', (e) => {
        const audio = this.ensureAudioEl()
        const pct = Number((e.target as HTMLInputElement).value)
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
          audio.currentTime = (pct / 100) * audio.duration
        }
      })
    }

    const title = this.playerBar.querySelector('[data-role="bar-title"]')
    if (title) title.textContent = item.prompt
    this.playerBar.classList.remove('hidden')
    this.updatePlayerBarPlayIcon(true)
    this.startPlayerTicker()
  }

  private hidePlayerBar(): void {
    this.playerBar?.classList.add('hidden')
    if (this.playerRaf !== null) {
      cancelAnimationFrame(this.playerRaf)
      this.playerRaf = null
    }
  }

  private updatePlayerBarPlayIcon(playing: boolean): void {
    const icon = this.playerBar?.querySelector('[data-role="bar-play-icon"]')
    if (icon) icon.className = playing ? 'fas fa-pause' : 'fas fa-play'
  }

  private startPlayerTicker(): void {
    if (this.playerRaf !== null) return
    const tick = (): void => {
      this.playerRaf = null
      const audio = this.audioEl
      const bar = this.playerBar
      if (!audio || !bar || bar.classList.contains('hidden')) return
      const seek = bar.querySelector<HTMLInputElement>('[data-role="bar-seek"]')
      const time = bar.querySelector('[data-role="bar-time"]')
      if (seek && Number.isFinite(audio.duration) && audio.duration > 0) {
        seek.value = String((audio.currentTime / audio.duration) * 100)
      }
      if (time) time.textContent = formatSeconds(audio.currentTime)
      this.playerRaf = requestAnimationFrame(tick)
    }
    this.playerRaf = requestAnimationFrame(tick)
  }
}

// -------------------------------------------------------------------- utils

function escapeHtml(text: string): string {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

/** ogg_opus → opus 之类的展示/扩展名归一。 */
function shortFormat(format: string): string {
  if (!format) return 'mp3'
  if (format.includes('opus')) return 'ogg'
  if (format.includes('wav')) return 'wav'
  if (format.includes('pcm')) return 'pcm'
  return 'mp3'
}

function mimeForFormat(format: string): string {
  const f = shortFormat(format)
  if (f === 'ogg') return 'audio/ogg'
  if (f === 'wav') return 'audio/wav'
  if (f === 'pcm') return 'audio/pcm'
  return 'audio/mpeg'
}

function toAudioDataUrl(base64: string, format: string): string {
  return `data:${mimeForFormat(format)};base64,${base64}`
}

interface AudioHistoryApi {
  save?: (base64: string, format: string) => Promise<
    { success: true; filePath: string } | { success: false; error: string }
  >
  read?: (filePath: string) => Promise<
    { success: true; base64: string } | { success: false; error: string }
  >
  delete?: (filePath: string) => Promise<{ success: true } | { success: false; error: string }>
  uploadCos?: (base64: string, format: string) => Promise<
    { success: true; url: string; key: string } | { success: false; error: string }
  >
}

function getAudioHistoryApi(): AudioHistoryApi | undefined {
  return (window as unknown as { electronAPI?: { audioHistory?: AudioHistoryApi } }).electronAPI?.audioHistory
}

function formatSeconds(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** CSS.escape 兜底(jsdom 老版本可能缺)。 */
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/[^a-zA-Z0-9_-]/g, '\\$&')
}

/** 解码音频取峰值(0~1),用于波形 canvas;bucket 数即横向柱子数。 */
async function computePeaks(dataUrl: string, buckets: number): Promise<number[]> {
  const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext
  if (!AudioCtx) throw new Error('AudioContext unavailable')
  const resp = await fetch(dataUrl)
  const buf = await resp.arrayBuffer()
  const ctx: AudioContext = new AudioCtx()
  try {
    const decoded = await ctx.decodeAudioData(buf)
    const channel = decoded.getChannelData(0)
    const bucketSize = Math.max(1, Math.floor(channel.length / buckets))
    const peaks: number[] = []
    for (let i = 0; i < buckets; i++) {
      let max = 0
      const start = i * bucketSize
      const end = Math.min(channel.length, start + bucketSize)
      for (let j = start; j < end; j += 16) {
        const v = Math.abs(channel[j])
        if (v > max) max = v
      }
      peaks.push(max)
    }
    const overall = Math.max(...peaks, 0.01)
    return peaks.map((p) => p / overall)
  } finally {
    void ctx.close().catch(() => {})
  }
}

function drawPeaks(canvas: HTMLCanvasElement, peaks: number[]): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const width = canvas.clientWidth || 300
  const height = canvas.height || 40
  canvas.width = width
  ctx.clearRect(0, 0, width, height)
  const barWidth = width / peaks.length
  ctx.fillStyle = '#FCE300'
  peaks.forEach((peak, i) => {
    const h = Math.max(2, peak * height)
    ctx.globalAlpha = 0.45 + peak * 0.55
    ctx.fillRect(i * barWidth + barWidth * 0.15, (height - h) / 2, barWidth * 0.7, h)
  })
  ctx.globalAlpha = 1
}

// ------------------------------------------------------------ factory 单例

let audioPageInstance: AudioPage | null = null

export function createAudioPage(app: AppInterface, store?: AudioLibraryStore): AudioPage {
  audioPageInstance = new AudioPage(app, store)
  return audioPageInstance
}

export function getAudioPage(): AudioPage | null {
  return audioPageInstance
}

export default AudioPage
