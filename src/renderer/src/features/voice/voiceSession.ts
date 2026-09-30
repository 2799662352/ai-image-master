// src/renderer/src/features/voice/voiceSession.ts
/**
 * 把识别控制器、朗读、播放队列接到聊天上(对应 Shinsekai 聊天运行时里
 * `runtime_asr` + dialog media 那一段):
 *   - 中间结果写进输入框,最终结果直接发出去;
 *   - 每次开始一轮就 `pauseForTurn`,回合结束且朗读播完后 `replyFinished`;
 *   - 朗读按句排进播放队列,口型经 voiceRoute 交给宠物。
 */

import type { AsrAdapter, TranscriptionCallback } from './asr/asrAdapter'
import { createAsrAdapter } from './asr/asrRegistry'
import { commitDelayFor } from './asr/endpointing'
import { StreamingAsrController, type AsrEvent, type AsrOperation } from './asr/streamingAsrController'
import { SoundPlayer } from './audio/soundPlayer'
import type { GeneratedSpeech, TtsAdapter } from './tts/ttsAdapter'
import { TtsManager } from './tts/ttsManager'
import { generateSpeechPieces } from './tts/ttsGeneration'
import { createTtsAdapter } from './tts/ttsRegistry'
import { speechTextFromReply } from './tts/speechText'
import { PET_VOICE_NAME, routeAvatarVoice } from './voiceRoute'
import { useVoiceStore, type VoiceSettings } from './voiceStore'

export interface VoiceChatBridge {
  getDraft(): string
  setDraft(text: string): void
  canSubmit(): boolean
  /** 把文本作为一条用户消息发出去;返回 false 表示没发出去。 */
  submit(text: string): Promise<boolean>
  isRunning(): boolean
  subscribeRunning(listener: (running: boolean) => void): () => void
  /** 当前线程;回合结束时线程已经换了就不念(那不是这一轮的回复)。 */
  threadKey(): string | undefined
  /** 最近一轮 assistant 的最终答复(纯文本或 markdown);没有就 null。 */
  latestReply(): string | null
}

export interface VoiceSessionDeps {
  createAsrAdapter?: (
    settings: VoiceSettings,
    callback: TranscriptionCallback,
    onFault: (error: Error) => void,
  ) => AsrAdapter | Promise<AsrAdapter>
  createTtsAdapter?: (settings: VoiceSettings) => TtsAdapter
  player?: SoundPlayer
  tts?: TtsManager
  resumeDelayMs?: number
  silenceSubmitMs?: number
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function joinDraft(base: string, text: string): string {
  if (!base || /\s$/.test(base)) return `${base}${text}`
  if (!text) return base
  return /[A-Za-z0-9]$/.test(base) && /^[A-Za-z0-9]/.test(text) ? `${base} ${text}` : `${base}${text}`
}

const OPERATION_LABELS: Record<AsrOperation, string> = {
  load: '语音识别模型加载失败',
  start: '麦克风没能启动',
  stop: '语音识别没能正常停止',
  pause: '语音识别没能暂停',
  submit: '语音输入没能发出去',
  event: '语音输入状态更新失败',
  loading: '语音输入状态更新失败',
}

export class VoiceSession {
  private controller: StreamingAsrController
  private readonly makeAsr: NonNullable<VoiceSessionDeps['createAsrAdapter']>
  private readonly asrTiming: Pick<VoiceSessionDeps, 'resumeDelayMs' | 'silenceSubmitMs'>
  private readonly player: SoundPlayer
  private readonly tts: TtsManager
  private readonly makeTtsAdapter: (settings: VoiceSettings) => TtsAdapter
  private ttsAdapter: { key: string; adapter: TtsAdapter } | null = null
  private readonly unsubscribers: (() => void)[] = []
  /** 最近一次由语音写进输入框的文字;用户自己打的字不会被语音清空。 */
  private lastWrittenDraft = ''
  /** 手动发送模式下,当前这段话开口前输入框里已有的内容。 */
  private draftBase: string | null = null
  private awaitingReply = false
  private turnThread: string | undefined
  private speakAbort: AbortController | null = null
  private playbackSeq = 0

