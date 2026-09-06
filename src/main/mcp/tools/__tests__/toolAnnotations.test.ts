// 每个 MCP 工具都必须声明 ToolAnnotations。
//
// 为什么值得一条守卫测试：四个 hint 的**缺省值是最保守的一组**（readOnlyHint=false、
// destructiveHint=true、idempotentHint=false、openWorldHint=true）——不写等于全都往
// 最坏里说。于是 `video_workbench_status` 这种纯读工具会和 `remove_tasks` 一样被客户端
// 当成潜在破坏性，该静默放行的调用被拦下来要确认，白白多一轮往返；反过来真该谨慎的删除
// 类工具也失去了与只读工具的区分度。
//
// 这类字段加完就会被下一个新工具漏掉，所以断言「一个都不许缺」，而不是抽查几个。

import { describe, expect, it } from 'vitest'

/**
 * schema 里出现 `undefined` 字段 = MCP 服务器起不来。
 *
 * 真实事故:`set_spec` 写了 `cardInputSchema.shape.mode`，而那个 shape 里没有 mode，
 * 取到 undefined；注册时 SDK 去读 `undefined._zod`，整个 catimation MCP 直接启动失败
 * （`Mcp error: -32603: Cannot read properties of undefined (reading '_zod')`）——
 * 不是某个工具坏了，是全部工具一起没了。
 *
 * TypeScript 当时就报了 TS2551「属性不存在」，但被当成预存基线放过。教训:Zod schema
 * 上的「属性不存在」不是类型洁癖，是运行时炸弹。这条测试把它变成必然被发现的东西。
 */
function assertNoUndefinedShapeFields(name: string, schema: unknown): void {
  const shape = (schema as { shape?: Record<string, unknown> } | undefined)?.shape
  if (!shape) return
  for (const [key, value] of Object.entries(shape)) {
    expect(value, `${name}.inputSchema.${key} 是 undefined —— 多半引用了某个 shape 上不存在的字段`)
      .toBeDefined()
  }
}
import { registerAudioTools } from '../audioTools'
import { registerHistoryTools } from '../historyTools'
import { registerImageTools } from '../imageTools'
import { registerPortraitTools } from '../portraitTools'
import { registerUiTools } from '../uiTools'
import { registerUnderstandTools } from '../understandTools'
import { registerVideoTools } from '../videoTools'
import { registerVideoWorkbenchTools } from '../videoWorkbenchTools'

interface Captured {
  name: string
  annotations?: {
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
}

function captureAll(): Captured[] {
  const tools: Captured[] = []
  const server = {
    registerTool: (name: string, config: Captured['annotations'] extends never ? never : any) => {
      tools.push({ name, annotations: config?.annotations, inputSchema: config?.inputSchema })
    },
  } as never
  const router = { call: async () => ({}) } as never
  for (const register of [
    registerVideoWorkbenchTools,
    registerVideoTools,
    registerImageTools,
    registerUnderstandTools,
    registerAudioTools,
    registerHistoryTools,
    registerUiTools,
    registerPortraitTools,
  ]) {
    ;(register as (s: never, r: never) => void)(server, router)
  }
  return tools
}

describe('MCP 工具注解', () => {
  it('没有工具的 schema 里藏着 undefined 字段 —— 有一个就全体起不来', () => {
    for (const t of captureAll()) assertNoUndefinedShapeFields(t.name, (t as { inputSchema?: unknown }).inputSchema)
  })

  /**
   * 工具 schema 是给**别人的**校验器吃的。union 转成 JSON Schema 是 anyOf，而客户端
   * 侧对 anyOf 的支持参差不齐 —— 实测有客户端拿 `duration: -1` 去校验
   * `anyOf:[{enum:[-1]},{type:integer,minimum:4}]` 直接判失败，请求根本没发出来:
   * 我们这边的 zod 明明接受，服务器日志里什么都没有，用户只看到对话里一片红。
   *
   * 所以顶层字段一律用朴素类型，把「哪些值真的合法」交给 handler 里的校验器 ——
   * 它本来就要按模型分档判（4–15 还是 4–30），schema 这层从来就管不全。
   */
  it('没有工具的顶层字段用 union —— anyOf 在客户端校验器里不可靠', () => {
    for (const t of captureAll()) {
      const shape = (t as { inputSchema?: { shape?: Record<string, { _def?: { type?: string } }> } })
        .inputSchema?.shape
      if (!shape) continue
      for (const [key, field] of Object.entries(shape)) {
        // 解包 .optional() 等修饰，看真正的内层类型。
        let def = field?._def as { type?: string; innerType?: { _def?: { type?: string } } } | undefined
        while (def?.innerType) def = def.innerType._def as typeof def
        expect(def?.type, `${t.name}.inputSchema.${key} 是 union —— 换成朴素类型，合法值交给 handler 校验`)
          .not.toBe('union')
      }
    }
  })

  it('每个工具都声明了 annotations —— 缺省值是最保守的一组，不写就是全都往最坏里说', () => {
    const missing = captureAll().filter((t) => !t.annotations).map((t) => t.name)
    expect(missing, `这些工具缺 annotations: ${missing.join(', ')}`).toEqual([])
  })

  it('纯读工具标了 readOnlyHint —— 否则会被当成潜在破坏性，白挨一次确认', () => {
    const byName = new Map(captureAll().map((t) => [t.name, t.annotations]))
    for (const name of [
      'video_workbench_status',
      'video_workbench_export',
      'video_workbench_list_projects',
      'check_video_task',
      'check_image_task',
      'query_history',
    ]) {
      expect(byName.get(name)?.readOnlyHint, `${name} 应当是只读`).toBe(true)
    }
  })

  it('会删用户数据的工具老实标 destructiveHint —— 它们**应当**触发确认', () => {
    const byName = new Map(captureAll().map((t) => [t.name, t.annotations]))
    for (const name of ['video_workbench_remove_tasks', 'video_workbench_apply']) {
      expect(byName.get(name)?.destructiveHint, `${name} 应当标破坏性`).toBe(true)
      expect(byName.get(name)?.readOnlyHint).toBe(false)
    }
  })

  it('切剧 / 建剧是写操作但不破坏:不该标 destructiveHint,也不该标只读', () => {
    const byName = new Map(captureAll().map((t) => [t.name, t.annotations]))
    for (const name of [
      'video_workbench_switch_project',
      'video_workbench_create_project',
      'video_workbench_set_project_summary',
    ]) {
      expect(byName.get(name)?.readOnlyHint, `${name} 不是只读`).toBe(false)
      expect(byName.get(name)?.destructiveHint, `${name} 不该标破坏性`).not.toBe(true)
    }
  })

  it('只读工具不该同时标破坏性 —— 两个 hint 互相矛盾等于没说', () => {
    for (const t of captureAll()) {
      if (t.annotations?.readOnlyHint) {
        expect(t.annotations.destructiveHint, `${t.name} 既只读又破坏性`).not.toBe(true)
      }
    }
  })
})
