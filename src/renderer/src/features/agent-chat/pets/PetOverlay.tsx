// src/renderer/src/features/agent-chat/pets/PetOverlay.tsx
/**
 * Codex 官方风格「环境宠物」(对齐 App/TUI pets,openai/codex#21206):
 *
 * - 宠物蹲在 composer 上方,精灵随 agent 状态换动画:
 *     isRunning            → running(干活中)
 *     pendingApprovals>0   → waiting(等你批准)
 *     error                → failed(摔倒)
 *     一轮刚跑完(≤6s)     → review(该看结果了)
 *     其余                 → idle
 * - 入口与官方一致:composer 输入 `/pets` 打开选择器(没有独立按钮);
 *   选择器首行是「关闭宠物」(官方 “Disable pets”),下面是内置宠物,
 *   右侧是所选宠物的动画预览(官方 preview pane)。
 * - 宠物可抓取:按住拖到任意位置(官方 App 宠物同样可拖拽),拖动中播
 *   jumping(被拎起来的观感),松手位置持久化,并钳制在视口内。
 * - 待机彩蛋:空闲时每隔几秒轮播一个小动作——挥手 / 向左散步 / 跳一下 /
 *   向右散步(用满 spritesheet 的 waving、running-left/right、jumping 行),
 *   做完回 idle。agent 一开始干活立即打断,散步位移不持久化。
 * - V2 宠物(11 行图集)在 idle 时看向鼠标,鼠标停下 2.5s 放掉视线。
 * - 选择/位置都持久化 localStorage。
 *
 * 渲染方式:官方 8x9 / 8x11 spritesheet 用 background-position 步进逐帧播放
 * (纯 CSS 背景,无 canvas/无额外依赖)。
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAgentChatStore } from '../store'
import {
  CUSTOM_PET_ID_PREFIX,
  PET_ANIMATIONS,
  PET_FPS,
  PET_FRAME_HEIGHT,
  PET_FRAME_WIDTH,
  PET_SHEET_COLS,
  PET_SHEET_ROWS_BY_VERSION,
  loadPetOffset,
  lookFrameForVector,
  savePetOffset,
  type PetAnimationState,
  type PetDefinition,
  type PetLookFrame,
} from './petAnimations'
import { detectPetFrameCounts } from './petFrameCounts'
import { allPets, usePetStore, useSelectedPet } from './petStore'
import { PET_VOICE_NAME, bindAvatarVoice } from '../../voice/voiceRoute'
import { useVoiceStore } from '../../voice/voiceStore'

/** 展示尺寸:原帧 192x208 的一半,和 composer 高度协调。 */
const DISPLAY_SCALE = 0.5
const REVIEW_LINGER_MS = 6000

// ----- 待机环境行为(idle variety)-----
// 空闲 5–10s 后按固定顺序轮播一个小动作,时长/步速如下。顺序固定 + 随机
// 间隔:观感够自然,又保持可测试性(测试 mock Math.random 即可确定性)。
const AMBIENT_MIN_DELAY_MS = 5000
const AMBIENT_DELAY_JITTER_MS = 5000
const AMBIENT_WAVING_MS = 2000
const AMBIENT_JUMPING_MS = 1400
const STROLL_STEP_MS = 50
const STROLL_STEP_PX = 2
const STROLL_DURATION_MS = 2200
/** 散步时距视口边缘的安全边距(px),防止走出窗口。 */
const STROLL_EDGE_MARGIN_PX = 8

// ----- V2 视线跟随 -----
// 指针离精灵中心不足这个距离时不转头(官方 lookDeadzone 的同款语义)。
const LOOK_DEADZONE_PX = 40
// 指针停下这么久后放掉视线、回到 idle 动画。官方桌面端视线格一旦非空就一直
// 盖住 idle(openai/codex#35442),宠物看起来像定格了。
const LOOK_RELEASE_MS = 2500

// ----- 朗读口型 -----
// 口型全开(1)时横向放大 / 纵向压扁的比例。
const MOUTH_SQUASH_X = 0.04
const MOUTH_SQUASH_Y = 0.07

type AmbientKind = 'waving' | 'stroll-left' | 'jumping' | 'stroll-right'
const AMBIENT_ROTATION: readonly AmbientKind[] = ['waving', 'stroll-left', 'jumping', 'stroll-right']

