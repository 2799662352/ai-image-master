// 平台人像库的纯函数层:归一、缩略图、状态、展示层过滤、上传前校验、错误分支。
//
// 这一层刻意不碰 `window.electronAPI` —— 三条硬约束里有两条(Hidden 只在展示层过滤、
// 非 Active 不过滤只灰掉)是**纯粹的形状判断**,放在这里才能对它们做单点变异测试;
// 埋进组件里就只能靠渲染树间接观察,变异后往往还能凑巧过。

import { describe, expect, it } from 'vitest'
import type { PortraitAsset } from '../../../../../types/portraitApi'
import {
  PLATFORM_UPLOAD_LIMITS,
  cardFromRegistered,
  cardStatusBadge,
  findCardByAssetId,
  isCardSelectable,
  platformAssetTypeOf,
  portraitCardsFromPlatform,
  portraitErrorHint,
  rejectUploadReason,
  thumbnailUrl,
  visibleCards,
} from '../platformPortraitCard'

const COS = 'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/portrait/a.png'

function asset(over: Partial<PortraitAsset> & { Id: string }): PortraitAsset {
  return { Status: 'Active', AssetType: 'Image', ...over }
}

describe('portraitCardsFromPlatform 归一', () => {
  it('把上游大写字段摊成卡片,引用形态是 asset://<Id>', () => {
    const [card] = portraitCardsFromPlatform([
      asset({
        Id: 'p-1',
        Name: '主角正脸',
        AssetType: 'Image',
        PreviewUrl: COS,
        URL: COS,
        CreateTime: '2026-08-01T00:00:00Z',
      }),
    ])
    expect(card).toMatchObject({
      key: 'p-1',
      assetId: 'p-1',
      name: '主角正脸',
      kind: 'image',
      assetUrl: 'asset://p-1',
      status: 'Active',
      hidden: false,
      createTime: '2026-08-01T00:00:00Z',
    })
  })

  // 上游漏字段是这个代码库反复踩过的事(portraitApi.ts:51-54),名字缺了要有东西可显示,
  // 否则网格里是一排无法区分的空标题。
  it('缺 Name 时回落到 Id,不渲染空标题', () => {
    const [card] = portraitCardsFromPlatform([asset({ Id: 'p-2' })])
    expect(card.name).toBe('p-2')
  })

  // AssetType 大小写敏感是上游的坑(portraitApi.ts:46-48),这里按小写比对,
  // 免得一段视频因为回了 'video' 而被当成图片塞进 <img>。
  it('AssetType 按小写归一 kind', () => {
    const cards = portraitCardsFromPlatform([
      asset({ Id: 'v', AssetType: 'Video' }),
      asset({ Id: 'a', AssetType: 'audio' }),
      asset({ Id: 'i', AssetType: 'Image' }),
      asset({ Id: 'x', AssetType: undefined }),
    ])
    expect(cards.map((c) => c.kind)).toEqual(['video', 'audio', 'image', 'image'])
  })

  it('终态只有 Active / Failed,其余(含 undefined)一律按处理中', () => {
    const cards = portraitCardsFromPlatform([
      asset({ Id: 'a', Status: 'Active' }),
      asset({ Id: 'f', Status: 'Failed' }),
      asset({ Id: 'p', Status: 'Processing' }),
      asset({ Id: 'u', Status: undefined }),
      asset({ Id: 'w', Status: '天知道是啥' }),
    ])
    expect(cards.map((c) => c.status)).toEqual([
      'Active',
      'Failed',
      'Processing',
      'Processing',
      'Processing',
    ])
  })

  // ── 硬约束 1 ────────────────────────────────────────────────────────────────
  //
  // 变异:把 `.filter((a) => !a.Hidden)` 挪进 portraitCardsFromPlatform。
  // 下面两条会红 —— 第二条才是这条约束真正的理由:这个数组同时用于解析画布上
  // 已有引用的 `asset://`,在源头过滤会让那些节点直接失效(portraitApi.ts:69-75)。
  it('源头不丢 Hidden 条目 —— 过滤只能在展示层做', () => {
    const cards = portraitCardsFromPlatform([
      asset({ Id: 'keep' }),
      asset({ Id: 'gone', Hidden: true }),
    ])
    expect(cards.map((c) => c.assetId)).toEqual(['keep', 'gone'])
    expect(cards[1].hidden).toBe(true)
  })

  it('已移出素材库的条目仍能按 assetId 解析 —— 画布上引用它的节点不该失效', () => {
    const cards = portraitCardsFromPlatform([asset({ Id: 'ref-1', Hidden: true, URL: COS })])
    const hit = findCardByAssetId(cards, 'ref-1')
    expect(hit?.assetUrl).toBe('asset://ref-1')
  })
})