  constructor(
    private readonly chat: VoiceChatBridge,
    deps: VoiceSessionDeps = {},
  ) {
    this.makeAsr =
      deps.createAsrAdapter ??
      ((settings, callback, onFault) =>
        createAsrAdapter(settings.asrProvider, settings.language, callback, { onFault }))
    this.asrTiming = { resumeDelayMs: deps.resumeDelayMs, silenceSubmitMs: deps.silenceSubmitMs }
    this.makeTtsAdapter =
      deps.createTtsAdapter ??
      ((settings) =>
        createTtsAdapter(settings.ttsProvider, { voicePrompt: settings.voicePrompt, voice: settings.ttsVoice }))
    this.player = deps.player ?? new SoundPlayer(undefined, routeAvatarVoice)
    this.tts = deps.tts ?? new TtsManager()
    this.controller = this.buildController()
    this.unsubscribers.push(
      this.chat.subscribeRunning((running) => (running ? this.handleTurnStarted() : this.handleTurnEnded())),
      this.player.subscribeLock((locked) => useVoiceStore.getState().setAudioLocked(locked)),
      useVoiceStore.subscribe((state, previous) => {
        const next = state.settings
        const prev = previous.settings
        if (next.asrProvider !== prev.asrProvider || next.language !== prev.language) this.restartAsr()
      }),
    )
  }

  private buildController(): StreamingAsrController {
    return new StreamingAsrController({
      adapterFactory: (callback) =>
        this.makeAsr(useVoiceStore.getState().settings, callback, (error) =>
          this.reportError(`语音识别出错: ${error.message}`),
        ),
      emitEvent: (event) => this.handleAsrEvent(event),
      submitFinal: (text) => this.submitTranscript(text),
      onError: (operation, error) => this.reportError(`${OPERATION_LABELS[operation]}: ${errorMessage(error)}`),
      commitDelayMs: (text) => commitDelayFor(text, useVoiceStore.getState().settings.sendDelayMs),
      ...this.asrTiming,
    })
  }

  /** 控制器会把适配器留在热态复用,换引擎或语言时整个换掉;原来开着就接着听。 */
  private restartAsr(): void {
    const wasEnabled = useVoiceStore.getState().asr.enabled
    this.controller.close()
    this.controller = this.buildController()
    useVoiceStore.getState().setAsr({ enabled: false, loading: false, running: false })
    useVoiceStore.getState().setCommitPending(null)
    if (!wasEnabled) return
    this.controller.userResume()
    if (this.awaitingReply) this.controller.pauseForTurn()
  }

  toggleListening(): void {
    const { asr } = useVoiceStore.getState()
    useVoiceStore.getState().setError(null)
    if (asr.enabled) this.controller.userPause()
    else this.controller.userResume()
  }

  /** 按住说话开始;当前发不了消息时抛错,调用方据此取消。 */
  beginHold(): void {
    if (!this.chat.canSubmit()) throw new Error('当前无法开始语音输入。')
    useVoiceStore.getState().setError(null)
    this.controller.beginHold()
  }

  async finishHold(cancel: boolean): Promise<void> {
    try {
      await this.controller.finishHold({ cancel })
    } catch (error) {
      this.reportError(errorMessage(error))
    }
  }

  stopSpeaking(): void {
    this.speakAbort?.abort()
    this.speakAbort = null
    this.player.stopVoice()
  }

  unlockAudio(): Promise<void> {
    return this.player.unlock()
  }

  dispose(): void {
    this.stopSpeaking()
    this.controller.close()
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe()
    this.player.dispose()
  }

  private handleAsrEvent(event: AsrEvent): void {
    if (event.type === 'asr.state') {
      const { enabled, loading, running } = event
      useVoiceStore.getState().setAsr({ enabled, loading, running })
      if (!loading) useVoiceStore.getState().setModelProgress(null)
      return
    }
    if (event.type === 'asr.pending') {
      useVoiceStore
        .getState()
        .setCommitPending(event.delayMs === null ? null : { delayMs: event.delayMs, since: Date.now() })
      return
    }
    if (event.type === 'asr.partial') this.writeDraft(event.text)
  }

  private writeDraft(text: string): void {
    if (!useVoiceStore.getState().settings.autoSend) {
      this.writeManualDraft(text)
      return
    }
    if (!text && this.chat.getDraft() !== this.lastWrittenDraft) return
    this.lastWrittenDraft = text
    this.chat.setDraft(text)
  }

  /**
   * 手动发送:这段话接在输入框原有内容后面(用户打的字、之前念进去的句子都留着),
   * 中间结果只改这段话自己。
   */
  private writeManualDraft(text: string): void {
    const draft = this.chat.getDraft()
    if (this.draftBase === null || draft !== this.lastWrittenDraft) {
      if (!text) return
      this.draftBase = draft
    }
    const next = joinDraft(this.draftBase, text)
    this.lastWrittenDraft = next
    this.chat.setDraft(next)
  }