/** 自装宠物每行的实际帧数(内置宠物直接用推荐帧数)。 */
function usePetFrameCounts(pet: PetDefinition): number[] | null {
  const { custom, spritesheetPath, spriteVersion } = pet
  const [counts, setCounts] = useState<number[] | null>(null)
  useEffect(() => {
    setCounts(null)
    if (!custom) return undefined
    let cancelled = false
    void detectPetFrameCounts(spritesheetPath, PET_SHEET_ROWS_BY_VERSION[spriteVersion]).then((c) => {
      if (!cancelled) setCounts(c)
    })
    return () => {
      cancelled = true
    }
  }, [custom, spritesheetPath, spriteVersion])
  return counts
}

function PetSprite({
  pet,
  state,
  look = null,
  scale = DISPLAY_SCALE,
}: {
  pet: PetDefinition
  state: PetAnimationState
  /** V2 视线格;非空时显示这一格静帧,盖过 state 动画。 */
  look?: PetLookFrame | null
  scale?: number
}) {
  const [frame, setFrame] = useState(0)
  const anim = PET_ANIMATIONS[state]
  const detectedCounts = usePetFrameCounts(pet)
  const detected = (pet.frameCounts ?? detectedCounts)?.[anim.row]
  const frames = detected && detected > 0 ? detected : anim.frames

  useEffect(() => {
    setFrame(0)
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % frames)
    }, 1000 / PET_FPS)
    return () => clearInterval(timer)
  }, [state, frames])

  const w = PET_FRAME_WIDTH * scale
  const h = PET_FRAME_HEIGHT * scale
  const col = look ? look.col : frame % frames
  const row = look ? look.row : anim.row
  return (
    <div
      data-testid="agent-pet-sprite"
      data-pet-state={state}
      data-pet-look={look ? `${look.row}:${look.col}` : undefined}
      aria-hidden
      style={{
        width: w,
        height: h,
        backgroundImage: `url(${JSON.stringify(pet.spritesheetPath)})`,
        backgroundSize: `${PET_SHEET_COLS * w}px ${PET_SHEET_ROWS_BY_VERSION[pet.spriteVersion] * h}px`,
        backgroundPosition: `-${col * w}px -${row * h}px`,
        backgroundRepeat: 'no-repeat',
        imageRendering: 'auto',
        pointerEvents: 'none',
      }}
    />
  )
}

/** 由 chat store 派生宠物动画状态(review 有 6s 余韵)。 */
export function usePetState(): PetAnimationState {
  const isRunning = useAgentChatStore((s) => s.isRunning)
  const hasApprovals = useAgentChatStore((s) => s.pendingApprovals.length > 0)
  const hasError = useAgentChatStore((s) => s.error != null)
  const [reviewUntil, setReviewUntil] = useState(0)
  const wasRunning = useRef(false)
  const [, forceTick] = useState(0)

  useEffect(() => {
    if (wasRunning.current && !isRunning && !hasError) {
      const until = Date.now() + REVIEW_LINGER_MS
      setReviewUntil(until)
      const t = setTimeout(() => forceTick((n) => n + 1), REVIEW_LINGER_MS + 50)
      return () => clearTimeout(t)
    }
    wasRunning.current = isRunning
    return undefined
  }, [isRunning, hasError])

  useEffect(() => {
    wasRunning.current = isRunning
  }, [isRunning])

  if (hasError) return 'failed'
  if (hasApprovals) return 'waiting'
  if (isRunning) return 'running'
  if (Date.now() < reviewUntil) return 'review'
  return 'idle'
}

/**
 * 可抓取的宠物本体:按住拖到任意位置,松手把偏移持久化。位置 = 默认
 * 停靠点(composer 右上)+ 用户偏移(transform),拖动时钳制在视口内,
 * 防止拖出窗口后再也抓不回来。
 */
/**
 * V2 宠物在 idle 时看向鼠标。只听实体指针(官方桌面端只跟 Computer Use 虚拟
 * 光标,openai/codex#33224);指针静止 LOOK_RELEASE_MS 后放掉视线。
 */