describe('visibleCards 展示层过滤', () => {
  const cards = portraitCardsFromPlatform([
    asset({ Id: 'normal' }),
    asset({ Id: 'trashed', Hidden: true }),
    asset({ Id: 'failed', Status: 'Failed' }),
    asset({ Id: 'pending', Status: 'Processing' }),
  ])

  it('正常视图排除 Hidden', () => {
    expect(visibleCards(cards, { trash: false }).map((c) => c.assetId)).toEqual([
      'normal',
      'failed',
      'pending',
    ])
  })

  it('回收站视图只看 Hidden', () => {
    expect(visibleCards(cards, { trash: true }).map((c) => c.assetId)).toEqual(['trashed'])
  })

  // ── 硬约束 2 ────────────────────────────────────────────────────────────────
  //
  // 变异:在 visibleCards 里加 `.filter((c) => c.status === 'Active')`。
  // 这条会红。过滤掉非 Active 的后果是素材「上传完就消失了」—— 用户会重复上传,
  // 而每重复一次都真实占用配额。要的是留在网格里、灰掉、说清原因。
  it('非 Active 一律不过滤 —— 消失的素材会被用户反复重传,每次都占配额', () => {
    const ids = visibleCards(cards, { trash: false }).map((c) => c.assetId)
    expect(ids).toContain('failed')
    expect(ids).toContain('pending')
  })

  it('非 Active 改为不可交互,而不是从列表里拿走', () => {
    const byId = Object.fromEntries(cards.map((c) => [c.assetId, c]))
    expect(isCardSelectable(byId.normal!)).toBe(true)
    expect(isCardSelectable(byId.failed!)).toBe(false)
    expect(isCardSelectable(byId.pending!)).toBe(false)
  })
})

describe('cardStatusBadge', () => {
  it('Active 不打角标 —— 满屏「可用」等于没有信息', () => {
    const [c] = portraitCardsFromPlatform([asset({ Id: 'a', Status: 'Active' })])
    expect(cardStatusBadge(c)).toBeNull()
  })

  it('处理中给的是「稍等」语气', () => {
    const [c] = portraitCardsFromPlatform([asset({ Id: 'p', Status: 'Processing' })])
    expect(cardStatusBadge(c)).toMatchObject({ text: '处理中' })
    expect(cardStatusBadge(c)?.reason).toMatch(/等/)
  })

  // 失败是上游的终态判决,再等也不会变 —— 文案必须说「换一张」,说「稍等」是骗人。
  it('失败带上上游原因,且提示是「换一张」不是「稍等」', () => {
    const [c] = portraitCardsFromPlatform([
      asset({ Id: 'f', Status: 'Failed', Error: { Code: 'X', Message: '图片含敏感内容' } }),
    ])
    const badge = cardStatusBadge(c)
    expect(badge).toMatchObject({ text: '失败' })
    expect(badge?.reason).toContain('图片含敏感内容')
    expect(badge?.reason).not.toMatch(/稍等/)
  })

  it('失败但上游没给原因时也要有话说', () => {
    const [c] = portraitCardsFromPlatform([asset({ Id: 'f', Status: 'Failed' })])
    expect(cardStatusBadge(c)?.reason).toBeTruthy()
  })
})

describe('thumbnailUrl', () => {
  it('我方 COS 域名拼 imageMogr2 缩略图参数', () => {
    expect(thumbnailUrl(COS, 'image')).toBe(`${COS}?imageMogr2/thumbnail/400x`)
  })

  // 外链拼了会 404 —— 上游 TOS、CDN、用户自己的图床都不认这个参数。
  it('非 COS 域名原样返回', () => {
    const ext = 'https://cdn.example.com/a.png'
    expect(thumbnailUrl(ext, 'image')).toBe(ext)
  })

  // 签名链的 q-url-param-list 不含 imageMogr2,加上去直接 403;
  // 而带 query 的恰好就是历史遗留那批会过期的签名链。
  it('已带 query 的(签名链)不拼 —— 会破坏签名', () => {
    const signed = `${COS}?q-sign-algorithm=sha1&q-signature=abc`
    expect(thumbnailUrl(signed, 'image')).toBe(signed)
  })

  it('视频 / 音频不拼 —— 那不是图片处理接口能认的东西', () => {
    expect(thumbnailUrl(COS, 'video')).toBe(COS)
    expect(thumbnailUrl(COS, 'audio')).toBe(COS)
  })

  it('空值回 undefined,不产出 <img src="undefined">', () => {
    expect(thumbnailUrl(undefined, 'image')).toBeUndefined()
    expect(thumbnailUrl('', 'image')).toBeUndefined()
  })

  it('归一时缩略图优先 PreviewUrl,回落 URL', () => {
    const preview = `${COS}?x=1`
    const [withPreview] = portraitCardsFromPlatform([
      asset({ Id: 'a', PreviewUrl: preview, URL: COS }),
    ])
    const [onlyUrl] = portraitCardsFromPlatform([asset({ Id: 'b', URL: COS })])
    expect(withPreview.thumbUrl).toBe(preview)
    expect(onlyUrl.thumbUrl).toBe(`${COS}?imageMogr2/thumbnail/400x`)
  })
})

