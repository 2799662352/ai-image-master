import { describe, expect, it } from 'vitest'

import {
  SEEDANCE_MODEL_CAPABILITIES,
  capabilitiesFor,
  validateSeedanceRequest,
  type VideoModelAlias,
} from '../../../../types/seedance'

/**
 * 能力表是「9/3/3」「4-15」这类硬编码的唯一去处 —— 它们此前散在 videoTools /
 * videoWorkbenchTools / modes / cardSpec 至少五处,加一个模型就要改五处。
 *
 * 数字全部出自 vvdance 开发文档(版本 2026-08-08)第 2.2.1 / 2.3 / 4.9 节。
 */
describe('SEEDANCE_MODEL_CAPABILITIES', () => {
  it('2.5 放宽到 30 秒、30/10/10 素材,并支持 edit/extend', () => {
    const caps = capabilitiesFor('2.5')
    expect(caps.duration).toEqual({ min: 4, max: 30 })
    expect(caps.maxImages).toBe(30)
    expect(caps.maxVideos).toBe(10)
    expect(caps.maxAudios).toBe(10)
    expect(caps.maxMaterialsTotal).toBe(50)
    expect(caps.taskModes).toEqual(['edit', 'extend'])
    expect(caps.audioOnlyReference).toBe(true)
  })

  it('2.5 不支持 4k —— 只有 2.0 标准档支持(文档 2.2.1)', () => {
    expect(capabilitiesFor('2.5').resolutions).toEqual(['480p', '720p'])
    expect(capabilitiesFor('2.0').resolutions).toContain('4k')
    expect(capabilitiesFor('2.0-fast').resolutions).not.toContain('4k')
    expect(capabilitiesFor('2.0-mini').resolutions).not.toContain('4k')
  })

  it('1080p 也只有 2.0 —— 收编 videoTools 原有的实战规则，不因建表而放宽', () => {
    expect(capabilitiesFor('2.0').resolutions).toContain('1080p')
    for (const alias of ['2.0-fast', '2.0-mini', '2.5'] as const) {
      expect(capabilitiesFor(alias).resolutions).not.toContain('1080p')
    }
  })

  it('擦除字幕只有 2.0 与 2.0-fast 支持(文档 2.4)', () => {
    expect(capabilitiesFor('2.0').subtitleErase).toBe(true)
    expect(capabilitiesFor('2.0-fast').subtitleErase).toBe(true)
    expect(capabilitiesFor('2.0-mini').subtitleErase).toBe(false)
    expect(capabilitiesFor('2.5').subtitleErase).toBe(false)
  })

  it('2.0 家族维持 4-15 与 9/3/3,不被 2.5 带偏', () => {
    for (const alias of ['2.0', '2.0-fast', '2.0-mini'] as const) {
      const caps = capabilitiesFor(alias)
      expect(caps.duration).toEqual({ min: 4, max: 15 })
      expect([caps.maxImages, caps.maxVideos, caps.maxAudios]).toEqual([9, 3, 3])
      expect(caps.taskModes).toEqual([])
    }
  })

  it('每个别名都在表里(新增模型时漏填会在这里红)', () => {
    expect(Object.keys(SEEDANCE_MODEL_CAPABILITIES).sort()).toEqual([
      '2.0',
      '2.0-fast',
      '2.0-mini',
      '2.5',
      'depth',
      'kling4',
      'kling4-omni',
      'wan3',
      'wan3-prime',
    ])
  })

  it('画幅按模型分:万相有 adaptive 没有 21:9,Seedance 反过来', () => {
    // 这两个数字曾经写死在 WorkbenchCard 的一个数组里,于是万相卡片上摆着一个
    // 提交必被拒的 21:9,却没有它官方的默认值 adaptive。
    const wan3 = capabilitiesFor('wan3').ratios
    expect(wan3).toContain('adaptive')
    expect(wan3).not.toContain('21:9')

    const seedance = capabilitiesFor('2.0').ratios
    expect(seedance).toContain('21:9')
    expect(seedance).not.toContain('adaptive')
  })

  it('seed 上限按模型分 —— 万相只到 2147483647', () => {
    // 官方写明 [0, 2147483647],比 Seedance 的 uint32 小一半。差这一位的后果是
    // 界面收下了用户填的大数,上游拒了。
    expect(capabilitiesFor('wan3').seedMax).toBe(2_147_483_647)
    expect(capabilitiesFor('2.0').seedMax).toBe(4_294_967_295)
  })

  it('每个模型都声明了 provider 与可用模式', () => {
    for (const alias of Object.keys(SEEDANCE_MODEL_CAPABILITIES) as VideoModelAlias[]) {
      const caps = capabilitiesFor(alias)
      expect(['vvdance', 'miau']).toContain(caps.provider)
      // 「源视频变换」型(深度捕捉)不是生成模型,没有工作台模式 —— 见下面它自己的 describe。
      if (caps.sourceVideoTransform) {
        expect(caps.modes).toEqual([])
        continue
      }
      expect(caps.modes.length).toBeGreaterThan(0)
      // 文生视频是所有模型的最低保证,没有它这张卡什么都提交不了。
      expect(caps.modes).toContain('text2video')
    }
  })

  it('只有深度捕捉是「源视频变换」型,其余全是生成模型', () => {
    for (const alias of Object.keys(SEEDANCE_MODEL_CAPABILITIES) as VideoModelAlias[]) {
      expect(capabilitiesFor(alias).sourceVideoTransform).toBe(alias === 'depth')
    }
  })

  // 回归:第一版把 UI 模式 `edit_video/extend_video` 与上游参数 `taskModes` 当成
  // 了一回事,于是把 2.0 家族的这两个模式砍掉了。实际上它们 Seedance 全家都有 ——
  // 2.5 之前只是素材组合预设(edit 带图+视频+音频、extend 只带视频),发出去是一次
  // 普通生成,`taskModeForCard` 不会为它们派生 taskMode。
  it('Seedance 全家都有编辑/延长视频模式,taskMode 才是 2.5 独有', () => {
    for (const alias of ['2.0', '2.0-fast', '2.0-mini', '2.5'] as const) {
      const caps = capabilitiesFor(alias)
      expect(caps.modes).toContain('edit_video')
      expect(caps.modes).toContain('extend_video')
    }
    expect(capabilitiesFor('2.0').taskModes).toEqual([])
    expect(capabilitiesFor('2.5').taskModes).toEqual(['edit', 'extend'])
  })

  it('被模式白名单收窄的是万相 3.0 与可灵', () => {
    for (const alias of ['2.0', '2.0-fast', '2.0-mini', '2.5'] as const) {
      expect(capabilitiesFor(alias).modes).toHaveLength(7)
    }
    expect(capabilitiesFor('wan3').modes).toHaveLength(4)
    expect(capabilitiesFor('kling4').modes).toHaveLength(3)
    expect(capabilitiesFor('kling4-omni').modes).toHaveLength(4)
  })

  // 这几个字段取代了散在 WorkbenchCard / cardSpec 里的「provider === 'miau'」「ratios 含
  // adaptive」之类推断 —— 可灵也是 miau,但没有文档槽、没有联网搜索、默认比例是 16:9。
  it('联网搜索只有 Seedance;文档槽只有万相', () => {
    for (const alias of ['2.0', '2.0-fast', '2.0-mini', '2.5'] as const) {
      expect(capabilitiesFor(alias).webSearch).toBe(true)
    }
    for (const alias of ['wan3', 'wan3-prime', 'kling4', 'kling4-omni', 'depth'] as const) {
      expect(capabilitiesFor(alias).webSearch).toBe(false)
    }
    for (const alias of Object.keys(SEEDANCE_MODEL_CAPABILITIES) as VideoModelAlias[]) {
      expect(capabilitiesFor(alias).documentSlot).toBe(alias === 'wan3' || alias === 'wan3-prime')
    }
  })

  it('智能时长(-1)只有 Seedance 与万相收', () => {
    for (const alias of ['2.0', '2.0-fast', '2.0-mini', '2.5', 'wan3', 'wan3-prime'] as const) {
      expect(capabilitiesFor(alias).smartDuration).toBe(true)
    }
    expect(capabilitiesFor('kling4').smartDuration).toBe(false)
    expect(capabilitiesFor('kling4-omni').smartDuration).toBe(false)
  })
})