function usePetLook(
  enabled: boolean,
  nodeRef: React.RefObject<HTMLDivElement | null>,
): PetLookFrame | null {
  const [look, setLook] = useState<PetLookFrame | null>(null)
  useEffect(() => {
    if (!enabled) {
      setLook(null)
      return undefined
    }
    let releaseTimer: number | undefined
    const onMove = (e: PointerEvent) => {
      const node = nodeRef.current
      if (!node) return
      const rect = node.getBoundingClientRect()
      const dx = e.clientX - (rect.left + rect.width / 2)
      const dy = e.clientY - (rect.top + rect.height / 2)
      const next = Math.hypot(dx, dy) < LOOK_DEADZONE_PX ? null : lookFrameForVector(dx, dy)
      setLook((prev) => (prev?.row === next?.row && prev?.col === next?.col ? prev : next))
      window.clearTimeout(releaseTimer)
      releaseTimer = window.setTimeout(() => setLook(null), LOOK_RELEASE_MS)
    }
    window.addEventListener('pointermove', onMove)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.clearTimeout(releaseTimer)
    }
  }, [enabled, nodeRef])
  return look
}

function DraggablePet({
  pet,
  state,
  dock,
}: {
  pet: PetDefinition
  state: PetAnimationState
  /** 停靠容器的位置;面板挪动或变宽时变化,触发重新钳制。 */
  dock: { left: number; top: number; width: number }
}) {
  const [offset, setOffset] = useState(loadPetOffset)
  const [dragging, setDragging] = useState(false)
  const [ambient, setAmbient] = useState<AmbientKind | null>(null)
  const speaking = useVoiceStore((s) => s.speaking)
  const nodeRef = useRef<HTMLDivElement>(null)
  const mouthRef = useRef<HTMLDivElement>(null)

  // 精灵图没有口型帧,朗读时按口型开合轻轻压扁(变宽变矮);直接写 style,不走 React 重渲染。
  useEffect(
    () =>
      bindAvatarVoice(PET_VOICE_NAME, {
        capabilities: { mouth: true },
        setMouthOpen: (value) => {
          const node = mouthRef.current
          if (!node) return
          node.style.transform = value > 0 ? `scale(${1 + MOUTH_SQUASH_X * value}, ${1 - MOUTH_SQUASH_Y * value})` : ''
        },
      }),
    [],
  )
  const offsetRef = useRef(offset)
  offsetRef.current = offset
  const ambientIndexRef = useRef(0)

  // 存下的偏移是在当时的窗口/面板布局里拖出来的;窗口变小或面板挪位后,
  // 同一个偏移可能把宠物放到视口外,看起来就是「宠物不见了」。这里只在显示上
  // 拉回可见区域,不改写 localStorage —— 窗口再变大时回到用户放的位置由下次
  // 拖动决定。
  useLayoutEffect(() => {
    const clampIntoView = () => {
      const node = nodeRef.current
      if (!node || dragRef.current) return
      const r = node.getBoundingClientRect()
      const dx = r.left < 0 ? -r.left : r.right > window.innerWidth ? window.innerWidth - r.right : 0
      const dy = r.top < 0 ? -r.top : r.bottom > window.innerHeight ? window.innerHeight - r.bottom : 0
      if (dx !== 0 || dy !== 0) setOffset((o) => ({ x: o.x + dx, y: o.y + dy }))
    }
    clampIntoView()
    window.addEventListener('resize', clampIntoView)
    return () => window.removeEventListener('resize', clampIntoView)
  }, [dock.left, dock.top, dock.width])

  // 待机环境行为循环:仅在「真 idle 且没被拎着」时运转;agent 一开始
  // 干活(state 变化)或用户抓起宠物,effect 重跑立即清场回正经状态。
  // 散步只改 offset 不落 localStorage —— 重启后宠物回到用户放它的地方。
  const idleActive = state === 'idle' && !dragging && !speaking
  useEffect(() => {
    if (!idleActive) {
      setAmbient(null)
      return undefined
    }
    let cancelled = false
    const timers: number[] = []
    let strollTimer: number | undefined

    const schedule = () => {
      const delay = AMBIENT_MIN_DELAY_MS + Math.random() * AMBIENT_DELAY_JITTER_MS
      timers.push(window.setTimeout(fire, delay))
    }
    const finish = () => {
      if (cancelled) return
      setAmbient(null)
      schedule()
    }
    function fire(): void {
      if (cancelled) return
      const kind = AMBIENT_ROTATION[ambientIndexRef.current % AMBIENT_ROTATION.length]
      ambientIndexRef.current += 1
      setAmbient(kind)
      if (kind === 'waving') {
        timers.push(window.setTimeout(finish, AMBIENT_WAVING_MS))
      } else if (kind === 'jumping') {
        timers.push(window.setTimeout(finish, AMBIENT_JUMPING_MS))
      } else {
        const dir = kind === 'stroll-left' ? -1 : 1
        const startedAt = Date.now()
        strollTimer = window.setInterval(() => {
          if (cancelled) return
          if (Date.now() - startedAt >= STROLL_DURATION_MS) {
            window.clearInterval(strollTimer)
            finish()
            return
          }
          // 每步都用实际 rect 检查,贴到视口边缘就提前收工。
          const node = nodeRef.current
          if (node) {
            const rect = node.getBoundingClientRect()
            const nextLeft = rect.left + dir * STROLL_STEP_PX
            const nextRight = rect.right + dir * STROLL_STEP_PX
            if (nextLeft < STROLL_EDGE_MARGIN_PX || nextRight > window.innerWidth - STROLL_EDGE_MARGIN_PX) {
              window.clearInterval(strollTimer)
              finish()
              return
            }
          }
          setOffset((o) => ({ x: o.x + dir * STROLL_STEP_PX, y: o.y }))
        }, STROLL_STEP_MS)
      }
    }
    schedule()
    return () => {
      cancelled = true
      for (const t of timers) window.clearTimeout(t)
      if (strollTimer !== undefined) window.clearInterval(strollTimer)
    }
  }, [idleActive])
  const dragRef = useRef<{
    startX: number
    startY: number
    baseX: number
    baseY: number
    rect: DOMRect
  } | null>(null)

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const node = nodeRef.current
    if (!node) return
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      baseX: offset.x,
      baseY: offset.y,
      rect: node.getBoundingClientRect(),
    }
    setDragging(true)
    // jsdom 没有 pointer capture;真实浏览器里它保证快速拖动不丢事件。
    if (typeof node.setPointerCapture === 'function') node.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    // rect 是按下瞬间的实际位置(已含当时的 offset),据此钳制增量,
    // 保证拖完后精灵完整留在视口内。
    const minDx = -drag.rect.left
    const maxDx = window.innerWidth - drag.rect.right
    const minDy = -drag.rect.top
    const maxDy = window.innerHeight - drag.rect.bottom
    const dx = Math.min(Math.max(e.clientX - drag.startX, minDx), maxDx)
    const dy = Math.min(Math.max(e.clientY - drag.startY, minDy), maxDy)
    setOffset({ x: drag.baseX + dx, y: drag.baseY + dy })
  }

  const endDrag = () => {
    if (!dragRef.current) return
    dragRef.current = null
    setDragging(false)
    savePetOffset(offsetRef.current)
  }

  // 展示优先级:被拎着 > agent 状态 > 待机小动作 > 看向鼠标(仅 V2)> idle。
  const look = usePetLook(pet.spriteVersion === 2 && state === 'idle' && !dragging && !speaking && ambient == null, nodeRef)
  const displayState: PetAnimationState = dragging
    ? 'jumping'
    : state !== 'idle'
      ? state
      : ambient === 'stroll-left'
        ? 'running-left'
        : ambient === 'stroll-right'
          ? 'running-right'
          : (ambient ?? 'idle')

  return (
    <div
      ref={nodeRef}
      data-testid="agent-pet-body"
      role="presentation"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      className="pointer-events-auto absolute -top-[104px] right-10 z-10 touch-none select-none"
      style={{
        transform: `translate(${offset.x}px, ${offset.y}px)`,
        cursor: dragging ? 'grabbing' : 'grab',
      }}
    >
      <div
        ref={mouthRef}
        data-testid="agent-pet-voice"
        data-speaking={speaking ? 'true' : undefined}
        style={{ transformOrigin: '50% 100%' }}
      >
        <PetSprite pet={pet} state={displayState} look={look} />
      </div>
    </div>
  )
}

