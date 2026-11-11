// 人像库在渲染端的两样共享件:素材项形状、「自填 Key 没有人像库」的提示文案。
//
// 素材项原来借用主进程 vvdance 素材接口的类型(`SeedanceAssetItem`,随 vvdance 直连一起
// 删除)。平台人像库的卡片(`PortraitCard`)与它**刻意保持形状独立**(见
// `platformPortraitCard.ts`),这里只是「递给视频工作台时」的最小形状:选择器确认回填、
// 卡片入素材、`@` 建议三处共用。

/** 递给视频工作台的素材项。 */
export interface PortraitAssetItem {
  id: string
  /** `image` / `video` / `audio`。刻意放宽成 string:调用方都是 `String(kind) === 'video'` 式判断。 */
  kind: string
  name: string
  /** 缩略图地址(仅展示用)。 */
  previewUrl?: string
  /** 原图 / 原片地址。 */
  sourceUrl?: string
  /** 引用形态,创建任务时直接作为素材 url(平台人像库为 `asset://<Id>`)。 */
  assetUrl: string
  assetId: string
}

/**
 * 自填 Miau Key 模式下的提示。
 *
 * 人像库只存在于平台余额这一侧(按计费池分组、服务端存储);自填 Key 只是把请求带着你的 Key
 * 发给网关,没有地方放库。人像库页与视频工作台的选择器共用这句,避免两处措辞漂移。
 */
export const OWN_KEY_NO_PORTRAIT_LIBRARY_HINT =
  '自填 Miau Key 模式下没有人像库。登录账号并在「设置 → 账号」启用平台余额后即可使用人像库。'