/**
 * 可灵 4.0(`kling-v4-vod`)/ 4.0 Omni(`kling-v4-omni-vod`)—— 腾讯云 VOD AIGC,经 Miau
 * 网关(渠道类型 76)。数字出自 new-api #183 / #184 与 sora-ui #294–#296。
 */
describe('可灵 4.0 能力', () => {
  it('走 miau,3–30 秒,四档分辨率,没有 480p', () => {
    for (const alias of ['kling4', 'kling4-omni'] as const) {
      const caps = capabilitiesFor(alias)
      expect(caps.provider).toBe('miau')
      expect(caps.duration).toEqual({ min: 3, max: 30 })
      expect(caps.resolutions).toEqual(['720p', '1080p', '2k', '4k'])
      expect(caps.ratios).toEqual(['16:9', '9:16', '1:1', '21:9', 'adaptive'])
      expect(caps.defaultRatio).toBe('16:9')
      expect(caps.seedMax).toBe(0)
      expect(caps.publicUrlMediaOnly).toBe(true)
    }
  })

  it('4.0 只有文生 / 首帧 / 首尾帧,没有任何参考素材;Omni 加全能参考', () => {
    const k4 = capabilitiesFor('kling4')
    expect(k4.modes).toEqual(['text2video', 'first_frame', 'first_last_frame'])
    expect([k4.maxImages, k4.maxVideos, k4.maxAudios]).toEqual([2, 0, 0])

    const omni = capabilitiesFor('kling4-omni')
    expect(omni.modes).toEqual(['text2video', 'first_frame', 'first_last_frame', 'multimodal_ref'])
    expect([omni.maxImages, omni.maxVideos, omni.maxAudios]).toEqual([10, 5, 0])
    expect(omni.maxMaterialsTotal).toBe(15)
  })

  it('时长 -1 被拦,并说清是「没有智能时长」', () => {
    const errors = validateSeedanceRequest('kling4', { duration: -1 })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/不支持智能时长/)
    expect(validateSeedanceRequest('kling4', { duration: 2 })[0]).toMatch(/3-30/)
    expect(validateSeedanceRequest('kling4', { duration: 31 })[0]).toMatch(/3-30/)
    expect(validateSeedanceRequest('kling4-omni', { duration: 3 })).toEqual([])
    expect(validateSeedanceRequest('kling4-omni', { duration: 30 })).toEqual([])
  })

  it('分辨率:2k / 4k 放行,480p 拦下', () => {
    expect(validateSeedanceRequest('kling4', { resolution: '2k' })).toEqual([])
    expect(validateSeedanceRequest('kling4', { resolution: '4k' })).toEqual([])
    expect(validateSeedanceRequest('kling4', { resolution: '480p' })[0]).toMatch(/480p/)
  })

  it('素材:4.0 不接参考视频 / 音频(说「不接受」,不说「最多 0 个」)', () => {
    const video = validateSeedanceRequest('kling4', { videos: 1 })
    expect(video).toHaveLength(1)
    expect(video[0]).toMatch(/不接受参考视频.*Omni/)
    expect(video[0]).not.toMatch(/最多 0/)
    expect(validateSeedanceRequest('kling4', { audios: 1 })[0]).toMatch(/不接受参考音频/)
    expect(validateSeedanceRequest('kling4', { images: 3 })[0]).toMatch(/2/)
    expect(validateSeedanceRequest('kling4', { images: 2 })).toEqual([])
  })

  it('素材:Omni 图 10 / 视频 5 / 合计 15,音频一律不接', () => {
    expect(validateSeedanceRequest('kling4-omni', { images: 10, videos: 5 })).toEqual([])
    expect(validateSeedanceRequest('kling4-omni', { images: 11 })[0]).toMatch(/10/)
    expect(validateSeedanceRequest('kling4-omni', { videos: 6 })[0]).toMatch(/5/)
    expect(validateSeedanceRequest('kling4-omni', { audios: 1 })[0]).toMatch(/不接受参考音频/)
  })

  it('不带 taskMode / 擦字幕:可灵没有这两样', () => {
    expect(validateSeedanceRequest('kling4', { taskMode: 'edit', videos: 1, duration: -1 })[0]).toMatch(
      /不支持 taskMode/,
    )
    expect(validateSeedanceRequest('kling4', { subtitleErase: true })[0]).toMatch(/不支持擦除字幕/)
  })

  it('分镜:只有可灵两个模型声明支持', () => {
    for (const alias of Object.keys(SEEDANCE_MODEL_CAPABILITIES) as VideoModelAlias[]) {
      expect(capabilitiesFor(alias).multiShot, alias).toBe(alias === 'kling4' || alias === 'kling4-omni')
    }
  })

  it('分镜校验:镜头时长之和必须等于总时长;对上了就放行', () => {
    const shots = [
      { prompt: '雨夜街头', duration: 2 },
      { prompt: '雨滴特写', duration: 3 },
    ]
    const multiShot = { type: 'customize' as const, shots }
    expect(validateSeedanceRequest('kling4', { duration: 5, multiShot })).toEqual([])
    expect(validateSeedanceRequest('kling4-omni', { duration: 8, multiShot })[0]).toMatch(/各镜头时长之和需等于视频总时长/)
  })

  it('智能分镜需要总提示词;自定义分镜不需要', () => {
    expect(validateSeedanceRequest('kling4', { duration: 5, multiShot: { type: 'intelligence' }, prompt: '  ' })[0]).toMatch(
      /智能分镜需要填写提示词/,
    )
    expect(validateSeedanceRequest('kling4', { duration: 5, multiShot: { type: 'intelligence' }, prompt: '雨夜' })).toEqual([])
    const customize = { type: 'customize' as const, shots: [{ prompt: '雨夜', duration: 5 }] }
    expect(validateSeedanceRequest('kling4', { duration: 5, multiShot: customize, prompt: '' })).toEqual([])
  })

  it('镜头数 / 描述长度上限:1–6 个镜头,每镜 ≤512 字', () => {
    const seven = { type: 'customize' as const, shots: Array.from({ length: 7 }, () => ({ prompt: 'a', duration: 1 })) }
    expect(validateSeedanceRequest('kling4', { duration: 7, multiShot: seven })).not.toEqual([])
    const long = { type: 'customize' as const, shots: [{ prompt: 'x'.repeat(513), duration: 5 }] }
    expect(validateSeedanceRequest('kling4', { duration: 5, multiShot: long })[0]).toMatch(/512/)
  })

  it('其它模型带分镜:明说不支持,而不是悄悄忽略', () => {
    const multiShot = { type: 'customize' as const, shots: [{ prompt: 'a', duration: 5 }] }
    expect(validateSeedanceRequest('2.0', { duration: 5, multiShot })[0]).toMatch(/不支持分镜/)
    expect(validateSeedanceRequest('wan3', { duration: 5, multiShot })[0]).toMatch(/不支持分镜/)
  })
})

