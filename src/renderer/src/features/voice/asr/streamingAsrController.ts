// src/renderer/src/features/voice/asr/streamingAsrController.ts
/**
 * 流式语音识别的生命周期控制器(对应 Shinsekai `ai/asr/streaming_controller.py`)。
 *
 * 适配器在回合暂停期间保持加载;最终结果立刻提交,回复结束后隔一小段时间再恢复
 * 收听。只报中间结果的引擎在静音一段时间后强制定稿,免得识别出的话卡在输入框里。
 * 按住说话模式只收一段话,松手才提交,端点检测只当分段边界。
 */

import type { AsrAdapter, TranscriptionCallback } from './asrAdapter'

export type AsrEvent =
  | { type: 'asr.partial'; text: string }
  | { type: 'asr.final'; text: string }
  | { type: 'asr.state'; enabled: boolean; loading: boolean; running: boolean }
  /** 一句已说完、正在等是否接着说;`delayMs` 为 null 表示等待结束(已提交或被新话打断)。 */
  | { type: 'asr.pending'; delayMs: number | null }

export type AsrOperation = 'load' | 'start' | 'stop' | 'pause' | 'submit' | 'event' | 'loading'

export interface StreamingAsrControllerOptions {
  adapterFactory: (callback: TranscriptionCallback) => AsrAdapter | Promise<AsrAdapter>
  emitEvent: (event: AsrEvent) => void
  /** 返回 false = 这次发不出去,识别结果留在输入框。 */
  submitFinal: (text: string) => boolean | void | Promise<boolean | void>
  onLoadingChanged?: (loading: boolean) => void
  onError?: (operation: AsrOperation, error: unknown) => void
  resumeDelayMs?: number
  silenceSubmitMs?: number
  /**
   * 引擎报出一句的最终结果后再等多久才提交(参数是到目前为止的整段话);期间接着说
   * 就续在后面。0 = 立刻提交。服务端 VAD 的断句很短(几百毫秒),不等这一下,
   * 想一想的停顿就会把半句话发出去。
   */
  commitDelayMs?: (text: string) => number
}

/** 两段识别结果之间的连接符;前一段已经以标点结尾就不再加。 */
function joinPieces(head: string, piece: string, separator: string): string {
  if (!head) return piece
  if (!piece) return head
  return /[\s，。！？、；：,.!?;:]$/.test(head) ? `${head}${piece}` : `${head}${separator}${piece}`
}

const NOT_RUNNING_STATUSES = new Set(['error', 'failed', 'idle', 'paused', 'stopped'])

export class StreamingAsrController {
  private readonly adapterFactory: StreamingAsrControllerOptions['adapterFactory']
  private readonly emitEvent: StreamingAsrControllerOptions['emitEvent']
  private readonly submitFinal: StreamingAsrControllerOptions['submitFinal']
  private readonly onLoadingChanged?: (loading: boolean) => void
  private readonly onError?: (operation: AsrOperation, error: unknown) => void
  private readonly resumeDelayMs: number
  private readonly silenceSubmitMs: number
  private readonly commitDelayMs: (text: string) => number
  private commitPending = false

  private adapter: AsrAdapter | null = null
  private enabledFlag = false
  private active = false
  private started = false
  private activating = false
  private loading = false
  private turnPaused = false
  private closed = false
  private generation = 0
  private clearOnActivation = false
  private resumeTimer: ReturnType<typeof setTimeout> | null = null
  private silenceTimer: ReturnType<typeof setTimeout> | null = null
  private silenceGeneration = 0
  private originalText = ''
  private currentText = ''
  private holdToTalk = false
  private finishingHold = false
  private holdAdapterWarm = false
  /** 串起所有 stop,下一次 start 等它们落完(Python 版里 stop 是同步 join 的)。 */
  private stopping: Promise<void> = Promise.resolve()

  constructor(options: StreamingAsrControllerOptions) {
    this.adapterFactory = options.adapterFactory
    this.emitEvent = options.emitEvent
    this.submitFinal = options.submitFinal
    this.onLoadingChanged = options.onLoadingChanged
    this.onError = options.onError
    this.resumeDelayMs = Math.max(0, options.resumeDelayMs ?? 500)
    this.silenceSubmitMs = Math.max(0, options.silenceSubmitMs ?? 3500)
    this.commitDelayMs = options.commitDelayMs ?? (() => 0)
  }

  get enabled(): boolean {
    return this.enabledFlag && !this.closed
  }