/**
 * `/pets` 选择器(官方样式):左列表(首行「关闭宠物」+ 内置宠物 + 自装宠物),
 * 右侧动画预览。↑/↓ 移动、Enter 选择、Esc 关闭。每次打开都重扫一遍
 * `<CODEX_HOME>/pets`,用户刚丢进去的宠物不用重启就能选。
 */
function PetPicker() {
  const petId = usePetStore((s) => s.petId)
  const selectPet = usePetStore((s) => s.selectPet)
  const closePicker = usePetStore((s) => s.closePicker)
  const customPets = usePetStore((s) => s.customPets)
  const refreshCustomPets = usePetStore((s) => s.refreshCustomPets)
  const pets = allPets(customPets)

  // 行 0 = 关闭宠物;行 1..n = pets[i-1]。初始高亮当前选择。
  const initialIndex = petId ? pets.findIndex((p) => p.id === petId) + 1 : 0
  const [highlight, setHighlight] = useState(initialIndex < 0 ? 0 : initialIndex)
  const rootRef = useRef<HTMLDivElement>(null)

  const rowCount = pets.length + 1
  const commit = (index: number) => {
    selectPet(index === 0 ? null : pets[index - 1].id)
  }

  useEffect(() => {
    rootRef.current?.focus()
    void refreshCustomPets()
  }, [refreshCustomPets])

  const openPetsFolder = () => {
    void window.electronAPI?.pets?.openFolder()
  }

  // 点击选择器外部关闭(对齐 ImageChannelPicker 等邻位控件)。工具栏的
  // 宠物按钮除外——它自己负责开/关切换,这里吞掉会导致「关了又开」。
  useEffect(() => {
    function onDown(e: MouseEvent) {
      const target = e.target as HTMLElement | null
      if (rootRef.current?.contains(target as Node)) return
      if (target?.closest('[data-testid="agent-pet-picker-button"]')) return
      closePicker()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [closePicker])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((i) => (i + 1) % rowCount)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((i) => (i - 1 + rowCount) % rowCount)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      commit(highlight)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closePicker()
    }
  }

  const previewPet = highlight > 0 ? pets[highlight - 1] : undefined

  return (
    <div
      ref={rootRef}
      data-testid="agent-pet-picker"
      role="dialog"
      aria-label="选择宠物"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="pointer-events-auto absolute bottom-full right-0 z-30 mb-2 flex w-80 overflow-hidden rounded-xl border border-cyan-400/25 bg-zinc-950/95 shadow-[0_12px_32px_rgba(0,0,0,0.55)] outline-none backdrop-blur"
    >
      {/* 左:列表(官方首行 Disable pets) */}
      <div className="flex-1 py-1.5">
        <div className="px-3 pb-1 pt-0.5 text-[10px] uppercase tracking-widest text-zinc-500">
          Pets
        </div>
        <button
          type="button"
          data-testid="agent-pet-row-off"
          onMouseEnter={() => setHighlight(0)}
          onClick={() => commit(0)}
          className={`block w-full px-3 py-1.5 text-left text-[12px] ${
            highlight === 0 ? 'bg-cyan-400/10 text-cyan-300' : 'text-zinc-300'
          }`}
        >
          关闭宠物
          {petId == null ? <span className="ml-1.5 text-[10px] text-zinc-500">当前</span> : null}
        </button>
        {pets.map((p, i) => (
          <button
            key={p.id}
            type="button"
            data-testid={`agent-pet-row-${p.id}`}
            onMouseEnter={() => setHighlight(i + 1)}
            onClick={() => commit(i + 1)}
            className={`block w-full px-3 py-1.5 text-left text-[12px] ${
              highlight === i + 1 ? 'bg-cyan-400/10 text-cyan-300' : 'text-zinc-300'
            }`}
          >
            {p.displayName}
            {p.custom ? <span className="ml-1.5 text-[10px] text-zinc-500">自装</span> : null}
            {petId === p.id ? <span className="ml-1.5 text-[10px] text-zinc-500">当前</span> : null}
          </button>
        ))}
        <div className="px-3 pb-0.5 pt-1 text-[10px] text-zinc-600">↑↓ 选择 · Enter 确认 · Esc 关闭</div>
        {window.electronAPI?.pets ? (
          <button
            type="button"
            data-testid="agent-pet-open-folder"
            onClick={openPetsFolder}
            title="把 Codex 宠物包(pet.json + spritesheet.webp)放进这个文件夹"
            className="block px-3 pb-0.5 pt-0.5 text-left text-[10px] text-zinc-500 hover:text-cyan-300"
          >
            打开宠物文件夹…
          </button>
        ) : null}
      </div>

      {/* 右:动画预览(官方 preview pane) */}
      <div
        data-testid="agent-pet-preview"
        className="flex w-28 items-center justify-center border-l border-cyan-400/15 bg-zinc-900/60"
      >
        {previewPet ? (
          <PetSprite pet={previewPet} state="idle" scale={0.45} />
        ) : (
          <span className="text-[11px] text-zinc-600">无宠物</span>
        )}
      </div>
    </div>
  )
}

