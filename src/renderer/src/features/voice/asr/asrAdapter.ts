// src/renderer/src/features/voice/asr/asrAdapter.ts
/**
 * 流式语音识别适配器(对应 Shinsekai `sdk/adapters/asr.py::ASRAdapter`)。
 *
 * - 构造参数 `(language, callback)`;`callback(text, isPartial)` 上报识别结果。
 * - `start` / `resume` 可以是异步的(麦克风授权、模型加载都要等)。
 * - 共享的语言等字段放在设置里,`configSchema` 只放各引擎自己的额外项。
 */

export type TranscriptionCallback = (text: string, isPartial: boolean) => void

export interface AsrConfigField {
  type: 'str' | 'bool' | 'number'
  label: string
  default?: string | boolean | number
}

export abstract class AsrAdapter {
  static configSchema(): Record<string, AsrConfigField> {
    return {}
  }

  constructor(
    readonly language: string,
    protected readonly callback: TranscriptionCallback,
  ) {}

  abstract start(): Promise<void> | void

  abstract stop(): Promise<void> | void

  /**
   * 停止采集,并在返回前发出缓冲里的最终结果。带解码缓冲的引擎应覆写;
   * 默认实现只是 stop,调用方可以保留最近一次的中间结果。
   */
  async finish(): Promise<void> {
    await this.stop()
  }

  /**
   * 结束一次按住说话,返回是否保持热态。默认沿用松手即停;模型/录音器
   * 重建代价高的引擎可以覆写成暂停采集并返回 true,下次按住直接复用。
   */
  async finishHold({ cancel = false }: { cancel?: boolean } = {}): Promise<boolean> {
    if (cancel) await this.stop()
    else await this.finish()
    return false
  }

  abstract getStatus(): string

  abstract pause(): void

  abstract resume(): void
}
