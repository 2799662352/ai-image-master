// 「生成视频」工作台页 —— 卷轴式并发视频任务工作台。
//
// 布局移植自 soraui 旧版工作台(/workspace SimpleMode)的垂直卷轴结构:
// 顶部工具条(全部生成 / 进行中计数)→ 从上到下排布的任务卡片流 →
// 底部大号虚线「+ 添加卡片」。配色为本应用赛博朋克体系(zinc + #FCE300)。
//
// 人机协同:本页与 MCP video_workbench_* 工具操作同一个 useVideoWorkbenchStore,
// agent 填卡/启动时页面实时可见;生成进度经 seedance:task-update 广播回流。

import { useEffect } from 'react'
import {
  mountWorkbenchTaskListener,
  useVideoWorkbenchStore,
} from '../features/video-workbench/store'
import { BoardTabs } from './video-workbench/BoardTabs'
import { RegionSwitch } from './video-workbench/RegionSwitch'
import { WorkbenchCard } from './video-workbench/WorkbenchCard'
import './video-workbench/workbench.css'

/** 卡片排序拖拽的全局态暂未消费(视觉反馈在卡片内部),稳定 noop 防止子组件重渲。 */
const NOOP_DRAG_STATE = () => {}

export default function VideoWorkbenchPage() {
  const allCards = useVideoWorkbenchStore((s) => s.cards)
  const activeBoardId = useVideoWorkbenchStore((s) => s.activeBoardId)
  const hydrated = useVideoWorkbenchStore((s) => s.hydrated)
  const ensureHydrated = useVideoWorkbenchStore((s) => s.ensureHydrated)
  const addCards = useVideoWorkbenchStore((s) => s.addCards)
  const startCards = useVideoWorkbenchStore((s) => s.startCards)
  const autoImportPortrait = useVideoWorkbenchStore((s) => s.autoImportPortrait)
  const setAutoImportPortrait = useVideoWorkbenchStore((s) => s.setAutoImportPortrait)

  useEffect(() => {
    void ensureHydrated()
    return mountWorkbenchTaskListener()
  }, [ensureHydrated])

  // 只展示当前页的卡片;其他页卡片仍在 store 里(任务回流跨页可达)。
  const cards = allCards
    .filter((c) => c.boardId === activeBoardId)
    .sort((a, b) => a.order - b.order)

  const activeCount = cards.filter(
    (c) => c.status === 'preparing' || c.status === 'queued' || c.status === 'running',
  ).length
  const startableCount = cards.filter(
    (c) => c.prompt.trim() && c.status !== 'preparing' && c.status !== 'queued' && c.status !== 'running' && c.status !== 'succeeded',
  ).length

  return (
    <div className="bg-[#09090B] border border-[#3F3F46] p-4 md:p-6 relative overflow-hidden min-h-[70vh]">
      {/* 装饰性背景数字(与其他面板一致的 Kinetic Typography) */}
      <div className="text-massive absolute -right-8 -top-8 opacity-[0.03] select-none pointer-events-none z-0" aria-hidden="true">
        07
      </div>

      <div className="relative z-10 max-w-4xl mx-auto space-y-4">
        {/* 顶部工具条(页签紧跟标题:每页一套独立卡片集合) */}
        <div className="flex items-center gap-3 border-b-2 border-[#3F3F46] pb-3 flex-wrap">
          <h2 className="text-white font-bold tracking-wider text-lg">
            <span className="text-[#FCE300]">▶</span> 生成视频工作台
          </h2>
          <BoardTabs />
          <span className="text-white/40 text-xs">
            {cards.length} 张卡片{activeCount > 0 ? ` · ${activeCount} 个生成中` : ''}
          </span>
          <div className="ml-auto flex items-center gap-2">
            {/* 海外/国内站点切换:与设置页共享同一份 region 配置,提交按此路由 */}
            <RegionSwitch />
            {/* 全局开关:本地上传素材加入卡片的同时顺带导入人像库(失败只 toast) */}
            <button
              type="button"
              aria-pressed={autoImportPortrait}
              title="开启后,任何卡片上本地上传的素材会自动同步导入人像库(导入失败不影响卡片)"
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
            <button
              type="button"
              className="text-xs border border-[#3F3F46] text-white/70 hover:border-[#FCE300] hover:text-[#FCE300] px-3 py-2 transition-colors disabled:opacity-40"
              disabled={startableCount === 0}
              onClick={() => void startCards()}
            >
              ⚡ 全部生成{startableCount > 0 ? `(${startableCount})` : ''}
            </button>
            <button
              type="button"
              className="text-xs bg-[#FCE300] text-black font-bold px-3 py-2 hover:opacity-85 active:scale-95 transition-all"
              onClick={() => addCards([{}])}
            >
              ＋ 添加卡片
            </button>
          </div>
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
          <div className="space-y-4">
            {cards.map((card, index) => (
              <WorkbenchCard
                key={card.id}
                card={card}
                index={index}
                onDragStateChange={NOOP_DRAG_STATE}
              />
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
      </div>
    </div>
  )
}
