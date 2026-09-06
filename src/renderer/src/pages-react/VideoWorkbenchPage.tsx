// 「生成视频」工作台页 —— 卷轴式并发视频任务工作台。
//
// 布局移植自 soraui 旧版工作台(/workspace SimpleMode)的垂直卷轴结构:
// 顶部工具条(全部生成 / 进行中计数)→ 从上到下排布的任务卡片流 →
// 底部大号虚线「+ 添加卡片」。配色为本应用赛博朋克体系(zinc + #FCE300)。
//
// 人机协同:本页与 MCP video_workbench_* 工具操作同一个 useVideoWorkbenchStore,
// agent 填卡/启动时页面实时可见;生成进度经 seedance:task-update 广播回流。

import { useEffect, useRef, useState } from 'react'
import {
  cardHasVideoInput,
  mountWorkbenchTaskListener,
  useVideoWorkbenchStore,
} from '../features/video-workbench/store'
import { formatCostParts, summarizeCostUsd } from '../features/video-workbench/pricing'
import type { VideoWorkbenchCard } from '../../../types/videoWorkbench'
import { BoardTabs } from './video-workbench/BoardTabs'
import { CardGap } from './video-workbench/CardGap'
import { ProjectOverview } from './video-workbench/ProjectOverview'
import { ProjectRail } from './video-workbench/ProjectRail'
import { ProjectSearchPalette } from './video-workbench/ProjectSearchPalette'
import { RegionSwitch } from './video-workbench/RegionSwitch'
import { UndoRedoButtons } from './video-workbench/UndoRedoButtons'
import { WorkbenchCard } from './video-workbench/WorkbenchCard'
import './video-workbench/workbench.css'

/**
 * 「值得现在点生成」的卡。比 store 的 `canStart` 严:那道门允许重生已完成的卡
 * (重生是显式意图),而按钮上的计数要排除 succeeded —— 否则一页出完片后按钮
 * 还显示一堆待生成,点下去等于重烧一遍额度。
 *
 * 提成函数是为了让整页计数与选中项计数共用同一份判定:两份拷贝在加卡片状态时
 * 必然漂移。
 */
function isWorthStarting(card: VideoWorkbenchCard): boolean {
  if (!card.prompt.trim()) return false
  return (
    card.status !== 'preparing'
    && card.status !== 'queued'
    && card.status !== 'running'
    && card.status !== 'succeeded'
  )
}

