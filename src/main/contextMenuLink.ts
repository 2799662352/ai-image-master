/**
 * 右键菜单里一个链接该给什么动作。
 *
 * 聊天正文里的文件引用现在是真链接(见 `shared/fileCitation.ts` 的模块注释),
 * 但 Electron 的 `context-menu` 事件只告诉我们 `params.linkURL` 有没有值。原先
 * 的处理据此无条件给出「复制链接 / 在浏览器中打开」—— 对 `https://` 是对的,
 * 对 `file:///D:/第28集/脚本.md` 就是把一条本地路径喂给 `shell.openExternal`,
 * 用户看到的是「点了没反应」。
 *
 * 分类和拼菜单拆开:`context-menu` 回调挂在 `webContents` 上,单测里构造不出来,
 * 而「哪些形态算本地文件」恰恰是全部易错之处 —— 尤其**行号后缀**:
 * `vscode://file/D:/a.ts:42` 直接丢给资源管理器,定位的是一个不存在的路径。
 *
 * 复用 `parseFileCitation` 而不是在这里另写一个判断:它已经认全了 Codex
 * `file_opener` 的四种 scheme、两种行号写法和百分号编码,并且有自己的用例。
 * 两份解析器迟早会对不齐。
 */

import { parseFileCitation } from '../shared/fileCitation'

export type ContextMenuLink =
  /** 本地文件:菜单给「在文件夹中显示 / 用默认程序打开 / 复制路径」。 */
  | { kind: 'file'; osPath: string }
  /** 其余一律维持原行为(外部浏览器 + 复制链接),包括 mailto、tel 这些。 */
  | { kind: 'web'; url: string }

/**
 * 盘符路径统一成反斜杠。
 *
 * 不用 `path.normalize`:单测在 CI 上跑 Linux,那里它不会把 `/` 换成 `\`,
 * 断言就会随宿主系统漂。按「看起来是不是 Windows 路径」判断则处处一致。
 */
function toOsPath(input: string): string {
  return /^[A-Za-z]:/.test(input) ? input.replace(/\//g, '\\') : input
}

/**
 * 不收 workspaceRoot:Electron 给的 `params.linkURL` 是 Chromium **已经按页面
 * 地址绝对化过**的 URL,正文里写的相对路径到这里已经变成 `http://localhost:…/src/a.ts`
 * 了,拿工作区根去解也解不回来。收一个永远不会被查的参数只会让人以为它有用。
 * (左键那条路在渲染进程里,拿得到原始 href,所以它认相对路径。)
 */
export function classifyContextMenuLink(linkURL: string): ContextMenuLink {
  const citation = parseFileCitation(linkURL)
  if (citation) return { kind: 'file', osPath: toOsPath(citation.path) }
  return { kind: 'web', url: linkURL }
}
