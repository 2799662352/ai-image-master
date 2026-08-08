// 每个「会写 prompt」的出片面，都必须在工具描述里点名提示词底座。
//
// 背景是一个实测漏洞：这些工具此前只说「load the catimation-video skill」，
// 而 agent 完全可以直接调 video_workbench_add_tasks / generate_video 不走入口。
// 那一跳间接一断，sd2-pe / sd25-pe 一个都不会载，prompt 就是凭记忆硬写的 ——
// 既没有素材引用语法，也没有 2.5 的编辑/延长模板。
//
// 所以断言落在「描述里同时出现两个底座名」上，而不是「描述里提到了入口卡」。

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { registerImageTools } from '../imageTools'
import { registerVideoTools } from '../videoTools'
import { registerVideoWorkbenchTools } from '../videoWorkbenchTools'
import {
  IMAGE_PROMPT_BASE_DIRECTIVE,
  MATERIAL_ROLE_DIRECTIVE,
  PROMPT_BASE_DIRECTIVE,
} from '../promptBaseDirective'

interface CapturedTool {
  name: string
  config: { description?: string }
}

function capture() {
  const tools: CapturedTool[] = []
  const server = {
    registerTool: (name: string, config: { description?: string }) => {
      tools.push({ name, config })
    },
  } as unknown as Parameters<typeof registerVideoWorkbenchTools>[0]
  const router = { call: async () => ({}) } as unknown as Parameters<typeof registerVideoWorkbenchTools>[1]
  return { tools, server, router }
}

function allTools(): CapturedTool[] {
  const { tools, server, router } = capture()
  registerVideoWorkbenchTools(server, router)
  registerVideoTools(server, router)
  registerImageTools(server, router)
  return tools
}

/** 会写 / 改 prompt 的面。只读面（status/export/remove/start/check）不在列。 */
const PROMPT_WRITING_TOOLS = [
  'generate_video',
  'video_workbench_add_tasks',
  'video_workbench_update_task',
  'video_workbench_apply',
]

describe('提示词底座在 MCP 描述里被点名', () => {
  it.each(PROMPT_WRITING_TOOLS)('%s 的描述同时点名 sd2-pe 与 sd25-pe', (name) => {
    const tool = allTools().find((t) => t.name === name)
    expect(tool, `${name} 未注册`).toBeTruthy()
    const desc = tool?.config.description ?? ''
    expect(desc).toContain('sd25-pe')
    expect(desc).toContain('sd2-pe')
    // 光提名字不够 —— 必须说清按 model 二选一，否则 agent 不知道该载哪个。
    expect(desc).toContain('2.5')
    expect(desc).toContain(PROMPT_BASE_DIRECTIVE)
  })

  it('底座指令是单一真源，不是各写一份的复制品', () => {
    const hits = allTools().filter((t) => (t.config.description ?? '').includes(PROMPT_BASE_DIRECTIVE))
    expect(hits.map((t) => t.name).sort()).toEqual([...PROMPT_WRITING_TOOLS].sort())
  })

  it('指令本身写明了两代模型的映射方向', () => {
    // 别把「2.0 家族用 sd2-pe」写丢了——只说 2.5 会让 agent 对 2.0 也载 sd25-pe。
    expect(PROMPT_BASE_DIRECTIVE).toMatch(/2\.0-fast/)
    expect(PROMPT_BASE_DIRECTIVE).toMatch(/2\.0-mini/)
  })
})

describe('视频侧素材逐份负责', () => {
  it.each(PROMPT_WRITING_TOOLS)('%s 的描述带上素材职责纪律', (name) => {
    const desc = allTools().find((t) => t.name === name)?.config.description ?? ''
    expect(desc).toContain(MATERIAL_ROLE_DIRECTIVE)
  })

  it('三类素材都覆盖到 —— 图片有绑定、视频音频不能只字不提', () => {
    expect(MATERIAL_ROLE_DIRECTIVE).toContain('图片N')
    expect(MATERIAL_ROLE_DIRECTIVE).toContain('视频N')
    expect(MATERIAL_ROLE_DIRECTIVE).toContain('音频N')
  })

  it('写明「没认领的素材会被模型自己安排用途」，而不是只说一句要写职责', () => {
    // 只写「请为每份素材写职责」是无效指令 —— 得说清不写会发生什么。
    expect(MATERIAL_ROLE_DIRECTIVE).toMatch(/invented/i)
  })
})

/** 出图面的底座只有一个，而且和视频那套**不能**互串。 */
const IMAGE_PROMPT_TOOLS = ['generate_image', 'generate_images']

describe('出图面的提示词底座', () => {
  it.each(IMAGE_PROMPT_TOOLS)('%s 点名 catimation-image', (name) => {
    const tool = allTools().find((t) => t.name === name)
    expect(tool, `${name} 未注册`).toBeTruthy()
    expect(tool?.config.description ?? '').toContain(IMAGE_PROMPT_BASE_DIRECTIVE)
  })

  it('出图面明确挡掉 Seedance 底座 —— 视频工具刚把这两个名字变显眼，容易被顺手载错', () => {
    expect(IMAGE_PROMPT_BASE_DIRECTIVE).toContain('VIDEO-ONLY')
    expect(IMAGE_PROMPT_BASE_DIRECTIVE).toContain('sd25-pe')
  })

  it('出图面不强制 director-prompt-engineering —— 骨架已内联，多读一次就是多一个来回', () => {
    // 「出图慢」的头号成因就是这类多余往返。这条钉的是「只在不够用时才读」的措辞，
    // 而不是把叶子写成必载。
    expect(IMAGE_PROMPT_BASE_DIRECTIVE).toMatch(/only when/i)
  })

  it('视频面与出图面各用各的指令，没有互相串味', () => {
    const tools = allTools()
    for (const name of IMAGE_PROMPT_TOOLS) {
      const desc = tools.find((t) => t.name === name)?.config.description ?? ''
      expect(desc).not.toContain(PROMPT_BASE_DIRECTIVE)
    }
    for (const name of PROMPT_WRITING_TOOLS) {
      const desc = tools.find((t) => t.name === name)?.config.description ?? ''
      expect(desc).not.toContain(IMAGE_PROMPT_BASE_DIRECTIVE)
    }
  })
})

// z 只是为了让 registerVideoTools 的 zod 依赖在测试环境下被正确解析。
void z