  /** 打开持续收听;首次使用时才懒加载所选引擎。 */
  userResume(): void {
    if (this.holdToTalk || this.finishingHold) this.userPause()
    if (this.closed) return
    this.enabledFlag = true
    this.turnPaused = false
    this.clearOnActivation = true
    this.holdAdapterWarm = false
    this.cancelResumeTimer()
    this.cancelSilenceTimer()
    this.emitState()
    this.activateAsync()
  }

  /** 关闭收听并释放采集,直到用户再次打开。 */
  userPause(): void {
    if (this.closed) return
    this.enabledFlag = false
    this.active = false
    this.turnPaused = false
    this.clearOnActivation = false
    this.holdToTalk = false
    this.holdAdapterWarm = false
    this.cancelResumeTimer()
    this.cancelSilenceTimer()
    const adapter = this.started ? this.adapter : null
    this.started = false
    this.stopAdapter(adapter)
    this.emitState()
  }

  /** 收一段话直到显式松手,不自动发送。 */
  beginHold(): void {
    if (this.closed || this.holdToTalk || this.finishingHold) return
    const reuseWarmAdapter = this.holdAdapterWarm && this.adapter !== null && this.started
    if (!reuseWarmAdapter) this.userPause()
    if (this.closed) return
    this.holdToTalk = true
    this.holdAdapterWarm = false
    this.enabledFlag = true
    this.originalText = ''
    this.currentText = ''
    this.clearOnActivation = false
    this.emitEventSafe({ type: 'asr.partial', text: '' })
    this.activateAsync()
  }

  /** 先把解码器里的结果放干净再提交一次;取消永远不提交。 */
  async finishHold({ cancel = false }: { cancel?: boolean } = {}): Promise<void> {
    if (!this.holdToTalk || this.finishingHold) return
    this.finishingHold = true
    const adapter = this.started ? this.adapter : null
    if (cancel || adapter === null) this.enabledFlag = false
    this.cancelSilenceTimer()
    let failed = false
    let keptWarm = false
    try {
      if (adapter !== null) keptWarm = Boolean(await adapter.finishHold({ cancel }))
    } catch (error) {
      failed = true
      this.stopAdapter(adapter)
      throw error
    } finally {
      const text = this.currentText.trim()
      const submit =
        Boolean(text) && adapter !== null && this.holdToTalk && !(cancel || failed || this.closed)
      this.holdToTalk = false
      this.finishingHold = false
      this.enabledFlag = false
      this.active = false
      this.started = keptWarm && !failed && !this.closed
      this.holdAdapterWarm = this.started
      this.turnPaused = false
      if (submit) {
        try {
          if ((await this.submitFinal(text)) === false) {
            throw new Error('语音输入没能发出去,识别结果已留在输入框。')
          }
        } catch (error) {
          this.emitEventSafe({ type: 'asr.partial', text })
          this.emitState()
          throw error
        }
        this.emitEventSafe({ type: 'asr.final', text })
        this.emitState()
      } else if (cancel) {
        this.emitEventSafe({ type: 'asr.partial', text: '' })
        this.emitState()
      } else {
        this.emitState()
      }
    }
  }

  /** 一轮对话处理期间临时暂停已打开的收听。 */
  pauseForTurn(): boolean {
    if (this.holdToTalk) {
      this.finishHold({ cancel: true }).catch((error) => this.reportError('stop', error))
      return true
    }
    if (this.closed || !this.enabledFlag) return false
    this.turnPaused = true
    this.active = false
    this.cancelResumeTimer()
    this.cancelSilenceTimer()
    const adapter = this.started ? this.adapter : null
    this.pauseAdapter(adapter)
    this.emitState()
    return true
  }

  /** 回复结束(含朗读播完)后,隔 resumeDelayMs 恢复被回合暂停的收听。 */
  replyFinished(): void {
    if (this.closed || !this.enabledFlag || !this.turnPaused) return
    this.cancelResumeTimer()
    this.resumeTimer = setTimeout(() => this.resumeAfterDelay(), this.resumeDelayMs)
  }

