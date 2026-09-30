// src/renderer/src/features/voice/VoiceControls.tsx
/**
 * Composer 工具栏上的语音入口:一颗分段药丸 —— 语音输入(持续收听)| 朗读开关 | 设置。
 * 设置面板 portal 到 body、fixed 定位在药丸上方,不受侧栏等祖先的裁剪和层叠压制。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { ChevronUp, Loader2, Mic, MicOff, Volume2, VolumeX } from 'lucide-react'
import { getVoiceSession } from './agentChatVoice'
import { asrProviders } from './asr/asrRegistry'
import { ttsProviders } from './tts/ttsRegistry'
import { QWEN_TTS_VOICES } from './tts/qwenRealtimeTtsAdapter'
import { useHoldToTalk, type HoldToTalkCommand } from './useHoldToTalk'
import { QWEN_TTS_PROVIDER, SEED_AUDIO_TTS_PROVIDER, VOSK_ASR_PROVIDER } from './voiceDefaults'
import { useVoiceStore, type CommitPending } from './voiceStore'

const SEGMENT =
  'relative flex items-center gap-1.5 px-2 py-1 transition disabled:cursor-not-allowed disabled:opacity-50 hover:bg-zinc-800/70'
const FIELD =
  'rounded border border-zinc-700/80 bg-zinc-900 px-1.5 py-0.5 text-zinc-100 outline-none focus:border-cyan-400/50'
const PANEL_WIDTH = 320
const VIEWPORT_MARGIN = 8
/** 高于宠物层(40001),低于全屏遮罩类弹窗。 */
const PANEL_Z = 40010

export const SEND_DELAY_OPTIONS: readonly { ms: number; label: string }[] = [
  { ms: 1000, label: '1 秒(说话利索)' },
  { ms: 2000, label: '2 秒(默认)' },
  { ms: 4000, label: '4 秒(边想边说)' },
]

function progressLabel(received: number, total: number): string {
  if (!total) return `${Math.round(received / 1_048_576)} MB`
  return `${Math.min(100, Math.round((received / total) * 100))}%`
}

/** 等待提交的倒计时条:从满格线性缩到 0。 */
function PendingBar({ pending }: { pending: CommitPending }) {
  const [style, setStyle] = useState<CSSProperties>({ width: '100%' })
  useEffect(() => {
    const remaining = Math.max(0, pending.delayMs - (Date.now() - pending.since))
    const frame = requestAnimationFrame(() => setStyle({ width: '0%', transition: `width ${remaining}ms linear` }))
    return () => cancelAnimationFrame(frame)
  }, [pending])
  return (
    <span
      aria-hidden
      data-testid="agent-voice-pending"
      className="absolute bottom-0 left-0 h-0.5 bg-cyan-300/80"
      style={style}
    />
  )
}

function panelPosition(anchor: HTMLElement): CSSProperties {
  const rect = anchor.getBoundingClientRect()
  const maxLeft = window.innerWidth - PANEL_WIDTH - VIEWPORT_MARGIN
  return {
    position: 'fixed',
    bottom: window.innerHeight - rect.top + 8,
    left: Math.max(VIEWPORT_MARGIN, Math.min(rect.right - PANEL_WIDTH, maxLeft)),
    width: PANEL_WIDTH,
    maxHeight: Math.max(160, rect.top - 16),
    zIndex: PANEL_Z,
  }
}

