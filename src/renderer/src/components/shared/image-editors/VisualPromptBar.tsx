import { useEffect, useRef, useState } from 'react'
import { useUIPrefsStore } from '../../../stores/useUIPrefsStore'
import { useDisplaySrc } from '../../../hooks/useDisplaySrc'
import ImageEditorModal, { type ImageChoice } from './ImageEditorModal'
import './image-editors.css'

type Variant = 'cyber' | 'director' | 'punk'
type EditorType = 'angle' | 'light' | 'panorama' | 'director'
type PanoTab = 'preview' | 'generate'

interface Props {
  /** 参考图候选(顺序即 @图片N 的序号);空数组 = 无参考图,按钮禁用 */
  imageChoices: ImageChoice[]
  /** 注入构造好的 prompt 到当前模式输入框 */
  onInject: (text: string) => void
  variant?: Variant
  /** 工具栏容器附加 class(各页边距差异) */
  containerClassName?: string
  /** 工具栏容器附加 style(punk 用) */
  containerStyle?: React.CSSProperties
  /**
   * 提供后,工具栏出现「图层分离」—— 把**选中的那张参考图**拆成底图 + 透明图层栈。
   *
   * 这是个**开关**:按下=选中待拆的图,页面主按钮随之改名「拆图」,点主按钮才真跑
   * (拆分按张计费,一次能出 17 张,不做成点一下就扣钱)。再按一次取消。
   *
   * 用这个按钮自身的按下态当唯一的状态凭据,不另起横条 —— 状态就一个 bit,
   * 值不上一整行 UI。
   *
   * 「拆哪张」在这一排有明确答案:用参考图选择器选中的那张(单张时就是它)。
   */
  onLayerSplit?: (imageUrl: string) => void
  /** 已进入拆图状态(按钮显示为按下)。由宿主持有,因为主按钮的文案也要跟着变。 */
  splitArmed?: boolean
}

/** 选图缩略图 —— useDisplaySrc 处理 blob/cos 跨进程可读问题 */
function SelectorThumb({
  url,
  label,
  active,
  accent,
  isPunk,
  onClick,
}: {
  url: string
  label: string
  active: boolean
  accent: string
  isPunk: boolean
  onClick: () => void
}) {
  const src = useDisplaySrc(url)
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-pressed={active}
      className="cursor-pointer focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-offset-zinc-900"
      style={{
        width: 44,
        height: 44,
        padding: 0,
        border: isPunk
          ? `3px solid ${active ? 'var(--punk-toxic)' : 'var(--punk-black)'}`
          : `2px solid ${active ? accent : '#3f3f46'}`,
        background: 'transparent',
        boxShadow: isPunk && active ? '3px 3px 0 var(--punk-pink)' : undefined,
        transform: active ? 'scale(1.05)' : 'scale(1)',
        transition: 'transform 120ms ease, border-color 120ms ease',
      }}
    >
      <img
        src={src}
        alt={label}
        loading="lazy"
        decoding="async"
        style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover' }}
      />
    </button>
  )
}

/**
 * VisualPromptBar — 图生图模式下的共享视觉 prompt 辅助工具栏。
 *
 * 统一了 5 个页面(单次 / 批量 / 对比 / 导演 / Punk)的视觉 prompt 入口:
 *   [多角度] [打光] [全景 ▾(生成全景图 / 进入全景)] + 参考图选择器
 *
 * 相比旧实现的改进:
 *   - 「N 张可选」从纯文字升级为可点击缩略图选择器,选中的图作为编辑器入参
 *     (对全景同样生效——旧版全景永远用第 1 张);
 *   - 生成全景图 / 进入全景合并为单按钮下拉,减少按钮拥挤。
 */
