/**
 * 主窗口键盘快捷键路由。
 *
 * 历史: F11 原本由默认 application menu 的 `role: 'togglefullscreen'`
 * 注册 accelerator,Electron 自动绑定切换全屏。我们在
 * `src/main/index.ts` 里 `Menu.setApplicationMenu(null)` 去掉了应用菜单
 * (注释说"性能优化:禁用默认应用菜单"),副作用是 F11 也跟着失效 —— 用户
 * 反馈 v4.3.6+ 按 F11 全无反应。v4.3.12 在 `before-input-event` 里显式
 * 拦截 F11 并 toggle fullscreen 把这条 affordance 还回来。
 *
 * 抽成纯函数好处:
 *   1. 跟 4 条已有快捷键(F12 / F5 / Ctrl-R / Ctrl-Shift-R)一起得到单测覆盖,
 *      之前它们是 inline closure 里的 if-else,无单测。
 *   2. F11 这一条作为同款分支接入,不破坏既有顺序约束(Ctrl-Shift-R 必须
 *      先于 Ctrl-R 判,否则强刷会闪两次,见 v4.2.x 历史)。
 *   3. 显式只在 `keyDown` 上 fire —— `before-input-event` 同时报 keyDown
 *      和 keyUp,toggle 类动作(devtools / fullscreen)若 keyUp 也响应会
 *      net 到 no-op。
 */
export type ShortcutAction =
  | { type: 'toggleDevTools' }
  | { type: 'reload' }
  | { type: 'reloadIgnoringCache' }
  | { type: 'toggleFullScreen' }

// 跟 Electron `Input` 的子集,只取我们需要判定的字段。不直接 import
// `electron.Input` 因为这个模块需要在不依赖 electron 运行时的环境下测试。
export interface ShortcutInput {
  key: string
  type: 'keyDown' | 'keyUp'
  control: boolean
  meta: boolean
  shift: boolean
}

export function resolveMainWindowShortcut(input: ShortcutInput): ShortcutAction | null {
  if (input.type !== 'keyDown') return null
  if (input.key === 'F12') return { type: 'toggleDevTools' }
  // Ctrl+Shift+R / Cmd+Shift+R 必须先于普通 Ctrl+R 判定 —— 否则一次强刷
  // 会先命中 reload 再命中 reloadIgnoringCache,UI 闪两次(v4.2.x 旧 bug)。
  if ((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'r') {
    return { type: 'reloadIgnoringCache' }
  }
  if ((input.control || input.meta) && input.key.toLowerCase() === 'r') {
    return { type: 'reload' }
  }
  if (input.key === 'F5') return { type: 'reload' }
  if (input.key === 'F11') return { type: 'toggleFullScreen' }
  return null
}