describe('万相 3.0 能力', () => {
  it('多模态上限 10/5/5、时长 2-30、三档分辨率', () => {
    const caps = capabilitiesFor('wan3')
    expect([caps.maxImages, caps.maxVideos, caps.maxAudios]).toEqual([10, 5, 5])
    expect(caps.duration).toEqual({ min: 2, max: 30 })
    expect(caps.resolutions).toEqual(['480p', '720p', '1080p'])
  })

  it('走 miau,允许纯音频参考,没有擦字幕', () => {
    const caps = capabilitiesFor('wan3')
    expect(caps.provider).toBe('miau')
    expect(caps.audioOnlyReference).toBe(true)
    expect(caps.subtitleErase).toBe(false)
  })

  it('只开四种模式 —— 不含参考图与编辑/延长', () => {
    expect(capabilitiesFor('wan3').modes).toEqual([
      'text2video',
      'first_frame',
      'first_last_frame',
      'multimodal_ref',
    ])
  })

  it('时长接受 -1(智能时长)与 2 秒下限', () => {
    expect(validateSeedanceRequest('wan3', { duration: -1 })).toEqual([])
    expect(validateSeedanceRequest('wan3', { duration: 2 })).toEqual([])
    expect(validateSeedanceRequest('wan3', { duration: 1 })).not.toEqual([])
    expect(validateSeedanceRequest('wan3', { duration: 31 })).not.toEqual([])
  })

  it('分辨率按内部小写口径校验(大写转换留给上行组包)', () => {
    expect(validateSeedanceRequest('wan3', { resolution: '1080p' })).toEqual([])
    expect(validateSeedanceRequest('wan3', { resolution: '4k' })).not.toEqual([])
  })
})

