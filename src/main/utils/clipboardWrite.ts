/**
 * 主进程写剪贴板的两个入口,适配 Electron 44 起重构后的 `clipboard`(W3C Clipboard API 风格)。
 *
 * 为什么要包一层、依赖用注入而不是直接 `import { clipboard } from 'electron'`:
 *  - Electron 44 起 `clipboard.writeImage` / `readImage` 等窄接口被**移除**,
 *    写图只能走 `clipboard.write([new ClipboardItem({ 'image/png': Blob })])`。
 *    旧写法在 44+ 不是静默失效,而是 `TypeError: clipboard.writeImage is not a function`,
 *    外层 try/catch 会把它吞成 `{ success: false }` —— 「复制图片」悄悄坏掉。
 *  - `clipboard.writeText` 现在返回 Promise。不 await 能用,但失败会变成未处理的 rejection。
 *  - 注入依赖让单测不用起 Electron,也能钉住「调的是新接口、字节原样、不再碰旧接口」。
 *
 * 官方迁移说明:https://www.electronjs.org/docs/latest/breaking-changes (44.0,clipboard 两条)
 */

/** Electron `ClipboardItem` 的构造签名;payload 取值是 `Blob | string | Object`。 */
export type ClipboardItemCtor = new (data: Record<string, Blob | string>) => unknown

export interface ClipboardLike {
  writeText(text: string): Promise<void>
  write(items: unknown[]): Promise<void>
}

export interface ClipboardDeps {
  clipboard: ClipboardLike
  ClipboardItem: ClipboardItemCtor
}

/** 只用到 NativeImage 的这两个方法,单测里用假对象即可。 */
export interface PngEncodable {
  isEmpty(): boolean
  toPNG(): Uint8Array
}

/**
 * 把图写进系统剪贴板(统一编码成 PNG,保留透明通道)。
 * 空图返回 false、不碰剪贴板;写入失败会抛,由调用方决定怎么报。
 */
export async function writeImageToClipboard(image: PngEncodable, deps: ClipboardDeps): Promise<boolean> {
  if (image.isEmpty()) return false
  // 复制一份成独立的 Uint8Array:toPNG() 返回的 Buffer 可能是共享池的一个视图,
  // 直接塞进 Blob 在部分 TS lib 版本下类型也不通过。
  const png = new Uint8Array(image.toPNG())
  const blob = new Blob([png], { type: 'image/png' })
  await deps.clipboard.write([new deps.ClipboardItem({ 'image/png': blob })])
  return true
}

/**
 * 文本写剪贴板,用在右键菜单这类「点了就走」的回调里:
 * 不让调用方背 Promise,失败只记日志,不产生未处理的 rejection(Node 24 默认会抛)。
 */
export function writeTextToClipboard(
  text: string,
  deps: Pick<ClipboardDeps, 'clipboard'>,
  onError: (err: unknown) => void = (err) => console.error('[clipboard] writeText failed:', err),
): void {
  void deps.clipboard.writeText(text).catch(onError)
}