export default function VisualPromptBar({
  imageChoices,
  onInject,
  variant = 'cyber',
  containerClassName,
  containerStyle,
  onLayerSplit,
  splitArmed = false,
}: Props) {
  const enabled = useUIPrefsStore((s) => s.imageEditorToolbar.enabled)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [editorState, setEditorState] = useState<{
    type: EditorType
    imageUrl: string
    tab?: PanoTab
    /** 导演台入口:有参考图 = 全景导入,无 = 原生空网格 */
    directorEntry?: 'native' | 'panorama'
  } | null>(null)
  const [panoOpen, setPanoOpen] = useState(false)
  const panoRef = useRef<HTMLDivElement>(null)

  // 选中索引越界保护(参考图被删后)
  const safeIndex = imageChoices.length > 0 ? Math.min(selectedIndex, imageChoices.length - 1) : 0

  // 下拉外部点击关闭
  useEffect(() => {
    if (!panoOpen) return
    const onDown = (e: PointerEvent) => {
      if (panoRef.current && !panoRef.current.contains(e.target as Node)) setPanoOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [panoOpen])

  const isPunk = variant === 'punk'
  const modalTheme = isPunk ? 'punk' : 'default'
  const hasRef = imageChoices.length > 0

  const openEditor = (type: EditorType, tab?: PanoTab) => {
    // 导演台可无参考图直接进(原生空网格);其余编辑器仍需参考图。
    if (type !== 'director' && !hasRef) return
    setPanoOpen(false)
    setEditorState({
      type,
      imageUrl: hasRef ? imageChoices[safeIndex].url : '',
      tab,
      directorEntry: type === 'director' ? (hasRef ? 'panorama' : 'native') : undefined,
    })
  }

  // ---- 主题样式 ----
  const accent = variant === 'director' ? '#c084fc' : variant === 'punk' ? 'var(--punk-toxic)' : '#22d3ee'

  const cyberBtn = (en: boolean) =>
    en
      ? 'px-3 py-1.5 border-2 border-zinc-700 bg-zinc-900 text-zinc-200 font-mono text-[11px] uppercase tracking-wider hover:border-cyberpunk-yellow hover:text-cyberpunk-yellow transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-cyberpunk-yellow'
      : 'px-3 py-1.5 border-2 border-zinc-800 bg-zinc-900/40 text-zinc-600 font-mono text-[11px] uppercase tracking-wider cursor-not-allowed'

  const directorBtn = (en: boolean) =>
    en
      ? 'px-3 py-1 text-xs font-mono border rounded-none bg-[#09090B] border-[#3F3F46] text-purple-300 hover:border-purple-400 hover:text-purple-200 transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-purple-400'
      : 'px-3 py-1 text-xs font-mono border rounded-none bg-[#09090B] border-[#27272A] text-white/30 cursor-not-allowed'

  const punkBtnStyle = (en: boolean): React.CSSProperties => ({
    padding: '8px 14px',
    fontWeight: 900,
    fontSize: 12,
    letterSpacing: '0.04em',
    cursor: en ? 'pointer' : 'not-allowed',
    opacity: en ? 1 : 0.45,
    border: '3px solid var(--punk-black)',
    background: 'var(--punk-cream)',
    color: 'var(--punk-black)',
    boxShadow: en ? '3px 3px 0 var(--punk-black)' : 'none',
    transition: 'transform 100ms ease, box-shadow 100ms ease',
  })

  // 统一的「按钮属性」工厂
  const btnProps = (en: boolean): { className?: string; style?: React.CSSProperties } => {
    if (isPunk) return { className: 'p-mono', style: punkBtnStyle(en) }
    if (variant === 'director') return { className: directorBtn(en) }
    return { className: cyberBtn(en) }
  }

  const labelText = variant === 'cyber' ? '// visual prompt' : '// VISUAL.PROMPT'
  const labelClass =
    variant === 'cyber'
      ? 'font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500'
      : variant === 'director'
        ? 'text-[10px] text-white/40 font-mono uppercase tracking-wider'
        : 'p-mono'
  const labelStyle: React.CSSProperties | undefined = isPunk
    ? { fontSize: 11, fontWeight: 900, letterSpacing: '0.08em', color: 'var(--punk-black)', opacity: 0.7 }
    : undefined

  const hintClass =
    variant === 'cyber'
      ? 'font-mono text-[10px] text-zinc-500'
      : variant === 'director'
        ? 'text-[10px] text-white/40 font-mono'
        : 'p-mono'
  const hintStyle: React.CSSProperties | undefined = isPunk
    ? { fontSize: 10, color: 'var(--punk-black)', opacity: 0.6, letterSpacing: '0.06em' }
    : undefined

  // ---- 全景下拉菜单 ----
  const menuItems: { label: string; desc: string; tab: PanoTab }[] = [
    { label: '生成全景图', desc: '注入 360° 全景提示词', tab: 'generate' },
    { label: '进入全景', desc: '环视 / 截图 / 透视', tab: 'preview' },
  ]

  const panoLabel = variant === 'cyber' ? '全景 // pano' : '[ 全景 ]'

  if (!enabled) return null

  const defaultContainerClass =
    variant === 'cyber'
      ? 'flex items-center gap-2 flex-wrap'
      : variant === 'director'
        ? 'flex items-center gap-2 mb-2 flex-wrap'
        : ''
  const punkContainerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    margin: '4px 0 16px',
    flexWrap: 'wrap',
  }

  return (
    <>
      <div
        role="toolbar"
        aria-label="视觉 prompt 辅助"
        className={`${defaultContainerClass} ${containerClassName ?? ''}`.trim()}
        style={isPunk ? { ...punkContainerStyle, ...containerStyle } : containerStyle}
      >
        <span className={labelClass} style={labelStyle}>
          {labelText}
        </span>

        <button
          type="button"
          disabled={!hasRef}
          onClick={() => openEditor('angle')}
          title={hasRef ? '基于参考图构造多角度 prompt' : '请先上传参考图'}
          {...btnProps(hasRef)}
        >
          {variant === 'cyber' ? '多角度 // angle' : '[ 多角度 // ANGLE ]'}
        </button>

        <button
          type="button"
          disabled={!hasRef}
          onClick={() => openEditor('light')}
          title={hasRef ? '基于参考图构造打光 prompt' : '请先上传参考图'}
          {...btnProps(hasRef)}
        >
          {variant === 'cyber' ? '打光 // light' : '[ 打光 // LIGHT ]'}
        </button>

        {/* 全景:单按钮 + 两选项下拉 */}
        <div ref={panoRef} style={{ position: 'relative', display: 'inline-flex' }}>
          <button
            type="button"
            disabled={!hasRef}
            onClick={() => setPanoOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={panoOpen}
            title={hasRef ? '全景:生成 / 进入查看' : '请先上传参考图'}
            {...btnProps(hasRef)}
          >
            {panoLabel} {hasRef ? (panoOpen ? '▴' : '▾') : '▾'}
          </button>

          {panoOpen && hasRef && (
            <div
              role="menu"
              className={
                isPunk
                  ? ''
                  : 'absolute left-0 top-full mt-1 z-30 min-w-[180px] border-2 border-zinc-700 bg-zinc-900 shadow-xl py-1'
              }
              style={
                isPunk
                  ? {
                      position: 'absolute',
                      left: 0,
                      top: '100%',
                      marginTop: 6,
                      zIndex: 30,
                      minWidth: 190,
                      border: '3px solid var(--punk-black)',
                      background: 'var(--punk-cream)',
                      boxShadow: '4px 4px 0 var(--punk-black)',
                    }
                  : undefined
              }
            >
              {menuItems.map((it) => (
                <button
                  key={it.tab}
                  type="button"
                  role="menuitem"
                  onClick={() => openEditor('panorama', it.tab)}
                  className={
                    isPunk
                      ? 'p-mono'
                      : 'block w-full text-left px-3 py-2 cursor-pointer transition-colors hover:bg-zinc-800 focus:outline-none focus:bg-zinc-800'
                  }
                  style={
                    isPunk
                      ? {
                          display: 'block',
                          width: '100%',
                          textAlign: 'left',
                          padding: '8px 12px',
                          background: 'transparent',
                          border: 'none',
                          cursor: 'pointer',
                          color: 'var(--punk-black)',
                          fontWeight: 800,
                        }
                      : undefined
                  }
                >
                  <span
                    className={isPunk ? '' : 'block font-mono text-[11px] uppercase tracking-wider text-zinc-100'}
                    style={isPunk ? { fontSize: 12 } : undefined}
                  >
                    {it.label}
                  </span>
                  <span
                    className={isPunk ? '' : 'block font-mono text-[9px] text-zinc-500 normal-case'}
                    style={isPunk ? { fontSize: 9, opacity: 0.7 } : undefined}
                  >
                    {it.desc}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 导演台:3D 舞台(模型库 / 镜头 / 灯光 / 多视角截图)。无参考图=原生空网格,有=全景导入 */}
        <button
          type="button"
          onClick={() => openEditor('director')}
          title={hasRef ? '导入导演台(选中图作全景背景)' : '打开 3D 导演台(原生空网格)'}
          {...btnProps(true)}
        >
          {variant === 'cyber' ? '导演台 // 3d' : '[ 导演台 // 3D ]'}
        </button>

        {/* 图层分离:把选中的参考图拆成 1 底图 + 最多 16 层透明 PNG。
            渠道由动作自己钉住 Seedream 5.0 Pro,所以按钮**不随模型出现/消失** ——
            用户不该为了看见它先去切模型。 */}
        {onLayerSplit && (
          <button
            type="button"
            disabled={!hasRef}
            aria-pressed={splitArmed}
            onClick={() => hasRef && onLayerSplit(imageChoices[safeIndex].url)}
            title={
              !hasRef
                ? '请先上传参考图'
                : splitArmed
                  ? '已选中待拆的图 —— 点下方主按钮开始拆分；再按一次取消'
                  : '把选中的参考图拆成底图 + 透明图层（Seedream 5.0 Pro，按张计费，最多 17 张）'
            }
            {...btnProps(hasRef)}
            style={{
              ...btnProps(hasRef).style,
              ...(splitArmed
                ? isPunk
                  ? { background: 'var(--punk-toxic)', boxShadow: '3px 3px 0 var(--punk-pink)' }
                  : { borderColor: '#eab308', color: '#eab308', background: 'rgba(234,179,8,0.12)' }
                : null),
            }}
          >
            {variant === 'cyber'
              ? `图层分离 // split${splitArmed ? ' ✓' : ''}`
              : `[ 图层分离 // SPLIT${splitArmed ? ' ✓' : ''} ]`}
          </button>
        )}

        {!hasRef && (
          <span className={hintClass} style={hintStyle}>
            ← 先上传参考图
          </span>
        )}

        {/* 参考图选择器:替代旧版被动的「N 张可选」文字 */}
        {hasRef && imageChoices.length > 1 && (
          <>
            <span className={hintClass} style={hintStyle}>
              选图:
            </span>
            {imageChoices.map((ch, i) => (
              <SelectorThumb
                key={ch.url}
                url={ch.url}
                label={ch.label || `#${i + 1}`}
                active={i === safeIndex}
                accent={accent}
                isPunk={isPunk}
                onClick={() => setSelectedIndex(i)}
              />
            ))}
          </>
        )}
      </div>

      {editorState && (
        <ImageEditorModal
          editorType={editorState.type}
          imageUrl={editorState.imageUrl}
          imageChoices={imageChoices}
          theme={modalTheme}
          onInjectPrompt={(p) => {
            onInject(p)
            setEditorState(null)
          }}
          panoramaTab={editorState.tab}
          directorEntry={editorState.directorEntry}
          onClose={() => setEditorState(null)}
        />
      )}
    </>
  )
}