/**
 * 深度捕捉(`depth`)—— 把一段视频变成灰度深度视频(近亮远暗)的**变体**,经 Miau 网关
 * 的腾讯云点播深度估计渠道(`rh-video-depth-<分辨率>`,三档产物一致),按次计费。
 *
 * 它和生成模型的本质区别:没有提示词、没有画幅/时长/seed,输入恰好一段源视频,输出时长随源。
 * 上游限制(必须公网 URL;时长 / 体积上限腾讯没公布)见 `depth/model.ts`。
 */
describe('深度捕捉 depth 能力', () => {
  it('走 miau、三档分辨率、画幅只有 adaptive', () => {
    const caps = capabilitiesFor('depth')
    expect(caps.provider).toBe('miau')
    expect(caps.resolutions).toEqual(['480p', '720p', '1080p'])
    expect(caps.ratios).toEqual(['adaptive'])
  })

  it('只收一段视频,不收图 / 音频,没有 edit / extend / 擦字幕', () => {
    const caps = capabilitiesFor('depth')
    expect([caps.maxImages, caps.maxVideos, caps.maxAudios]).toEqual([0, 1, 0])
    expect(caps.maxMaterialsTotal).toBe(1)
    expect(caps.taskModes).toEqual([])
    expect(caps.subtitleErase).toBe(false)
    expect(caps.audioOnlyReference).toBe(false)
  })

  it('没有工作台模式 —— 它是 agent / MCP 的变体,不进「生成视频」工作台', () => {
    expect(capabilitiesFor('depth').modes).toEqual([])
  })

  it('恰好一段源视频才放行', () => {
    expect(validateSeedanceRequest('depth', { resolution: '480p', videos: 1 })).toEqual([])
    expect(validateSeedanceRequest('depth', { resolution: '1080p', videos: 1 })).toEqual([])
    expect(validateSeedanceRequest('depth', { videos: 0 })[0]).toMatch(/一段源视频/)
    expect(validateSeedanceRequest('depth', { videos: 2 })[0]).toMatch(/一段源视频/)
    expect(validateSeedanceRequest('depth', {})[0]).toMatch(/一段源视频/)
  })

  it('带图 / 音频给出针对性的话,而不是「参考图最多 0 张」', () => {
    const imageErrors = validateSeedanceRequest('depth', { videos: 1, images: 1 })
    expect(imageErrors.join('；')).toMatch(/只接受一段源视频/)
    expect(imageErrors.join('；')).not.toMatch(/最多 0/)
    expect(validateSeedanceRequest('depth', { videos: 1, audios: 1 }).join('；')).toMatch(
      /只接受一段源视频/,
    )
  })

  it('时长不是它的参数:任何值都不拦(输出时长随源视频),分辨率照常校验', () => {
    expect(validateSeedanceRequest('depth', { videos: 1, duration: 5 })).toEqual([])
    expect(validateSeedanceRequest('depth', { videos: 1, duration: -1 })).toEqual([])
    expect(validateSeedanceRequest('depth', { videos: 1, resolution: '4k' })[0]).toMatch(/4k/)
  })

  it('不让别的模型沾上这条规则:2.0 不带视频照样放行', () => {
    expect(validateSeedanceRequest('2.0', { videos: 0 })).toEqual([])
    expect(validateSeedanceRequest('wan3', { videos: 0 })).toEqual([])
  })
})