/**
 * 层级适配(2026-07):聊天面板 <aside> 自身是 z-[40000] + backdrop-blur 的
 * stacking context,且 DOM 顺序在 FileExplorerPanel(同 z-[40000])之前 ——
 * 宠物留在 aside 内部时,无论内部 z 多大都会被工作区展示栏浮层盖住(被
 * 祖先 stacking context 钳制)。因此本体/选择器 createPortal 到
 * document.body,fixed 容器镜像原挂载点(composer 上方)的几何位置,
 * z 取 40001 压过工作区浮层;原位置留一个零高锚点用于测量。
 * 外层保持 pointer-events-none、仅精灵与选择器 pointer-events-auto,
 * 拖拽/动画/选择器语义不变。
 */
export function PetOverlay() {
  const petId = usePetStore((s) => s.petId)
  const pickerOpen = usePetStore((s) => s.pickerOpen)
  const customPetsLoaded = usePetStore((s) => s.customPetsLoaded)
  const refreshCustomPets = usePetStore((s) => s.refreshCustomPets)
  const state = usePetState()
  const pet = useSelectedPet()

  // 上次选的是自装宠物:启动后扫一次目录才知道它的图集在哪。
  const needsCustomScan = Boolean(petId?.startsWith(CUSTOM_PET_ID_PREFIX)) && !customPetsLoaded
  useEffect(() => {
    if (needsCustomScan) void refreshCustomPets()
  }, [needsCustomScan, refreshCustomPets])

  const anchorRef = useRef<HTMLDivElement>(null)
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null)
  const active = Boolean(pet) || pickerOpen

  useEffect(() => {
    if (!active) {
      setRect(null)
      return undefined
    }
    const anchor = anchorRef.current
    if (!anchor) return undefined
    const measure = () => {
      const r = anchor.getBoundingClientRect()
      setRect((prev) =>
        prev && prev.left === r.left && prev.top === r.top && prev.width === r.width
          ? prev
          : { left: r.left, top: r.top, width: r.width },
      )
    }
    measure()
    window.addEventListener('resize', measure)
    // 锚点/footer 尺寸变化(面板拖宽、composer 长高)→ 重测。
    let ro: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure)
      ro.observe(anchor)
      if (anchor.parentElement) ro.observe(anchor.parentElement)
    }
    // 线程侧栏开合只平移面板(尺寸不变,RO 不触发),面板 right 有 200ms
    // 过渡 —— 监听 store 变化,立即 + 过渡结束后各补测一次。
    const timers = new Set<number>()
    const unsubscribe = useAgentChatStore.subscribe((s, prev) => {
      if (s.sidebarOpen === prev.sidebarOpen && s.isOpen === prev.isOpen) return
      measure()
      const t = window.setTimeout(() => {
        timers.delete(t)
        measure()
      }, 260)
      timers.add(t)
    })
    return () => {
      window.removeEventListener('resize', measure)
      ro?.disconnect()
      unsubscribe()
      for (const t of timers) window.clearTimeout(t)
    }
  }, [active])

  if (!pet && !pickerOpen) return null

  return (
    <>
      {/* 原挂载位置的零高测量锚点:portal 容器镜像它的 left/top/width */}
      <div ref={anchorRef} data-testid="agent-pet-anchor" aria-hidden className="pointer-events-none relative h-0" />
      {rect
        ? createPortal(
            <div
              data-testid="agent-pet-overlay-root"
              className="pointer-events-none fixed z-[40001]"
              style={{ left: rect.left, top: rect.top, width: rect.width }}
            >
              <div className="pointer-events-none relative flex items-end justify-end">
                {/* 宠物本体:默认蹲在 composer 右上,可抓取拖走 */}
                {pet ? <DraggablePet pet={pet} state={state} dock={rect} /> : null}

                {/* `/pets` 选择器(官方入口,无独立按钮) */}
                {pickerOpen ? <PetPicker /> : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
