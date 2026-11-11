// 人像库页面 —— 浏览 / 搜索 / 上传 / 选择素材,复制 asset:// 引用或一键发送到
// Agent 对话,用于人物一致性的视频生成。
//
// **人像库只存在于平台余额这一侧**(`billingSource === 'platform'`):
//   → `window.electronAPI.portraitLibrary.*`,主进程持平台 JWT,素材按计费池分组;
//     有服务端的软删/回收站/彻底删除与配额。见 `PlatformPortraitLibrary`。
//
// 自填 Miau Key(`'own-key'`)模式下没有人像库 —— 以前这里还有一条走 vvdance 素材接口
// (HMAC 签名)的老路,随 vvdance 直连一起删除了。这一侧只显示一张提示卡片,
// 指引用户登录并启用平台余额。
//
// 分叉只有本文件末尾那一处,理由写在 `PlatformPortraitLibrary.tsx` 顶部。

import { useTabStore } from '../stores'
import { useQuotaStore } from '../stores/useQuotaStore'
import { PlatformPortraitLibrary } from '../features/portrait-library/PlatformPortraitLibrary'
import { OWN_KEY_NO_PORTRAIT_LIBRARY_HINT } from '../features/portrait-library/portraitLibraryShared'

/** 自填 Miau Key 模式的提示卡片:说明没有人像库,并给一个去设置页的入口。 */
function OwnKeyPortraitNotice() {
  const switchTab = useTabStore((s) => s.switchTab)

  // 经典壳（index.html）里设置是模态框（SiteManager），React 壳里是 settings tab。
  const openSettings = () => {
    const siteManager = (window as unknown as { siteManagerTS?: { openSettingsModal?: () => void } }).siteManagerTS
    if (siteManager?.openSettingsModal) siteManager.openSettingsModal()
    else switchTab('settings')
  }

  return (
    <div
      data-testid="portrait-library-own-key-notice"
      className="flex flex-col items-center justify-center h-full gap-4 text-center px-6"
    >
      <div className="text-5xl">👤</div>
      <h2 className="text-xl font-bold text-white">人像库需要平台余额</h2>
      <p className="text-sm text-zinc-400 max-w-md">{OWN_KEY_NO_PORTRAIT_LIBRARY_HINT}</p>
      <button
        onClick={openSettings}
        className="px-4 py-2 bg-cyberpunk-yellow text-cyberpunk-black font-bold text-sm uppercase rounded hover:opacity-90"
      >
        前往设置
      </button>
    </div>
  )
}

/**
 * 按计费来源选页面主体。
 *
 * `billingSource` 刻意不持久化,每次启动都回到 `'own-key'`(见 `useQuotaStore`),
 * 所以这里也不需要任何「还没决定」的中间态。
 */
export default function PortraitLibraryPage() {
  const billingSource = useQuotaStore((s) => s.billingSource)
  return billingSource === 'platform' ? <PlatformPortraitLibrary /> : <OwnKeyPortraitNotice />
}