  private async submitTranscript(text: string): Promise<boolean> {
    if (!useVoiceStore.getState().settings.autoSend) {
      this.writeManualDraft(text)
      this.draftBase = null
      this.lastWrittenDraft = ''
      // 没有回合要等:控制器把这次当作「已提交」,照回复结束的节奏接着听。
      this.controller.replyFinished()
      return true
    }
    if (!this.chat.canSubmit()) {
      // 发不出去的这句交给用户:控制器恢复收听时发的清空不再动它。
      this.chat.setDraft(text)
      this.lastWrittenDraft = ''
      return false
    }
    this.lastWrittenDraft = ''
    this.awaitingReply = true
    this.turnThread = this.chat.threadKey()
    const sent = await this.chat.submit(text)
    if (!sent) {
      this.awaitingReply = false
      return false
    }
    // 回合可能在 send 返回前就已结束(或被拦下没真正开跑),照常收尾。
    if (!this.chat.isRunning()) this.handleTurnEnded()
    return true
  }

  private handleTurnStarted(): void {
    this.awaitingReply = true
    this.turnThread = this.chat.threadKey()
    this.stopSpeaking()
    this.controller.pauseForTurn()
  }

  private handleTurnEnded(): void {
    if (!this.awaitingReply) return
    this.awaitingReply = false
    const settings = useVoiceStore.getState().settings
    const sameThread = this.chat.threadKey() === this.turnThread
    const reply = settings.ttsEnabled && sameThread ? this.chat.latestReply() : null
    const speech = reply ? speechTextFromReply(reply, settings.ttsMaxChars) : ''
    if (!speech) {
      this.controller.replyFinished()
      return
    }
    void this.speak(speech, settings).finally(() => this.controller.replyFinished())
  }

  private adapterFor(settings: VoiceSettings): TtsAdapter {
    const key = settings.ttsProvider
    if (this.ttsAdapter?.key !== key) {
      this.ttsAdapter = { key, adapter: this.makeTtsAdapter(settings) }
    }
    this.ttsAdapter.adapter.switchModel({ voicePrompt: settings.voicePrompt, voice: settings.ttsVoice })
    return this.ttsAdapter.adapter
  }

  private speak(text: string, settings: VoiceSettings): Promise<void> {
    this.stopSpeaking()
    const abort = new AbortController()
    this.speakAbort = abort
    const store = useVoiceStore.getState()
    try {
      this.tts.setAdapter(this.adapterFor(settings))
    } catch (error) {
      this.reportError(`朗读引擎不可用: ${errorMessage(error)}`)
      return Promise.resolve()
    }
    store.setSpeaking(true)

    return new Promise<void>((resolve) => {
      const pending = new Map<string, GeneratedSpeech>()
      let generationDone = false
      let settled = false
      const settle = () => {
        if (settled) return
        settled = true
        unsubscribe()
        for (const speech of pending.values()) speech.release?.()
        pending.clear()
        if (this.speakAbort === abort) this.speakAbort = null
        useVoiceStore.getState().setSpeaking(false)
        resolve()
      }
      const settleIfDrained = () => {
        if (generationDone && pending.size === 0) settle()
      }
      const unsubscribe = this.player.subscribeVoiceSignal((signal) => {
        const speech = pending.get(signal.playbackId)
        if (!speech || signal.state === 'started') return
        speech.release?.()
        pending.delete(signal.playbackId)
        if (signal.state === 'failed') console.warn('[voice] 朗读播放失败', signal.error)
        settleIfDrained()
      })
      abort.signal.addEventListener('abort', settle, { once: true })

      void (async () => {
        try {
          const pieces = generateSpeechPieces(this.tts, {
            text,
            splitEnabled: settings.ttsSplitEnabled,
            maxSentenceLength: settings.ttsMaxSentenceLength,
            signal: abort.signal,
          })
          for await (const speech of pieces) {
            if (abort.signal.aborted) {
              speech.release?.()
              break
            }
            const playbackId = `tts-${++this.playbackSeq}`
            pending.set(playbackId, speech)
            this.player.playVoice(playbackId, speech.url, 1, PET_VOICE_NAME)
          }
          if (!abort.signal.aborted && this.tts.lastError) {
            this.reportError(`朗读失败: ${this.tts.lastError}`)
          }
        } catch (error) {
          if (!abort.signal.aborted) this.reportError(`朗读失败: ${errorMessage(error)}`)
        } finally {
          generationDone = true
          settleIfDrained()
        }
      })()
    })
  }

  private reportError(message: string): void {
    useVoiceStore.getState().setError(message)
  }
}
