/**
 * cinematography-kb-mcp 的 Sakuga-42M 数据集工具(query_sakuga_dataset)纯函数单测。
 * index.js 是零依赖 CJS,`require.main === module` 守卫后可直接 require 测导出,
 * 不触发 stdio 主循环、不发网络。
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const req = createRequire(import.meta.url)
// __tests__ -> agent -> main -> src -> repo root
const mcpPath = path.resolve(
  __dirname,
  '../../../../resources/cinematography-kb-mcp/index.js',
)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mcp = req(mcpPath) as {
  TOOLS: Array<{ name: string; inputSchema: { required?: string[] } }>
  buildSakugaQueryBody: (
    vector: number[],
    args: Record<string, unknown>,
  ) => {
    vector: number[]
    topk: number
    include_vector: boolean
    filter?: string
    output_fields: string[]
  }
  formatSakugaHits: (payload: unknown) => string
}

describe('cinematography-kb-mcp sakuga tool', () => {
  it('exposes query_sakuga_dataset alongside search_cinematography_kb', () => {
    const names = mcp.TOOLS.map((t) => t.name)
    expect(names).toContain('search_cinematography_kb')
    expect(names).toContain('query_sakuga_dataset')
    const sakuga = mcp.TOOLS.find((t) => t.name === 'query_sakuga_dataset')
    expect(sakuga?.inputSchema.required).toEqual(['query'])
  })

  it('buildSakugaQueryBody assembles topk/filter/output_fields', () => {
    const body = mcp.buildSakugaQueryBody([0.1, 0.2], {
      top_k: 5,
      filter: "aesthetic_score > 0.7 and user_tags like '%smears%'",
    })
    expect(body.vector).toEqual([0.1, 0.2])
    expect(body.topk).toBe(5)
    expect(body.filter).toBe("aesthetic_score > 0.7 and user_tags like '%smears%'")
    expect(body.include_vector).toBe(false)
    expect(body.output_fields).toContain('text_description')
    expect(body.output_fields).toContain('url_link')
    expect(body.output_fields).toContain('user_tags')
  })

  it('buildSakugaQueryBody defaults topk=10, caps at 50, omits empty filter', () => {
    expect(mcp.buildSakugaQueryBody([0], {}).topk).toBe(10)
    expect(mcp.buildSakugaQueryBody([0], { top_k: 999 }).topk).toBe(50)
    expect(mcp.buildSakugaQueryBody([0], {})).not.toHaveProperty('filter')
  })

  it('formatSakugaHits renders score/desc/tags/url/timecodes', () => {
    const text = mcp.formatSakugaHits({
      output: [
        {
          id: '1:2',
          score: 0.83,
          fields: {
            text_description: 'A smear-heavy chase.',
            user_tags: 'smears fighting',
            aesthetic_score: 0.9,
            dynamic_score: 0.8,
            url_link: 'https://sakugabooru.com/x.mp4',
            scene_start_time: '00:00:01',
            scene_end_time: '00:00:04',
          },
        },
      ],
    })
    expect(text).toContain('1:2')
    expect(text).toContain('A smear-heavy chase.')
    // user_tags are classified via the booru tag-type dictionary and rendered
    // comma-joined under a bucket heading (raw `smears fighting` no longer
    // appears verbatim).
    expect(text).toContain('technique terms')
    expect(text).toContain('smears, fighting')
    expect(text).toContain('https://sakugabooru.com/x.mp4')
    expect(text).toContain('00:00:01')
  })

  it('formatSakugaHits handles empty/unexpected payloads gracefully', () => {
    expect(mcp.formatSakugaHits({ output: [] })).toContain('no results')
    expect(mcp.formatSakugaHits(null)).toContain('no results')
  })
})