export default function VideoWorkbenchPage() {
  // 卡片汇报的拖拽态。以前这里传的是 noop —— 卡片说了页面不听;缝隙「＋」要在拖拽时
  // 隐身避让插入指示线,正好把这根预埋管线接上。
  const [dragging, setDragging] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const allCards = useVideoWorkbenchStore((s) => s.cards)
  const activeBoardId = useVideoWorkbenchStore((s) => s.activeBoardId)
  const activeProjectId = useVideoWorkbenchStore((s) => s.activeProjectId)
  const boards = useVideoWorkbenchStore((s) => s.boards)
  // 每部剧记住自己停在总览还是哪个分段;缺省(老数据首启)落在分段页,行为与升级前一致。
  const viewMode = useVideoWorkbenchStore((s) => s.viewByProject[s.activeProjectId]?.mode ?? 'board')
  const hydrated = useVideoWorkbenchStore((s) => s.hydrated)
  const ensureHydrated = useVideoWorkbenchStore((s) => s.ensureHydrated)
  const addCards = useVideoWorkbenchStore((s) => s.addCards)
  const startCards = useVideoWorkbenchStore((s) => s.startCards)
  const autoImportPortrait = useVideoWorkbenchStore((s) => s.autoImportPortrait)
  const setAutoImportPortrait = useVideoWorkbenchStore((s) => s.setAutoImportPortrait)
  const selectedCardIds = useVideoWorkbenchStore((s) => s.selectedCardIds)
  const clearSelection = useVideoWorkbenchStore((s) => s.clearSelection)
  const removeCards = useVideoWorkbenchStore((s) => s.removeCards)
  const agentAutoStart = useVideoWorkbenchStore((s) => s.agentAutoStart)
  const setAgentAutoStart = useVideoWorkbenchStore((s) => s.setAgentAutoStart)

  // 批量生成的两步确认。一次误点烧的是整批额度,而这颗按钮的邻居是「添加卡片」
  // 和「删除选中」—— 挨得近、后果不对称,所以要一道确认。3.5s 无操作自动复位,
  // 与 BoardTabs 的删除确认同一套做法(不用 window.confirm:jsdom 里被禁用)。
  const [confirmingStart, setConfirmingStart] = useState(false)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
    }
  }, [])
  const disarmConfirm = (): void => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
    setConfirmingStart(false)
  }

  // 这份挂载是给「不经 AppLayout」的宿主用的(react-app/main.tsx 把本页单独
  // 渲进自己的 root)。在 AppLayout 宿主里 App 级已经挂了一份常驻,引用计数
  // 保证本页被 Activity 隐藏时不会把订阅带走。
  //
  // 重启对账同理:老 vanilla shell 这条路没有 AppLayout,不在这儿发起就没人发起,
  // 上次退出时在飞的任务永远等不到接管。两个宿主都调是安全的 —— 主进程 adopt()
  // 对已跟踪的 taskId 直接返回 tracked,不会起第二个轮询循环。
  // 顺序要紧:先把监听挂上再对账,否则接管后立刻到达的广播没人接。
  useEffect(() => {
    const release = mountWorkbenchTaskListener()
    void ensureHydrated().then(() => useVideoWorkbenchStore.getState().reconcileInFlight())
    return release
  }, [ensureHydrated])

  // Esc 取消选中 —— 选错了要有一条不用瞄准的退路。
  //
  // 两个让路:①输入框/富文本里按 Esc 是编辑动作(取消输入法候选、退出编辑),
  // 不能被劫走;②已经被别人处理掉的(弹层关闭会 preventDefault)不再插手。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return
      // Ctrl/Cmd+P:搜索剧与分段。在输入框里也接管 —— 浏览器默认的「打印」在桌面端毫无意义。
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') {
        event.preventDefault()
        setPaletteOpen(true)
        return
      }
      if (event.key !== 'Escape') return
      // 事件可能直接派发在 window 上(它没有 closest),先收窄再问
      const target = event.target
      if (target instanceof HTMLElement && target.closest('input, textarea, [contenteditable="true"]')) return
      if (useVideoWorkbenchStore.getState().selectedCardIds.length === 0) return
      clearSelection()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [clearSelection])

  // 只展示当前页的卡片;其他页卡片仍在 store 里(任务回流跨页可达)。
  const cards = allCards
    .filter((c) => c.boardId === activeBoardId)
    .sort((a, b) => a.order - b.order)

  const activeCount = cards.filter(
    (c) => c.status === 'preparing' || c.status === 'queued' || c.status === 'running',
  ).length
  const startableCount = cards.filter(isWorthStarting).length
  // 有选中时按选中项算 —— 选中可能跨页(先选后切页),当前页的 startableCount 不作数。
  const selectedStartableCount = selectedCardIds.filter((id) =>
    allCards.some((c) => c.id === id && isWorthStarting(c)),
  ).length
  const batchDisabled = selectedCardIds.length > 0 ? selectedStartableCount === 0 : startableCount === 0
  // 确认文案里的张数用的是「真会被启动的数量」,不是选中数 —— 用户凭这个数字
  // 判断自己有没有点错,报大了就是骗人。
  const batchStartCount = selectedCardIds.length > 0 ? selectedStartableCount : startableCount

  // 确认态期间待启动集合变了(agent 又填了卡、用户改了选中、某张卡跑完了)就撤销
  // 确认。否则按钮上写着「确认生成 2 张」,点下去启动的却是 7 张 —— 这颗按钮存在
  // 的全部意义就是那个数字,它一旦过期,确认比不确认更坏。
  useEffect(() => {
    disarmConfirm()
    // disarmConfirm 只碰 ref 与 setState,不需要进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchStartCount])

  // 已花费(事后口径,算不了预算 —— 详见 pricing.summarizeCostUsd)。
  // cardHasVideoInput 与单卡显示 / 提交拆分同源,但不为布尔分配三个数组。
  // 「合计」只算当前剧:别的剧的花费在剧栏各自的行里,不混进这一屏。
  const boardCost = summarizeCostUsd(cards, cardHasVideoInput)
  const projectBoardIds = new Set(boards.filter((b) => b.projectId === activeProjectId).map((b) => b.id))
  const totalCost = summarizeCostUsd(
    allCards.filter((c) => c.boardId && projectBoardIds.has(c.boardId)),
    cardHasVideoInput,
  )

  return (
    <div className="bg-[#09090B] border border-[#3F3F46] relative overflow-hidden min-h-[70vh]">
      {/* 装饰性背景数字(与其他面板一致的 Kinetic Typography) */}
      <div className="text-massive absolute -right-8 -top-8 opacity-[0.03] select-none pointer-events-none z-0" aria-hidden="true">
        07
      </div>

      <ProjectSearchPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />

      {/* 两栏:左侧剧栏常驻,右侧是当前剧的内容区 */}
      <div className="relative z-10 flex min-h-[70vh]">
        <ProjectRail />
        <div className="flex-1 min-w-0 p-4 md:p-6 space-y-4">
        {viewMode === 'overview' ? (
          <ProjectOverview />
        ) : (
        <>
        {/*
          顶部两行:第一行标题 + 统计 + 工具条,第二行面包屑 + 分段页签通栏。
          页签必须独占一行:若与右侧那一排工具按钮同行,只能吃剩余宽度,窄窗口下
          会被压成一根竖条叠到标题上。
        */}
        <div className="border-b-2 border-[#3F3F46] pb-3 space-y-2">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="text-white font-bold tracking-wider text-lg">
            <span className="text-[#FCE300]">▶</span> 生成视频工作台
          </h2>
          <span className="text-white/40 text-xs">
            本段 {cards.length} 镜{activeCount > 0 ? ` · ${activeCount} 个生成中` : ''}
          </span>
          {/* 已花费:只在真有可估算的卡时才出现,不给空看板挂一个 $0.000。
              带 ≈ 是因为它是按 completion_tokens × 官方价目估的,不是账单。 */}
          {(boardCost.counted > 0 || boardCost.unpriced > 0) && (
            <span
              className="text-white/40 text-xs"
              title={[
                `本段 ${boardCost.counted} 张已计入`,
                boardCost.unpriced > 0
                  ? `${boardCost.unpriced} 张已出片但估不出价(上游未回传 token 或价目表无此组合)——所以这是下限`
                  : null,
                totalCost.counted !== boardCost.counted || totalCost.unpriced !== boardCost.unpriced
                  ? `全剧合计 ≈ ${formatCostParts(totalCost.usd, totalCost.cny) ?? '—'}${totalCost.unpriced > 0 ? `(另有 ${totalCost.unpriced} 张估不出)` : ''}`
                  : null,
                // 两种货币并列而不相加:换算要写死汇率,那等于把今天的汇率冻进代码。
                boardCost.cny > 0 && boardCost.usd > 0
                  ? '按 token 计费(¥)与按秒计费(¥)口径不同,分开显示、不做汇率换算'
                  : null,
                '按 usage.completion_tokens / 出片秒数 × 官方价目估算,非实际账单',
              ].filter(Boolean).join('\n')}
            >
              · 已花费 ≈ {formatCostParts(boardCost.usd, boardCost.cny) ?? '—'}
              {boardCost.unpriced > 0 ? `＋${boardCost.unpriced} 张未计入` : ''}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {/* 撤销/重做:一步 = 一次编排改动,agent 的整板 applyIR 也算一步 */}
            <UndoRedoButtons />
            {/* 海外/国内站点切换:与设置页共享同一份 region 配置,提交按此路由 */}
            <RegionSwitch />
            {/* 人像库入库总闸:只管生成时把参考图登记进人像库(上传不再顺带) */}
            <button
              type="button"
              aria-pressed={autoImportPortrait}
              title={
                '人像库入库总闸(默认开)。开启:生成时用到的参考图会后台登记进人像库'
                + '(不影响卡片与生成)。关闭:生成也不传,人像库只收你在人像库页手动上传的。'
              }
              className={[
                'text-xs px-3 py-2 border transition-colors',
                autoImportPortrait
                  ? 'border-[#FCE300] bg-[#FCE300]/15 text-[#FCE300]'
                  : 'border-[#3F3F46] text-white/70 hover:border-[#FCE300] hover:text-[#FCE300]',
              ].join(' ')}
              onClick={() => setAutoImportPortrait(!autoImportPortrait)}
            >
              {autoImportPortrait ? '◉' : '○'} 默认上传人像库
            </button>
            {/* AI 自动生成总闸:关掉后 agent 只能填卡,最后那一下留给用户 */}
            <button
              type="button"
              aria-pressed={agentAutoStart}
              title={
                '允许 AI 自动生成(默认开)。开启:AI 可以自己按下生成。'
                + '关闭:AI 照样能填卡片、改规格、排版,但不会替你点生成 —— '
                + '它会把卡片准备好然后请你自己按「全部生成」。'
              }
              className={[
                'text-xs px-3 py-2 border transition-colors',
                agentAutoStart
                  ? 'border-[#FCE300] bg-[#FCE300]/15 text-[#FCE300]'
                  : 'border-[#3F3F46] text-white/70 hover:border-[#FCE300] hover:text-[#FCE300]',
              ].join(' ')}
              onClick={() => setAgentAutoStart(!agentAutoStart)}
            >
              {agentAutoStart ? '◉' : '○'} 允许 AI 自动生成
            </button>
            {confirmingStart ? (
              <button
                type="button"
                className="text-xs border border-[#FCE300] bg-[#FCE300]/20 text-[#FCE300] font-bold px-3 py-2 transition-colors"
                onClick={() => {
                  disarmConfirm()
                  void startCards()
                }}
              >
                ⚡ 确认生成 {batchStartCount} 张
              </button>
            ) : (
              <button
                type="button"
                title="批量生成需二次确认"
                className="text-xs border border-[#3F3F46] text-white/70 hover:border-[#FCE300] hover:text-[#FCE300] px-3 py-2 transition-colors disabled:opacity-40"
                disabled={batchDisabled}
                onClick={() => {
                  setConfirmingStart(true)
                  if (confirmTimer.current) clearTimeout(confirmTimer.current)
                  confirmTimer.current = setTimeout(() => setConfirmingStart(false), 3500)
                }}
              >
                {/* 文案必须随选中态变 —— 否则用户会以为点的是「全部生成」而烧掉一批额度 */}
                {selectedCardIds.length > 0
                  ? `⚡ 生成选中 ${selectedCardIds.length} 张`
                  : `⚡ 全部生成${startableCount > 0 ? `(${startableCount})` : ''}`}
              </button>
            )}
            {selectedCardIds.length > 0 && (
              <>
                <button
                  type="button"
                  className="text-xs border border-[#3F3F46] text-white/70 hover:border-red-500 hover:text-red-400 px-3 py-2 transition-colors"
                  onClick={() => removeCards(selectedCardIds)}
                >
                  🗑 删除选中 {selectedCardIds.length} 张
                </button>
                {/* 取消选中原本是条低对比度的裸文字,在这排实心按钮里几乎看不见。
                    它是「我选错了」的唯一退路,得和它的邻居一样醒目、一样好点。 */}
                <button
                  type="button"
                  title="取消选中(Esc)"
                  className="text-xs border border-[#3F3F46] text-white/70 hover:border-[#FCE300] hover:text-[#FCE300] px-3 py-2 transition-colors"
                  onClick={clearSelection}
                >
                  取消选中
                </button>
              </>
            )}
            <button
              type="button"
              className="text-xs bg-[#FCE300] text-black font-bold px-3 py-2 hover:opacity-85 active:scale-95 transition-all"
              onClick={() => addCards([{}])}
            >
              ＋ 添加卡片
            </button>
          </div>
        </div>
        <BoardTabs />
        </div>

        {/* 卷轴卡片流 */}
        {!hydrated ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-8 h-8 border-2 border-[#FCE300] border-t-transparent rounded-full animate-spin" />
          </div>
        ) : cards.length === 0 ? (
          <button
            type="button"
            className="w-full border-2 border-dashed border-[#3F3F46] hover:border-[#FCE300] text-white/40 hover:text-[#FCE300] py-16 transition-colors"
            onClick={() => addCards([{}])}
          >
            <span className="block text-3xl mb-2">＋</span>
            <span className="text-sm">新建第一张视频任务卡</span>
            <span className="block text-xs text-white/25 mt-2">
              每张卡片可独立设置提示词 / 规格 / 参考素材,多张卡片可并发生成;也可以在聊天里让 AI 帮你批量填卡
            </span>
          </button>
        ) : (
          <div className="space-y-4 pt-4">
            {cards.map((card, index) => (
              <div key={card.id} className="relative">
                {/* 缝隙「＋」绝对定位进 space-y-4 的间距里,不占高度,行距不变。
                    容器的 pt-4 是给第一张卡上方那道缝留落点 —— space-y-4 不给首个
                    子元素外边距,没有它就插不到最前面。 */}
                <CardGap beforeCardId={card.id} hidden={dragging} />
                <WorkbenchCard
                  card={card}
                  index={index}
                  onDragStateChange={setDragging}
                />
              </div>
            ))}
            {/* 底部追加按钮(卷轴尾部的「+」) */}
            <button
              type="button"
              className="w-full border-2 border-dashed border-[#3F3F46] hover:border-[#FCE300] text-white/30 hover:text-[#FCE300] py-6 transition-colors"
              onClick={() => addCards([{}])}
            >
              ＋ 追加任务卡片
            </button>
          </div>
        )}
        </>
        )}
        </div>
      </div>
    </div>
  )
}
