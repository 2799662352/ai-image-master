// src/renderer/src/features/voice/useHoldToTalk.ts
/**
 * 按住 F8 说话(对应 Shinsekai `chat-stage/hooks/useHoldToTalk.ts`)。
 * F8 只在本窗口有焦点时生效,不占任何打字键;Esc / 失焦 / 窗口隐藏都算取消。
 */

import { useEffect, useRef } from 'react'

export type HoldToTalkCommand = 'begin-asr-hold' | 'finish-asr-hold' | 'cancel-asr-hold'

export function useHoldToTalk({
  enabled,
  disabled,
  onCommand,
}: {
  enabled: boolean
  disabled: boolean
  onCommand: (command: HoldToTalkCommand) => void | Promise<void>
}): void {
  const queue = useRef<Promise<void>>(Promise.resolve())
  useEffect(() => {
    if (!enabled || disabled) return
    let held = false
    let finishing = false
    const send = (command: HoldToTalkCommand) => {
      // 松手再快,结束命令也要排在开始命令之后。
      queue.current = queue.current.catch(() => {}).then(() => onCommand(command))
      return queue.current
    }
    const finish = (cancel: boolean) => {
      if (!held) return
      held = false
      finishing = true
      void send(cancel ? 'cancel-asr-hold' : 'finish-asr-hold')
        .catch(() => {})
        .finally(() => {
          finishing = false
        })
    }
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && held) {
        event.preventDefault()
        finish(true)
        return
      }
      if (
        event.code !== 'F8' ||
        event.repeat ||
        held ||
        finishing ||
        event.isComposing ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        event.shiftKey ||
        document.hidden
      )
        return
      event.preventDefault()
      held = true
      void send('begin-asr-hold').catch(() => {
        finish(true)
      })
    }
    const keyUp = (event: KeyboardEvent) => {
      if (event.code !== 'F8' || !held) return
      event.preventDefault()
      finish(false)
    }
    const cancel = () => finish(true)
    const visibilityChanged = () => {
      if (document.hidden) cancel()
    }
    window.addEventListener('keydown', keyDown)
    window.addEventListener('keyup', keyUp)
    window.addEventListener('blur', cancel)
    document.addEventListener('visibilitychange', visibilityChanged)
    return () => {
      cancel()
      window.removeEventListener('keydown', keyDown)
      window.removeEventListener('keyup', keyUp)
      window.removeEventListener('blur', cancel)
      document.removeEventListener('visibilitychange', visibilityChanged)
    }
  }, [enabled, disabled, onCommand])
}