export function VoiceControls({ disabled }: { disabled: boolean }) {
  const asr = useVoiceStore((s) => s.asr)
  const commitPending = useVoiceStore((s) => s.commitPending)
  const modelProgress = useVoiceStore((s) => s.modelProgress)
  const speaking = useVoiceStore((s) => s.speaking)
  const audioLocked = useVoiceStore((s) => s.audioLocked)
  const error = useVoiceStore((s) => s.error)
  const settings = useVoiceStore((s) => s.settings)
  const updateSettings = useVoiceStore((s) => s.updateSettings)
  const [panelOpen, setPanelOpen] = useState(false)
  const [panelStyle, setPanelStyle] = useState<CSSProperties | null>(null)
  const anchorRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const onHoldCommand = useCallback(async (command: HoldToTalkCommand) => {
    const session = getVoiceSession()
    if (command === 'begin-asr-hold') session.beginHold()
    else await session.finishHold(command === 'cancel-asr-hold')
  }, [])
  useHoldToTalk({ enabled: settings.holdToTalk, disabled, onCommand: onHoldCommand })

  useLayoutEffect(() => {
    if (!panelOpen) return
    const place = () => {
      if (anchorRef.current) setPanelStyle(panelPosition(anchorRef.current))
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [panelOpen])

  useEffect(() => {
    if (!panelOpen) return
    const close = (event: PointerEvent) => {
      const target = event.target as Node
      if (anchorRef.current?.contains(target) || panelRef.current?.contains(target)) return
      setPanelOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPanelOpen(false)
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [panelOpen])

  const pending = asr.running && commitPending ? commitPending : null
  const micLabel = asr.loading
    ? modelProgress
      ? `${modelProgress.phase === 'convert' ? '解包' : '下载模型'} ${progressLabel(modelProgress.received, modelProgress.total)}`
      : '加载中'
    : pending
      ? settings.autoSend
        ? '待发送'
        : '待填入'
      : asr.running
        ? '听写中'
        : asr.enabled
          ? '等回复'
          : '语音'
  const usesVosk = settings.asrProvider === VOSK_ASR_PROVIDER
  const micTitle =
    error ??
    (pending
      ? `停顿 ${Math.round(pending.delayMs / 100) / 10} 秒内接着说会续在后面;${settings.autoSend ? '之后自动发送' : '之后填进输入框'}`
      : asr.enabled
        ? '暂停语音输入'
        : usesVosk
          ? '开启语音输入(首次使用会下载约 44 MB 的离线识别模型)'
          : '开启语音输入(千问实时识别,按平台余额计费,只在说话时送音频)')
  const border = error
    ? 'border-red-400/50'
    : asr.enabled || settings.ttsEnabled || speaking || audioLocked
      ? 'border-cyan-300/50'
      : 'border-zinc-700/80'

  const speakerTitle = audioLocked
    ? '系统拦下了自动播放,点一下继续朗读'
    : speaking
      ? '停止朗读'
      : settings.ttsEnabled
        ? '关闭朗读回复'
        : settings.ttsProvider === SEED_AUDIO_TTS_PROVIDER
          ? '朗读回复(豆包音频,按平台余额计费,约 ¥1/分钟)'
          : '朗读回复(千问实时合成,按平台余额计费)'
  const onSpeakerClick = () => {
    const session = getVoiceSession()
    if (audioLocked) void session.unlockAudio()
    else if (speaking) session.stopSpeaking()
    else updateSettings({ ttsEnabled: !settings.ttsEnabled })
  }

  const panel = panelOpen ? (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="语音设置"
      style={panelStyle ?? { position: 'fixed', visibility: 'hidden', zIndex: PANEL_Z }}
      className="space-y-2.5 overflow-y-auto rounded-lg border border-zinc-700/80 bg-zinc-950/95 p-3 text-[11px] text-zinc-300 shadow-xl backdrop-blur"
    >
      <p className="text-[10px] uppercase tracking-[0.18em] text-cyan-300/70">语音输入</p>
      <label className="flex items-center justify-between gap-2">
        <span className="shrink-0">识别引擎</span>
        <select
          value={settings.asrProvider}
          onChange={(event) => updateSettings({ asrProvider: event.target.value })}
          className={`${FIELD} min-w-0 flex-1`}
        >
          {asrProviders().map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center justify-between gap-2">
        <span className="shrink-0">说完后</span>
        <select
          value={settings.autoSend ? 'send' : 'fill'}
          onChange={(event) => updateSettings({ autoSend: event.target.value === 'send' })}
          className={`${FIELD} min-w-0 flex-1`}
        >
          <option value="send">自动发送</option>
          <option value="fill">只填进输入框,我自己发</option>
        </select>
      </label>
      <label className="flex items-center justify-between gap-2">
        <span className="shrink-0">停顿多久算说完</span>
        <select
          value={String(settings.sendDelayMs)}
          onChange={(event) => updateSettings({ sendDelayMs: Number(event.target.value) })}
          className={`${FIELD} min-w-0 flex-1`}
        >
          {SEND_DELAY_OPTIONS.some((option) => option.ms === settings.sendDelayMs) ? null : (
            <option value={String(settings.sendDelayMs)}>{settings.sendDelayMs} 毫秒</option>
          )}
          {SEND_DELAY_OPTIONS.map((option) => (
            <option key={option.ms} value={String(option.ms)}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <p className="text-[10px] leading-relaxed text-zinc-500">
        话尾像没说完(逗号、「然后」「就是」「嗯」这类)会多等一倍,最多 8 秒。
      </p>
      <label className="flex items-center justify-between gap-2">
        <span>按住 F8 说话,松手结束这段话</span>
        <input
          type="checkbox"
          checked={settings.holdToTalk}
          onChange={(event) => updateSettings({ holdToTalk: event.target.checked })}
        />
      </label>

      <p className="border-t border-zinc-800 pt-2.5 text-[10px] uppercase tracking-[0.18em] text-cyan-300/70">朗读</p>
      <label className="flex items-center justify-between gap-2">
        <span>朗读回复</span>
        <input
          type="checkbox"
          checked={settings.ttsEnabled}
          onChange={(event) => updateSettings({ ttsEnabled: event.target.checked })}
        />
      </label>
      <label className="flex items-center justify-between gap-2">
        <span className="shrink-0">朗读引擎</span>
        <select
          value={settings.ttsProvider}
          onChange={(event) => updateSettings({ ttsProvider: event.target.value })}
          className={`${FIELD} min-w-0 flex-1`}
        >
          {ttsProviders().map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.label}
            </option>
          ))}
        </select>
      </label>
      {settings.ttsProvider === QWEN_TTS_PROVIDER ? (
        <label className="flex items-center justify-between gap-2">
          <span className="shrink-0">音色</span>
          <select
            value={settings.ttsVoice}
            onChange={(event) => updateSettings({ ttsVoice: event.target.value })}
            className={`${FIELD} min-w-0 flex-1`}
          >
            {QWEN_TTS_VOICES.map((voice) => (
              <option key={voice.id} value={voice.id}>
                {voice.label}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <label className="block space-y-1">
          <span>声线描述</span>
          <input
            type="text"
            value={settings.voicePrompt}
            onChange={(event) => updateSettings({ voicePrompt: event.target.value })}
            className="w-full rounded border border-zinc-700/80 bg-zinc-900 px-2 py-1 text-zinc-100 outline-none focus:border-cyan-400/50"
          />
        </label>
      )}
      <label className="flex items-center justify-between gap-2">
        <span>分句朗读(每句单独生成,开口更快)</span>
        <input
          type="checkbox"
          checked={settings.ttsSplitEnabled}
          onChange={(event) => updateSettings({ ttsSplitEnabled: event.target.checked })}
        />
      </label>
      <label className="flex items-center justify-between gap-2">
        <span>每条回复最多念</span>
        <span className="flex items-center gap-1">
          <input
            type="number"
            min={20}
            max={2000}
            step={10}
            value={settings.ttsMaxChars}
            onChange={(event) => {
              const value = Number(event.target.value)
              if (Number.isFinite(value) && value > 0) updateSettings({ ttsMaxChars: Math.round(value) })
            }}
            className="w-16 rounded border border-zinc-700/80 bg-zinc-900 px-1.5 py-0.5 text-right text-zinc-100 outline-none focus:border-cyan-400/50"
          />
          字
        </span>
      </label>
      {error ? <p className="text-red-300">{error}</p> : null}
    </div>
  ) : null

  return (
    <div
      ref={anchorRef}
      role="group"
      aria-label="语音"
      className={`flex items-stretch overflow-hidden rounded-md border bg-zinc-900/70 text-[11px] ${border}`}
    >
      <button
        type="button"
        data-testid="agent-voice-mic"
        data-active={asr.enabled ? 'true' : 'false'}
        onClick={() => getVoiceSession().toggleListening()}
        className={`${SEGMENT} ${error ? 'text-red-200' : asr.enabled ? 'text-cyan-100' : 'text-zinc-200'}`}
        aria-label={micTitle}
        title={micTitle}
      >
        {asr.loading ? (
          <Loader2 size={11} aria-hidden className="animate-spin opacity-80" />
        ) : asr.enabled ? (
          <MicOff size={11} aria-hidden className="opacity-80" />
        ) : (
          <Mic size={11} aria-hidden className="opacity-80" />
        )}
        <span className="font-medium">{micLabel}</span>
        {asr.running && !pending ? (
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-300" aria-hidden />
        ) : null}
        {pending ? <PendingBar key={pending.since} pending={pending} /> : null}
      </button>
      <span aria-hidden className="w-px bg-zinc-700/80" />
      <button
        type="button"
        data-testid="agent-voice-speaker"
        data-active={settings.ttsEnabled ? 'true' : 'false'}
        onClick={onSpeakerClick}
        className={`${SEGMENT} px-1.5 ${audioLocked ? 'text-amber-200' : settings.ttsEnabled || speaking ? 'text-cyan-100' : 'text-zinc-400'}`}
        aria-label={speakerTitle}
        title={speakerTitle}
      >
        {settings.ttsEnabled || speaking || audioLocked ? (
          <Volume2 size={12} aria-hidden className={speaking || audioLocked ? 'animate-pulse' : 'opacity-90'} />
        ) : (
          <VolumeX size={12} aria-hidden className="opacity-70" />
        )}
      </button>
      <span aria-hidden className="w-px bg-zinc-700/80" />
      <button
        type="button"
        data-testid="agent-voice-settings"
        onClick={() => setPanelOpen((open) => !open)}
        className={`${SEGMENT} px-1 text-zinc-300`}
        aria-haspopup="dialog"
        aria-expanded={panelOpen}
        aria-label="语音设置"
        title="语音设置"
      >
        <ChevronUp size={11} aria-hidden className={`opacity-70 transition ${panelOpen ? '' : 'rotate-180'}`} />
      </button>
      {panel ? createPortal(panel, document.body) : null}
    </div>
  )
}