describe('validateSeedanceRequest', () => {
  it('放行一次普通的 2.5 请求', () => {
    expect(
      validateSeedanceRequest('2.5', { duration: 30, resolution: '720p' }),
    ).toEqual([])
  })

  it('挡下 2.5 的 4k —— 不然要等上游 400 才知道', () => {
    const errors = validateSeedanceRequest('2.5', { duration: 5, resolution: '4k' })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/4k/)
  })

  it('挡下超出该模型时长上限的值,-1 永远放行', () => {
    expect(validateSeedanceRequest('2.0', { duration: 30 })[0]).toMatch(/4-15/)
    expect(validateSeedanceRequest('2.5', { duration: 31 })[0]).toMatch(/4-30/)
    expect(validateSeedanceRequest('2.0', { duration: -1 })).toEqual([])
    expect(validateSeedanceRequest('2.5', { duration: -1 })).toEqual([])
  })

  it('edit / extend 必须带视频参考(文档 4.9)', () => {
    expect(
      validateSeedanceRequest('2.5', { taskMode: 'edit', duration: -1, videos: 0 })[0],
    ).toMatch(/视频/)
    expect(
      validateSeedanceRequest('2.5', { taskMode: 'extend', duration: 10, videos: 1 }),
    ).toEqual([])
  })

  it('edit 锁死 -1 时长', () => {
    expect(
      validateSeedanceRequest('2.5', { taskMode: 'edit', duration: 10, videos: 1 })[0],
    ).toMatch(/-1/)
    expect(
      validateSeedanceRequest('2.5', { taskMode: 'edit', duration: -1, videos: 1 }),
    ).toEqual([])
  })

  it('2.0 家族不认 taskMode', () => {
    expect(
      validateSeedanceRequest('2.0', { taskMode: 'edit', duration: -1, videos: 1 })[0],
    ).toMatch(/2\.5/)
  })

  it('按模型上限挡素材超量', () => {
    expect(validateSeedanceRequest('2.0', { images: 10 })[0]).toMatch(/9/)
    expect(validateSeedanceRequest('2.5', { images: 10 })).toEqual([])
    expect(validateSeedanceRequest('2.5', { images: 31 })[0]).toMatch(/30/)
    expect(validateSeedanceRequest('2.5', { videos: 11 })[0]).toMatch(/10/)
    // 满配正好是 30+10+10=50,即文档给的总数上限 —— 单类不超就一定不超总数。
    expect(validateSeedanceRequest('2.5', { images: 30, videos: 10, audios: 10 })).toEqual([])
  })
})