describe('上传前的本地闸', () => {
  const file = (type: string, size: number) => ({ name: 'f', type, size })

  it('按 MIME 前缀定 assetType(大小写敏感的首字母大写形态)', () => {
    expect(platformAssetTypeOf('video/mp4')).toBe('Video')
    expect(platformAssetTypeOf('audio/mpeg')).toBe('Audio')
    expect(platformAssetTypeOf('image/png')).toBe('Image')
  })

  // 网页版前端写的 200MB 视频是错的:50-200MB 的视频会在服务端 400,
  // 而用户是在把 200MB 传完之后才知道。
  it('限额与后端一致:图片 50MB / 视频 50MB / 音频 15MB', () => {
    expect(PLATFORM_UPLOAD_LIMITS).toEqual({
      Image: 50 * 1024 * 1024,
      Video: 50 * 1024 * 1024,
      Audio: 15 * 1024 * 1024,
    })
  })

  it('限内放行', () => {
    expect(rejectUploadReason(file('image/png', 49 * 1024 * 1024))).toBeNull()
    expect(rejectUploadReason(file('audio/mpeg', 14 * 1024 * 1024))).toBeNull()
  })

  it('超限在 arrayBuffer() 之前就拒,文案带上限', () => {
    expect(rejectUploadReason(file('video/mp4', 51 * 1024 * 1024))).toContain('50MB')
    expect(rejectUploadReason(file('audio/mpeg', 16 * 1024 * 1024))).toContain('15MB')
  })

  it('压线(恰好等于上限)放行 —— 后端判的是严格大于', () => {
    expect(rejectUploadReason(file('image/png', 50 * 1024 * 1024))).toBeNull()
  })

  it('既不是图也不是音视频的直接拒,不用把字节复制过进程边界才知道', () => {
    expect(rejectUploadReason(file('application/pdf', 1024))).toBeTruthy()
  })
})

describe('portraitErrorHint 按 code 分支', () => {
  it('ASSET_NOT_READY 让人稍等', () => {
    expect(portraitErrorHint('ASSET_NOT_READY', '原文')).toMatch(/稍等/)
  })

  // 上游的终态判决,重试一万次还是 Failed,只会一直造垃圾。
  it('ASSET_FAILED 让人换一张,绝不说稍等', () => {
    const hint = portraitErrorHint('ASSET_FAILED', '原文')
    expect(hint).toMatch(/换一张|重新导入/)
    expect(hint).not.toMatch(/稍等/)
  })

  it('NOT_AUTHENTICATED 引导登录', () => {
    expect(portraitErrorHint('NOT_AUTHENTICATED', '原文')).toMatch(/登录/)
  })

  it('INVALID_POOL 引导先选计费池', () => {
    expect(portraitErrorHint('INVALID_POOL', '原文')).toMatch(/计费池/)
  })

  it('FILE_TOO_LARGE / UNSUPPORTED_MEDIA_TYPE 引导换文件', () => {
    expect(portraitErrorHint('FILE_TOO_LARGE', '原文')).toMatch(/文件/)
    expect(portraitErrorHint('UNSUPPORTED_MEDIA_TYPE', '原文')).toMatch(/文件/)
  })

  // 漏掉一个新 code 时,原文比「什么都不说」强 —— 用户至少能把它报给客服。
  it('没认出来的 code 原样透出 message', () => {
    expect(portraitErrorHint('SOMETHING_NEW', '上游炸了')).toContain('上游炸了')
  })

  it('message 也是空的时候仍有话说,不弹空白错误框', () => {
    expect(portraitErrorHint('SOMETHING_NEW', '')).toBeTruthy()
  })
})

describe('cardFromRegistered 刚登记就有图', () => {
  // register 回的三个 URL 就是提交的那条永久 COS 链(portraitApi.ts:88-99),
  // 所以缩略图立刻可用,只缺元数据 —— 本地已知的那部分自己补上。
  it('用回包的 URL 直接出缩略图,并合并本地已知的名字/类型/时间', () => {
    const card = cardFromRegistered(
      { Id: 'new-1', URL: COS, PreviewUrl: COS, cosUrl: COS },
      { name: '刚传的.png', assetType: 'Image', createTime: '2026-08-29T00:00:00Z' },
    )
    expect(card).toMatchObject({
      assetId: 'new-1',
      assetUrl: 'asset://new-1',
      name: '刚传的.png',
      kind: 'image',
      createTime: '2026-08-29T00:00:00Z',
      hidden: false,
    })
    expect(card.thumbUrl).toBe(`${COS}?imageMogr2/thumbnail/400x`)
  })

  // register 的回包里**没有** Status(portraitApi.ts:88-93)。合成一个 'Active'
  // 会让这张卡立刻可选,而它还没就绪 —— 拿去生成会撞 ASSET_NOT_READY。
  it('状态是「处理中」而不是凭空合成的 Active', () => {
    const card = cardFromRegistered(
      { Id: 'new-2', URL: COS, PreviewUrl: COS, cosUrl: COS },
      { name: 'x', assetType: 'Image' },
    )
    expect(card.status).toBe('Processing')
    expect(isCardSelectable(card)).toBe(false)
  })
})
