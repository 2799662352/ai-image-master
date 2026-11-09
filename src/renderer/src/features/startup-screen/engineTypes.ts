/**
 * 启动动画引擎(engine.js)对外的类型。
 *
 * 引擎是从上游 dsh-startup-screen 移植来的 ES5 脚本,内部不写类型;
 * 宿主只通过这里声明的窄接口和它说话。
 */

/**
 * 用户在第 1 / 2 步交给宿主的动作:
 *  - grant / confirm:点了主按钮。引擎在没登录时**不放行**,宿主要立刻拉起网页登录;
 *  - logout:第 2 步(身份确认)点了「退出登录」。
 */
export type StartupActionKind = 'grant' | 'confirm' | 'logout'

/**
 * 登录闸门的状态,由宿主经 setLoginState 推进:
 *  idle 可点 / checking 在确认登录状态 / waiting 浏览器登录已拉起、等授权 /
 *  error 这一轮没成(带原因,再点一次重试) / leaving 正在退出登录
 */
export type StartupLoginState = 'idle' | 'checking' | 'waiting' | 'error' | 'leaving'

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
  /** 界面音效总开关 */
  sound?: boolean
  soundVolume?: number
  /**
   * 界面音效来源(默认 'audio'):
   * 'audio' = 优先播素材目录里的 sfx-tick / sfx-ticks-run(「哒」),没加载好或播不出就回落合成音;
   * 'synth' = 一律现场合成(WebAudio),不请求任何音效文件。
   */
  sfx?: 'audio' | 'synth'
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
  /**
   * 没登录是否不放行(默认 true):游客点主按钮只会拉起网页登录并停在原地,
   * 唯一的出口是登录成功或显式「跳过」。宿主没有登录能力时才该关掉。
   */
  requireLogin?: boolean
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
  onAction?: (e: StartupActionEvent) => void
  /** 用户即将看到应用的那一刻(含被跳过);宿主在这里记「今天播过了」 */
  onFinish?: (e: StartupFinishEvent) => void
  /** 淡出完成、根节点已摘除 */
  onDone?: (e: StartupFinishEvent) => void
  createAudio?: (url: string) => StartupAudioLike
  /** 界面音效素材(sfx-*.mp3)用的工厂;不给就复用 createAudio。测试里分开注入,免得音效请求混进台词请求的计数 */
  createSfxAudio?: (url: string) => StartupAudioLike
}

export interface StartupScreenHandle {
  skip(): void
  finish(): void
  dispose(): void
  /** 更新「欢迎 XXX」与身份卡上的名字;身份编号由引擎按名字重新推导 */
  setIdentity(name: string): void
  /**
   * 登录态水合出来 / 变化时调用:影响按钮字样、身份卡、「退出 / 跳过登录」;
   * 变成已登录时,点过主按钮在等登录的这一步当场放行
   */
  setAuthenticated(authenticated: boolean): void
  /** 推进登录闸门;message 只在 error 时显示(一行纯文本) */
  setLoginState(state: StartupLoginState, message?: string): void
  /** 宿主没有登录能力:别拦人,已点过主按钮的这一步当场放行 */
  setLoginRequired(required: boolean): void
  isFinished(): boolean
}

export interface StartupEngineModule {
  createStartupScreen(options: StartupEngineOptions): StartupScreenHandle
}