  /** 停掉适配器,丢弃所有进行中的懒加载。 */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.enabledFlag = false
    this.active = false
    this.turnPaused = false
    this.generation += 1
    this.cancelResumeTimer()
    this.cancelSilenceTimer()
    const adapter = this.adapter
    this.adapter = null
    this.started = false
    this.holdAdapterWarm = false
    this.stopAdapter(adapter)
  }

  private resumeAfterDelay(): void {
    this.resumeTimer = null
    if (this.closed || !this.enabledFlag || !this.turnPaused) return
    this.turnPaused = false
    this.clearOnActivation = true
    this.activateAsync()
  }

  private activateAsync(): void {
    if (this.closed || !this.enabledFlag || this.turnPaused || this.active || this.activating) return
    this.activating = true
    this.generation += 1
    const generation = this.generation
    this.emitState()
    void this.activateWorker(generation)
  }

  private retryActivationIfWanted(): void {
    if (!this.closed && this.enabledFlag && !this.turnPaused && !this.active) this.activateAsync()
  }

  private async activateWorker(generation: number): Promise<void> {
    let adapter = this.adapter
    if (adapter === null) {
      this.loading = true
      this.notifyLoading(true)
      try {
        adapter = await this.adapterFactory(this.handleTranscription)
      } catch (error) {
        if (generation === this.generation) {
          this.activating = false
          this.loading = false
          this.enabledFlag = false
        }
        this.notifyLoading(false)
        this.reportError('load', error)
        this.emitState()
        return
      }
      this.loading = false
      const stale = this.closed || generation !== this.generation
      if (!stale) this.adapter = adapter
      this.notifyLoading(false)
      if (stale) {
        this.activating = false
        this.stopAdapter(adapter, false)
        this.retryActivationIfWanted()
        return
      }
    }

    const shouldActivate =
      !this.closed && generation === this.generation && this.enabledFlag && !this.turnPaused
    const started = this.started
    if (!shouldActivate) {
      if (generation === this.generation) this.activating = false
      this.retryActivationIfWanted()
      return
    }

    try {
      await this.stopping
      if (started) adapter.resume()
      else await adapter.start()
      const status = adapter.getStatus()
      if (NOT_RUNNING_STATUSES.has(String(status ?? '').trim().toLowerCase())) {
        throw new Error(`识别引擎没有进入运行状态(status=${status})`)
      }
    } catch (error) {
      if (generation === this.generation) {
        this.activating = false
        this.active = false
        this.enabledFlag = false
        this.started = false
      }
      this.stopAdapter(adapter, false)
      this.reportError('start', error)
      this.emitState()
      return
    }

    this.started = true
    this.activating = false
    const shouldRemainActive =
      !this.closed && generation === this.generation && this.enabledFlag && !this.turnPaused
    this.active = shouldRemainActive
    const clearTranscript = shouldRemainActive && this.clearOnActivation
    if (clearTranscript) {
      this.clearOnActivation = false
      this.originalText = ''
      this.currentText = ''
    }

    if (!shouldRemainActive) {
      if (this.closed || !this.enabledFlag) {
        this.started = false
        this.stopAdapter(adapter)
      } else {
        this.pauseAdapter(adapter)
      }
      this.emitState()
      return
    }
    if (clearTranscript) this.emitEventSafe({ type: 'asr.partial', text: '' })
    this.emitState()
  }

  private readonly handleTranscription: TranscriptionCallback = (text, isPartial) => {
    void this.processTranscription(text, isPartial)
  }

  /** `immediate`:静音兜底已经等过了,不再叠加提交延迟。 */
  private async processTranscription(text: string, isPartial: boolean, immediate = false): Promise<void> {
    const rawText = String(text ?? '')
    if (this.closed || !this.enabledFlag || this.turnPaused) return
    const adapter = this.adapter
    const english = String(adapter?.language ?? '').trim().toLowerCase().startsWith('en')
    const separator = english ? ' ' : '，'
    const clean = (value: string): string => (english ? value.trim() : value.replace(/ /g, '').trim())

    if (this.holdToTalk) {
      const piece = clean(rawText)
      if (!piece) return
      this.currentText = `${this.originalText}${this.originalText ? separator : ''}${piece}`
      if (!isPartial) this.originalText = this.currentText
      this.emitEventSafe({ type: 'asr.partial', text: this.currentText })
      return
    }

    if (isPartial) {
      if (!rawText) return
      const previous = this.currentText
      this.currentText = joinPieces(this.originalText, rawText, separator)
      // 有的实时引擎在麦克风静音时反复报同一句假设,只有文字变了才算在说话,
      // 否则这些重复回调会把静音兜底无限往后推。
      if (this.currentText !== previous || this.silenceTimer === null) this.scheduleSilenceSubmit()
      this.emitEventSafe({ type: 'asr.partial', text: this.currentText })
      return
    }

    this.cancelSilenceTimer()
    const finalPiece = clean(rawText)
    if (!finalPiece) return
    const built = joinPieces(this.originalText, finalPiece, separator)
    const current = this.currentText.trim()
    if (current && (current === built.trim() || current.endsWith(finalPiece))) {
      this.originalText = this.currentText
    } else {
      this.currentText = built
      this.originalText = built
    }
    const delay = immediate ? 0 : Math.max(0, this.commitDelayMs(this.currentText.trim()))
    if (delay > 0) {
      this.emitEventSafe({ type: 'asr.partial', text: this.currentText.trim() })
      this.scheduleCommit(delay)
      return
    }
    await this.commitTranscript(adapter)
  }

  private async commitTranscript(adapter: AsrAdapter | null): Promise<void> {
    const displayed = this.currentText.trim()
    if (!displayed) return
    this.turnPaused = true
    this.active = false

    this.pauseAdapter(adapter)
    let accepted: boolean | void
    try {
      accepted = await this.submitFinal(displayed)
    } catch (error) {
      this.reportError('submit', error)
      accepted = false
    }
    if (accepted === false) {
      if (!this.closed && this.enabledFlag) {
        this.turnPaused = false
        this.clearOnActivation = true
      }
      this.activateAsync()
      return
    }
    this.emitEventSafe({ type: 'asr.final', text: displayed })
    this.emitState()
  }

  private pauseAdapter(adapter: AsrAdapter | null): void {
    if (adapter === null) return
    try {
      adapter.pause()
    } catch (error) {
      this.reportError('pause', error)
    }
  }

  private stopAdapter(adapter: AsrAdapter | null, report = true): void {
    if (adapter === null) return
    this.stopping = this.stopping
      .then(() => adapter.stop())
      .catch((error) => {
        if (report) this.reportError('stop', error)
      })
  }

  private emitState(): void {
    const enabled = this.enabledFlag && !this.closed
    const running = enabled && this.active && !this.turnPaused
    const loading = enabled && !this.turnPaused && (this.loading || (this.activating && !this.started))
    this.emitEventSafe({ type: 'asr.state', enabled, loading, running })
  }

  private emitEventSafe(event: AsrEvent): void {
    if (this.closed) return
    try {
      this.emitEvent(event)
    } catch (error) {
      this.reportError('event', error)
    }
  }

  private notifyLoading(loading: boolean): void {
    if (!this.onLoadingChanged) return
    try {
      this.onLoadingChanged(loading)
    } catch (error) {
      this.reportError('loading', error)
    }
  }

  private reportError(operation: AsrOperation, error: unknown): void {
    console.error(`[voice] 语音识别 ${operation} 失败`, error)
    if (this.onError && !this.closed) {
      try {
        this.onError(operation, error)
      } catch {
        // 错误回调本身出错不能再往外抛。
      }
    }
  }

  private cancelResumeTimer(): void {
    if (this.resumeTimer !== null) clearTimeout(this.resumeTimer)
    this.resumeTimer = null
  }

  private scheduleSilenceSubmit(): void {
    this.cancelSilenceTimer()
    if (this.silenceSubmitMs <= 0) return
    const generation = this.silenceGeneration
    this.silenceTimer = setTimeout(() => this.submitAfterSilence(generation), this.silenceSubmitMs)
  }

  private submitAfterSilence(generation: number): void {
    if (generation !== this.silenceGeneration) return
    this.silenceTimer = null
    if (this.closed || !this.enabledFlag || !this.active || this.turnPaused) return
    const displayed = this.currentText.trim()
    if (!displayed) return
    void this.processTranscription(displayed, false, true)
  }

  /** 和静音兜底共用一个计时器:接着说出中间结果时,它会被换成静音兜底。 */
  private scheduleCommit(delayMs: number): void {
    this.cancelSilenceTimer()
    const generation = this.silenceGeneration
    this.commitPending = true
    this.emitEventSafe({ type: 'asr.pending', delayMs })
    this.silenceTimer = setTimeout(() => {
      if (generation !== this.silenceGeneration) return
      this.silenceTimer = null
      this.endCommitPending()
      if (this.closed || !this.enabledFlag || !this.active || this.turnPaused) return
      void this.commitTranscript(this.adapter)
    }, delayMs)
  }

  private endCommitPending(): void {
    if (!this.commitPending) return
    this.commitPending = false
    this.emitEventSafe({ type: 'asr.pending', delayMs: null })
  }

  private cancelSilenceTimer(): void {
    this.silenceGeneration += 1
    if (this.silenceTimer !== null) clearTimeout(this.silenceTimer)
    this.silenceTimer = null
    this.endCommitPending()
  }
}
