// 「生成视频」工作台「分段」(board)页签条:只显示当前剧的分段,单行横向滚动;
// 切换 / 新建(+) / 双击行内重命名(Enter 确认、Esc 取消)/ 两步确认删除(避开
// window.confirm,jsdom 与桌面端一致)。上方一行面包屑「‹ 剧名 › 分段名」,‹ 回总览。
// 视觉遵循赛博朋克 token:激活段 #FCE300 描边,未激活 #3F3F46。

import { useEffect, useRef, useState } from 'react'
import { WORKBENCH_BOARD_SUMMARY_MAX } from '../../../../types/videoWorkbench'
import { useVideoWorkbenchStore } from '../../features/video-workbench/store'

export function BoardTabs() {
  const activeProjectId = useVideoWorkbenchStore((s) => s.activeProjectId)
  const projectName = useVideoWorkbenchStore(
    (s) => s.projects.find((p) => p.id === s.activeProjectId)?.name ?? '',
  )
  const openOverview = useVideoWorkbenchStore((s) => s.openOverview)
  const allBoards = useVideoWorkbenchStore((s) => s.boards)
  // 页签只认本剧:别的剧的分段在剧栏里切剧才看得到 —— 这就是「隔离」在这一屏的样子。
  const boards = allBoards.filter((b) => b.projectId === activeProjectId).sort((a, b) => a.order - b.order)
  const activeBoardId = useVideoWorkbenchStore((s) => s.activeBoardId)
  const addBoard = useVideoWorkbenchStore((s) => s.addBoard)
  const switchBoard = useVideoWorkbenchStore((s) => s.switchBoard)
  const renameBoard = useVideoWorkbenchStore((s) => s.renameBoard)
  const removeBoard = useVideoWorkbenchStore((s) => s.removeBoard)
  const setBoardSummary = useVideoWorkbenchStore((s) => s.setBoardSummary)

  /**
   * 行内编辑中的页(同一时刻最多一个)。带 field 是因为页名和摘要共用同一套
   * 「双击进入 / Enter 确认 / Esc 取消 / 失焦提交」的编辑机制 —— 分成两套状态
   * 会出现两个输入框同时开着的中间态。
   */
  const [editing, setEditing] = useState<{ id: string; field: 'name' | 'summary' } | null>(null)
  const [draft, setDraft] = useState('')
  /**
   * 右侧「全文位」是否展开。**不按页 id 记** —— 切页时收回默认单行:
   * 展开是「我现在想细看这一句」的临时意图,不是页的属性,让它跨页粘住会导致
   * 切到一个长摘要的页时栏高突然跳变。
   */
  const [summaryExpanded, setSummaryExpanded] = useState(false)
  useEffect(() => {
    setSummaryExpanded(false)
  }, [activeBoardId])

  /** 两步删除确认中的页 id;3.5s 无操作自动复位。 */
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
    }
  }, [])

  const armConfirm = (id: string) => {
    setConfirmingId(id)
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
    confirmTimer.current = setTimeout(() => setConfirmingId(null), 3500)
  }

  const beginEdit = (id: string, field: 'name' | 'summary', value: string) => {
    setEditing({ id, field })
    setDraft(value)
  }

  const commitEdit = () => {
    if (editing) {
      // 摘要允许提交空串(= 清除);页名不允许,renameBoard 自己会挡。
      if (editing.field === 'name') renameBoard(editing.id, draft)
      else setBoardSummary(editing.id, draft)
    }
    setEditing(null)
  }

  const activeBoard = boards.find((b) => b.id === activeBoardId)
  const activeSummary = activeBoard?.summary?.trim() ?? ''
  const editingActiveSummary = editing?.id === activeBoardId && editing.field === 'summary'

  return (
    <div className="flex flex-col gap-1.5 min-w-0 flex-1">
      {/* 面包屑:‹ 回总览。剧名点击也回总览 —— 分段页里「我在哪部剧」要一眼可见。 */}
      <div className="flex items-center gap-1.5 text-[11px] text-white/40">
        <button
          type="button"
          aria-label="返回总览"
          title="返回这部剧的总览"
          className="vw-crumb"
          onClick={openOverview}
        >
          ‹ {projectName}
        </button>
        <span className="vw-crumb-sep">›</span>
        <span className="vw-crumb-cur">{activeBoard?.name ?? ''}</span>
      </div>
    <div className="flex items-start gap-3 flex-wrap">
    {/* 单行横向滚动而不是换行:十几个分段折成三排就是这次改版要解决的问题。 */}
    <div role="tablist" aria-label="本剧分段" className="vw-tabs-scroll">
      {boards.map((board) => {
        const active = board.id === activeBoardId
        const editingName = editing?.id === board.id && editing.field === 'name'
        const editingSummary = editing?.id === board.id && editing.field === 'summary'
        const busy = editingName || editingSummary
        const confirming = confirmingId === board.id
        const summary = board.summary?.trim() ?? ''
        return (
          <div
            key={board.id}
            className={[
              'group flex items-center gap-1 border px-2 py-1.5 transition-colors',
              active
                ? 'border-[#FCE300] bg-[#FCE300]/10 text-[#FCE300]'
                : 'border-[#3F3F46] text-white/60 hover:border-[#FCE300]/60 hover:text-white',
            ].join(' ')}
          >
            {editingName ? (
              <input
                autoFocus
                value={draft}
                aria-label={`重命名「${board.name}」`}
                className="bg-transparent text-xs w-24 outline-none border-b border-[#FCE300] text-[#FCE300]"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitEdit()
                  if (e.key === 'Escape') setEditing(null)
                }}
                onBlur={commitEdit}
              />
            ) : (
              <button
                type="button"
                role="tab"
                aria-selected={active}
                // 摘要进 title 而不是只靠行内那段:行内是截断的,完整内容得有地方看。
                // 按钮已有可见文本作为无障碍名,title 在这里落成「描述」,语义正好。
                title={summary ? `${summary}\n\n双击页名改名，双击摘要改摘要` : '双击重命名'}
                className="text-xs max-w-[10rem] truncate"
                onClick={() => switchBoard(board.id)}
                onDoubleClick={() => beginEdit(board.id, 'name', board.name)}
              >
                {board.name}
              </button>
            )}
            {/*
              摘要行内显示,而不是塞进第二行 —— 页签栏会 flex-wrap,加一行等于把整条
              栏抬高一倍,哪怕大多数页根本没写摘要。这里横向截断得比页名更狠(7rem):
              它是扫读用的提示,不是拿来读全文的,全文在 title 里。
              没写摘要的页不占任何位置,不留空占位符。
            */}
            {/*
              当前页的摘要(看/展开/编辑/新建)整块由右侧全文位负责,页签里不再重复 ——
              同一句话印两遍是噪音;编辑时更会出现两个 autoFocus 输入框互抢焦点。
              页签这边只承担「别页写了什么」的扫读。
            */}
            {active ? null : editingSummary ? (
              <input
                autoFocus
                value={draft}
                placeholder="这一页装的是什么"
                aria-label={`「${board.name}」的摘要`}
                className="bg-transparent text-[11px] w-32 outline-none border-b border-[#FCE300]/60 text-white/80 placeholder:text-white/25"
                maxLength={WORKBENCH_BOARD_SUMMARY_MAX}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitEdit()
                  if (e.key === 'Escape') setEditing(null)
                }}
                onBlur={commitEdit}
              />
            ) : summary ? (
              <span
                // 不是 button:点它要走的是「切到这一页」,和点页名一样,不该是第二个
                // tab stop。双击才是它自己的动作。
                // 这一支只渲染**别页**(当前页在上面就 null 掉了),所以不需要按 active
                // 分宽度。保留 truncate:摘要虽已收到 60 字上限,每页都摊开仍会把整条栏
                // 撑到换行,把卡片区往下挤;全文看 title,或切过去看右侧全文位。
                className="text-[11px] max-w-[7rem] truncate text-white/40 cursor-text"
                title={`${summary}\n\n双击编辑摘要（清空即删除）`}
                onClick={() => switchBoard(board.id)}
                onDoubleClick={() => beginEdit(board.id, 'summary', summary)}
              >
                {summary}
              </span>
            ) : (
              // 没摘要的页只在悬停时露出一个极淡的入口 —— 否则用户永远发现不了
              // 这里能写东西(agent 写的摘要他也就无从修改)。
              <button
                type="button"
                aria-label={`给「${board.name}」写摘要`}
                title="写一句话说明这页装的是什么"
                className="text-[11px] px-0.5 text-white/25 hover:text-[#FCE300] opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={() => beginEdit(board.id, 'summary', '')}
              >
                ＋摘要
              </button>
            )}
            {/* 每部剧至少保留一段:本剧仅剩一段时不出删除入口(boards 已按剧过滤) */}
            {boards.length > 1 && !busy && (
              confirming ? (
                <button
                  type="button"
                  aria-label={`确认删除「${board.name}」`}
                  title="再点一次确认删除本段及其全部卡片"
                  className="text-[10px] px-1 border border-red-500 bg-red-500/20 text-red-400"
                  onClick={() => {
                    setConfirmingId(null)
                    removeBoard(board.id)
                  }}
                >
                  确认删除
                </button>
              ) : (
                <button
                  type="button"
                  aria-label={`删除页「${board.name}」`}
                  title="删除本页(需二次确认)"
                  className="text-white/30 hover:text-red-400 text-xs px-0.5"
                  onClick={() => armConfirm(board.id)}
                >
                  ✕
                </button>
              )
            )}
          </div>
        )
      })}
      <button
        type="button"
        aria-label="新建分段"
        title="在这部剧里新建一个分段"
        className="text-xs border border-dashed border-[#3F3F46] text-white/50 hover:border-[#FCE300] hover:text-[#FCE300] px-2.5 py-1.5 transition-colors"
        onClick={() => addBoard()}
      >
        ＋
      </button>
    </div>

      {/*
        当前页摘要的「全文位」。放右侧空域而不是把当前页签本身撑宽:页签一撑宽,
        切页时所有页签会左右跳一下 —— 而这里的宽度变化落在栏尾的空白上,页签原地不动。
        flex-1 + min-w-0 让它只吃剩余宽度、必要时缩到零,不会自己顶出新的一行把卡片区往下挤。
        默认单行截断,点一下展开成整段(摘要上限 200 字,展开最多两三行)。
      */}
      {activeSummary && !editingActiveSummary && (
        <button
          type="button"
          aria-expanded={summaryExpanded}
          aria-label={`当前页摘要：${activeSummary}`}
          // 当前页的摘要不在页签里了,编辑入口也跟着搬到这儿 —— 手势与页签一致:
          // 单击是「看」(展开/收起),双击是「改」。
          title={`${summaryExpanded ? '点击收起' : '点击展开全文'}，双击编辑`}
          className={[
            'flex-1 min-w-0 basis-40 text-left text-[11px] leading-relaxed text-white/45',
            'hover:text-white/70 transition-colors py-1.5',
            summaryExpanded ? 'whitespace-normal' : 'truncate',
          ].join(' ')}
          onClick={() => setSummaryExpanded((v) => !v)}
          onDoubleClick={() => beginEdit(activeBoardId, 'summary', activeSummary)}
        >
          {activeSummary}
        </button>
      )}
      {/* 当前页还没写摘要:入口也得在这一区,不然它在页签里被摘掉后就彻底没入口了。 */}
      {!activeSummary && !editingActiveSummary && (
        <button
          type="button"
          aria-label="给当前页写摘要"
          title="写一句话说明这页装的是什么"
          className="text-[11px] py-1.5 text-white/25 hover:text-[#FCE300] transition-colors"
          onClick={() => beginEdit(activeBoardId, 'summary', '')}
        >
          ＋摘要
        </button>
      )}
      {/* 编辑当前页摘要时输入框也留在原位,避免焦点从右侧跳回页签里。 */}
      {editingActiveSummary && (
        <input
          autoFocus
          value={draft}
          placeholder="这一页装的是什么"
          aria-label="当前页摘要"
          maxLength={WORKBENCH_BOARD_SUMMARY_MAX}
          className="flex-1 min-w-0 basis-40 bg-transparent text-[11px] py-1.5 outline-none border-b border-[#FCE300]/60 text-white/80 placeholder:text-white/25"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitEdit()
            if (e.key === 'Escape') setEditing(null)
          }}
          onBlur={commitEdit}
        />
      )}
    </div>
    </div>
  )
}
