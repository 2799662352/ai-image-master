/**
 * 启动动画引擎(engine.js)对外的类型。
 *
 * 引擎是从上游 dsh-startup-screen 移植来的 ES5 脚本,内部不写类型;
 * 宿主只通过这里声明的窄接口和它说话。
 */

/** 第 1 / 2 步等待用户确认时的动作种类 */
export type StartupActionKind = 'grant' | 'confirm'

export interface StartupActionEvent {
  action: StartupActionKind
  /** 引擎当前认为的登录态:true 已登录 / false 游客 / null 还没水合出来 */
  authenticated: boolean | null
}

export interface StartupFinishEvent {
  /** 用户主动跳过(Esc / 跳过按钮)也会走 onFinish,只是 skipped 为 true */
  skipped: boolean
}

export interface StartupEngineConfig {
  theme?: 'light' | 'dark'
  speed?: number
  /** 第 1、2 步是否真的等用户点击;false 时自动往下走 */
  requireInteraction?: boolean
  allowSkip?: boolean
  /** 界面合成音效(WebAudio) */
  sound?: boolean
  soundVolume?: number
  /** 语音播报总开关(素材缺失时静音) */
  voice?: boolean
  voiceVolume?: number
  /** 素材缺失时是否回落到浏览器自带 TTS(默认 false:缺素材就静音) */
  ttsFallback?: boolean
  identity?: string
  identityId?: string
  accessLevel?: string
  /** true 已登录 / false 游客 / null 未知(水合前) */
  authenticated?: boolean | null
  accent?: string
  /** 左侧品牌块下方的小字,如 `REV 4.9.33 · DESKTOP` */
  revision?: string
}

/** HTMLAudioElement 的最小子集,测试里可以注入假的 */
export interface StartupAudioLike {
  preload: string
  volume: number
  readonly duration: number
  readonly readyState: number
  play(): Promise<void> | void
  pause(): void
  addEventListener(type: string, cb: () => void, opts?: unknown): void
  removeEventListener(type: string, cb: () => void): void
  load?(): void
}

export interface StartupEngineOptions {
  config?: StartupEngineConfig
  /** 语音素材目录(以 / 结尾),里面放 line-1.mp3 … line-6.mp3 */
  assetBase?: string
  /** 品牌标识图(白色剪影 PNG / SVG)的地址 */
  markUrl?: string
  onAction?: (e: StartupActionEvent) => void
  /** 用户即将看到应用的那一刻(含被跳过);宿主在这里记「今天播过了」 */
  onFinish?: (e: StartupFinishEvent) => void
  /** 淡出完成、根节点已摘除 */
  onDone?: (e: StartupFinishEvent) => void
  createAudio?: (url: string) => StartupAudioLike
}

export interface StartupScreenHandle {
  skip(): void
  finish(): void
  dispose(): void
  /** 更新「欢迎 XXX」与身份卡上的名字;身份编号由引擎按名字重新推导 */
  setIdentity(name: string): void
  /** 登录态水合出来 / 变化时调用;影响第 1 步按钮是不是「网页登录」 */
  setAuthenticated(authenticated: boolean): void
  isFinished(): boolean
}

export interface StartupEngineModule {
  createStartupScreen(options: StartupEngineOptions): StartupScreenHandle
}
