import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'

/**
 * 缩略图右下角的「复制 / 下载」两颗毛玻璃小按钮(悬停才出现),聊天里所有图片缩略图共用:
 * 生成图卡(MediaTile)、助手正文里嵌的图(MarkdownImage)。
 *
 * 两个动作都走主进程 IPC(`shell:copy-image` / `shell:save-as`),传**原始地址**(https /
 * local-file:// / file:// / 裸路径 / data:),不是渲染用的 blob: —— 主进程读不到 blob:。
 * 之前只有「下载」,且主进程只认 file:// 和裸路径,所以 https / local-file:// 的图点了没反应;
 * 「复制」则根本没有按钮,只能靠右键菜单。
 */

type ShellApi = {
  copyImage?: (uri: string) => Promise<{ success?: boolean; error?: string }>
  saveAs?: (uri: string, name: string) => Promise<{ success?: boolean; canceled?: boolean; error?: string }>
}

function shellApi(): ShellApi | undefined {
  return (window as Window & { electronAPI?: { shell?: ShellApi } }).electronAPI?.shell
}

export type ImageActionOutcome = 'ok' | 'canceled' | { error: string }

/** 复制到剪贴板。没有 IPC(纯网页环境)也给出明确原因,而不是静默。 */
export async function copyImageToClipboard(uri: string): Promise<ImageActionOutcome> {
  const copy = shellApi()?.copyImage
  if (!copy) return { error: '当前环境不支持复制图片' }
  try {
    const res = await copy(uri)
    return res?.success ? 'ok' : { error: res?.error || '复制失败' }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** 另存为。用户在对话框里点取消不算失败。 */
export async function saveImageAs(uri: string, name: string): Promise<ImageActionOutcome> {
  const save = shellApi()?.saveAs
  if (!save) return { error: '当前环境不支持另存为' }
  try {
    const res = await save(uri, name)
    if (res?.success && res.canceled) return 'canceled'
    return res?.success ? 'ok' : { error: res?.error || '保存失败' }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

type Flash = { kind: 'ok' } | { kind: 'error'; message: string } | null

/** 按钮上的短暂反馈:成功 1.5 s、失败 3 s 后复原;组件卸载时清掉计时器。 */
function useFlash(): [Flash, (f: Flash) => void] {
  const [flash, setFlash] = useState<Flash>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )
  const show = (f: Flash): void => {
    if (timer.current) clearTimeout(timer.current)
    setFlash(f)
    if (f) timer.current = setTimeout(() => setFlash(null), f.kind === 'ok' ? 1500 : 3000)
  }
  return [flash, show]
}

const BTN =
  'glassbtn inline-flex h-5 w-5 items-center justify-center rounded-full transition-opacity focus-visible:opacity-100'

function Icon({ d }: { d: string }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

const COPY_ICON = 'M9 9h11v11H9zM5 15V4h11'
const SAVE_ICON = 'M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2'
const OK_ICON = 'M5 12.5 10 17.5 19 7'
const ERR_ICON = 'M12 7v6M12 17h.01'

/**
 * 灯箱顶栏的「复制 / 下载」文字按钮。灯箱里原来只有原生右键菜单能复制,
 * 而且是对着 blob: 的 `<img>` 右键 —— 入口太隐蔽,用户反馈「放大了也复制不了」。
 */
export function LightboxImageActions({ uri, name, isImage }: { uri: string; name: string; isImage: boolean }): JSX.Element {
  const [copyFlash, showCopy] = useFlash()
  const [saveFlash, showSave] = useFlash()
  const cls = 'cursor-pointer rounded-full px-3 py-1 text-[12px] text-zinc-300 transition-colors hover:bg-zinc-800/80 hover:text-white'
  const label = (idle: string, done: string, flash: Flash): string =>
    flash?.kind === 'ok' ? done : flash?.kind === 'error' ? `${idle}失败` : idle

  return (
    <span className="flex items-center gap-1">
      {isImage ? (
        <button
          type="button"
          aria-label="复制图片"
          title={copyFlash?.kind === 'error' ? copyFlash.message : undefined}
          className={cls}
          onClick={(e) => {
            e.stopPropagation()
            void copyImageToClipboard(uri).then((r) =>
              showCopy(r === 'ok' ? { kind: 'ok' } : r === 'canceled' ? null : { kind: 'error', message: r.error }),
            )
          }}
        >
          {label('复制', '已复制', copyFlash)}
        </button>
      ) : null}
      <button
        type="button"
        aria-label="下载图片"
        title={saveFlash?.kind === 'error' ? saveFlash.message : undefined}
        className={cls}
        onClick={(e) => {
          e.stopPropagation()
          void saveImageAs(uri, name).then((r) =>
            showSave(r === 'ok' ? { kind: 'ok' } : r === 'canceled' ? null : { kind: 'error', message: r.error }),
          )
        }}
      >
        {label('下载', '已保存', saveFlash)}
      </button>
    </span>
  )
}

export interface ImageHoverActionsProps {
  /** 图片的**原始**地址(不是 blob:)。 */
  uri: string
  name: string
  /** 视频没有「复制」(主进程按图片解码),传 false 只留下载。默认 true。 */
  canCopy?: boolean
  /** 外层定位 / 显隐,默认右下角、悬停显示(外层要有 `group` + `relative`)。 */
  className?: string
}

export function ImageHoverActions({ uri, name, canCopy = true, className }: ImageHoverActionsProps): JSX.Element {
  const [copyFlash, showCopy] = useFlash()
  const [saveFlash, showSave] = useFlash()

  const onCopy = (e: React.MouseEvent): void => {
    e.stopPropagation()
    void copyImageToClipboard(uri).then((r) =>
      showCopy(r === 'ok' ? { kind: 'ok' } : r === 'canceled' ? null : { kind: 'error', message: r.error }),
    )
  }
  const onSave = (e: React.MouseEvent): void => {
    e.stopPropagation()
    void saveImageAs(uri, name).then((r) =>
      showSave(r === 'ok' ? { kind: 'ok' } : r === 'canceled' ? null : { kind: 'error', message: r.error }),
    )
  }

  // 出了反馈的那一颗要一直可见,别因为鼠标刚好移开就看不到「失败了」。
  const vis = (f: Flash): string => (f ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')

  return (
    <div className={className ?? 'absolute bottom-1 right-1 flex items-center gap-1'}>
      {canCopy ? (
        <button
          type="button"
          aria-label={`复制 ${name}`}
          title={copyFlash?.kind === 'error' ? `复制失败:${copyFlash.message}` : copyFlash?.kind === 'ok' ? '已复制' : '复制图片'}
          onClick={onCopy}
          className={`${BTN} ${vis(copyFlash)} ${copyFlash?.kind === 'error' ? 'text-red-300' : ''}`}
        >
          <Icon d={copyFlash?.kind === 'ok' ? OK_ICON : copyFlash?.kind === 'error' ? ERR_ICON : COPY_ICON} />
        </button>
      ) : null}
      <button
        type="button"
        aria-label={`下载 ${name}`}
        title={saveFlash?.kind === 'error' ? `保存失败:${saveFlash.message}` : saveFlash?.kind === 'ok' ? '已保存' : '另存为…'}
        onClick={onSave}
        className={`${BTN} ${vis(saveFlash)} ${saveFlash?.kind === 'error' ? 'text-red-300' : ''}`}
      >
        <Icon d={saveFlash?.kind === 'ok' ? OK_ICON : saveFlash?.kind === 'error' ? ERR_ICON : SAVE_ICON} />
      </button>
    </div>
  )
}
