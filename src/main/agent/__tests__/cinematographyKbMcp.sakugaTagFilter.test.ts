/**
 * query_sakuga_dataset 的 filter:DashVector 的 `like` 只支持前缀匹配('abc%'),
 * 形如 user_tags like '%smears%' 的「包含」写法会解析成功、一条都匹配不上、返回
 * code 0 的空结果 —— 和「库里真没有这个标签」长得一模一样,于是静默假阴性。
 * 修法是把标签的 like 子句从上游 filter 里摘掉,在召回的候选上按标签逐个精确匹配。
 *
 * 集成用例里的假上游按真实行为实现:filter 里只要有「前导 % 的 like」就回空集。
 */
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

type ToolResult = { success: boolean; text?: string; error?: string; detail?: string }
type Clause = { field: string; tags: string[]; negate: boolean }
type Hit = { id: string; score: number; fields: Record<string, unknown> }

const req = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mcp = req(path.resolve(__dirname, '../../../../resources/cinematography-kb-mcp/index.js')) as {
  TOOLS: Array<{ name: string; description: string; inputSchema: { properties: Record<string, { description?: string }> } }>
  SAKUGA_TAG_SCAN_TOPK: number
  splitSakugaTagFilter: (filter: unknown) => { filter: string; clauses: Clause[]; sawLike: boolean }
  hitMatchesTags: (hit: unknown, clauses: Clause[]) => boolean
  planSakugaQuery: (
    vector: number[],
    args: Record<string, unknown>,
  ) => {
    body: { topk: number; filter?: string }
    tagFilter: { filter: string; clauses: Clause[]; sawLike: boolean }
    requestedTopK: number
  }
  sakugaResult: (
    payload: unknown,
    opts?: { clauses?: Clause[]; sawLike?: boolean; requestedTopK?: number },
  ) => ToolResult
  querySakuga: (args: Record<string, unknown>) => Promise<ToolResult>
}

const hit = (id: string, userTags: string, extra: Record<string, unknown> = {}): Hit => ({
  id,
  score: 0.5,
  fields: { text_description: `clip ${id}`, user_tags: userTags, aesthetic_score: 0.8, dynamic_score: 0.7, ...extra },
})

describe('splitSakugaTagFilter', () => {
  it('把 user_tags 的 like 摘出来,不再发给上游', () => {
    const r = mcp.splitSakugaTagFilter("user_tags like '%smears%'")
    expect(r.filter).toBe('')
    expect(r.clauses).toEqual([{ field: 'user_tags', tags: ['smears'], negate: false }])
    expect(r.sawLike).toBe(false)
  })

  it('数值条件留给上游,标签条件本地做,两者可以混用', () => {
    const r = mcp.splitSakugaTagFilter("aesthetic_score > 0.7 and user_tags like '%smears%' and dynamic_score > 0.6")
    expect(r.filter).toBe('aesthetic_score > 0.7 and dynamic_score > 0.6')
    expect(r.clauses).toHaveLength(1)
  })

  it('anime_tags 也一样,字段分开记,标签小写化,not like 记为排除', () => {
    const r = mcp.splitSakugaTagFilter(
      "ANIME_TAGS LIKE '%Sword%' AND user_tags not like '%impact_frames%' AND user_tags like '%smears%'",
    )
    expect(r.clauses).toEqual([
      { field: 'anime_tags', tags: ['sword'], negate: false },
      { field: 'user_tags', tags: ['impact_frames'], negate: true },
      { field: 'user_tags', tags: ['smears'], negate: false },
    ])
  })

  it('下划线是标签里的字面字符,不当通配符;多个词拆成多个标签', () => {
    const r = mcp.splitSakugaTagFilter("user_tags like '%background_animation fire%'")
    expect(r.clauses[0].tags).toEqual(['background_animation', 'fire'])
  })

  it("引号里的 and 不当连接词", () => {
    const r = mcp.splitSakugaTagFilter("user_tags like '%rock and roll%' and aesthetic_score > 0.5")
    expect(r.filter).toBe('aesthetic_score > 0.5')
    expect(r.clauses[0].tags).toEqual(['rock', 'and', 'roll'])
  })

  it('like \'%\' 匹配一切,没有可执行的条件,直接丢掉', () => {
    const r = mcp.splitSakugaTagFilter("user_tags like '%' and aesthetic_score > 0.5")
    expect(r.clauses).toEqual([])
    expect(r.filter).toBe('aesthetic_score > 0.5')
  })

  it('含 or / 括号 / 引号不配对的表达式原样放行,不改语义,并标记 sawLike', () => {
    for (const expr of [
      "user_tags like '%smears%' or user_tags like '%impact_frames%'",
      "(aesthetic_score > 0.7) and user_tags like '%smears%'",
      "user_tags like '%smears%",
      // 前半句本来能摘,但整条表达式有残缺引号:宁可整条原样放行,也不拆出一个半截的上游 filter。
      "user_tags like '%smears%' and url_link like 'abc",
    ]) {
      const r = mcp.splitSakugaTagFilter(expr)
      expect(r.filter).toBe(expr)
      expect(r.clauses).toEqual([])
      expect(r.sawLike).toBe(true)
    }
  })

  it('其它字段上的 like 不翻译,留在上游并标记 sawLike(用来在空结果时警告)', () => {
    const r = mcp.splitSakugaTagFilter("url_link like '%abc%' and aesthetic_score > 0.7")
    expect(r.filter).toBe("url_link like '%abc%' and aesthetic_score > 0.7")
    expect(r.clauses).toEqual([])
    expect(r.sawLike).toBe(true)
  })

  it('没有 like 的表达式原样返回', () => {
    const r = mcp.splitSakugaTagFilter('aesthetic_score > 0.9')
    expect(r).toEqual({ filter: 'aesthetic_score > 0.9', clauses: [], sawLike: false })
    expect(mcp.splitSakugaTagFilter(undefined)).toEqual({ filter: '', clauses: [], sawLike: false })
  })
})

describe('hitMatchesTags', () => {
  const clause = (field: string, tags: string[], negate = false): Clause => ({ field, tags, negate })

  it('按标签整词精确匹配,不是子串(smear ≠ smears),大小写不敏感', () => {
    const h = hit('1', 'Smears impact_frames masahiko_otsuka')
    expect(mcp.hitMatchesTags(h, [clause('user_tags', ['smears'])])).toBe(true)
    expect(mcp.hitMatchesTags(h, [clause('user_tags', ['smear'])])).toBe(false)
    expect(mcp.hitMatchesTags(h, [clause('user_tags', ['masahiko'])])).toBe(false)
  })

  it('字段分开看:anime_tags 里的词不会满足 user_tags 的条件', () => {
    const h = hit('1', 'smears', { anime_tags: 'sword, rain' })
    expect(mcp.hitMatchesTags(h, [clause('user_tags', ['sword'])])).toBe(false)
    expect(mcp.hitMatchesTags(h, [clause('anime_tags', ['sword'])])).toBe(true)
  })

  it('多个条件要同时满足;排除条件要求这些标签不齐', () => {
    const h = hit('1', 'smears impact_frames')
    expect(mcp.hitMatchesTags(h, [clause('user_tags', ['smears']), clause('user_tags', ['impact_frames'])])).toBe(true)
    expect(mcp.hitMatchesTags(h, [clause('user_tags', ['smears']), clause('user_tags', ['fire'])])).toBe(false)
    expect(mcp.hitMatchesTags(h, [clause('user_tags', ['impact_frames'], true)])).toBe(false)
    expect(mcp.hitMatchesTags(h, [clause('user_tags', ['fire'], true)])).toBe(true)
  })

  it('字段缺失 / 非对象的命中不会抛错', () => {
    expect(mcp.hitMatchesTags({ id: 'x' }, [clause('user_tags', ['smears'])])).toBe(false)
    expect(mcp.hitMatchesTags(null, [clause('user_tags', ['smears'])])).toBe(false)
    expect(mcp.hitMatchesTags(hit('1', 'smears'), [])).toBe(true)
  })
})

describe('planSakugaQuery', () => {
  const vec = [0.1, 0.2]

  it('有标签条件:上游 filter 里没有 like,候选池放大到扫描量', () => {
    const p = mcp.planSakugaQuery(vec, { query: 'q', top_k: 5, filter: "aesthetic_score > 0.7 and user_tags like '%smears%'" })
    expect(p.body.filter).toBe('aesthetic_score > 0.7')
    expect(p.body.topk).toBe(mcp.SAKUGA_TAG_SCAN_TOPK)
    expect(p.requestedTopK).toBe(5)
  })

  it('标签条件拿掉后没有别的条件:上游根本不带 filter 键', () => {
    const p = mcp.planSakugaQuery(vec, { query: 'q', filter: "user_tags like '%smears%'" })
    expect(p.body).not.toHaveProperty('filter')
  })

  it('没有标签条件:行为与以前完全一样(不放大候选池,filter 原样)', () => {
    const p = mcp.planSakugaQuery(vec, { query: 'q', top_k: 7, filter: 'aesthetic_score > 0.7' })
    expect(p.body.topk).toBe(7)
    expect(p.body.filter).toBe('aesthetic_score > 0.7')
    const q = mcp.planSakugaQuery(vec, { query: 'q', top_k: 999 })
    expect(q.body.topk).toBe(50)
    expect(q.requestedTopK).toBe(50)
  })

  it('不能翻译的表达式原样发出', () => {
    const expr = "user_tags like '%a%' or user_tags like '%b%'"
    const p = mcp.planSakugaQuery(vec, { query: 'q', filter: expr })
    expect(p.body.filter).toBe(expr)
    expect(p.body.topk).toBe(10)
  })
})

describe('sakugaResult', () => {
  const clauses: Clause[] = [{ field: 'user_tags', tags: ['smears'], negate: false }]
  const payload = {
    output: [hit('a', 'smears'), hit('b', 'fire'), hit('c', 'smears impact_frames'), hit('d', 'water')],
  }

  it('只留满足标签条件的候选,按 top_k 截断,并说明是本地筛的', () => {
    const r = mcp.sakugaResult(payload, { clauses, requestedTopK: 10 })
    expect(r.success).toBe(true)
    expect(r.text).toContain('clip a')
    expect(r.text).toContain('clip c')
    expect(r.text).not.toContain('clip b')
    expect(r.text).not.toContain('clip d')
    expect(r.text).toContain('checked 4 recalled candidates, kept 2')
    const one = mcp.sakugaResult(payload, { clauses, requestedTopK: 1 })
    expect(one.text).toContain('clip a')
    expect(one.text).not.toContain('clip c')
  })

  it('候选里一个都没有:明说「不在这批候选里」≠「数据集里没有」,不再伪装成 (no results)', () => {
    const r = mcp.sakugaResult(payload, { clauses: [{ field: 'user_tags', tags: ['henkei'], negate: false }] })
    expect(r.success).toBe(true)
    expect(r.text).not.toBe('(no results)')
    expect(r.text).toContain('none of the 4')
    expect(r.text).toContain('NOT "not in the dataset"')
  })

  it('上游就没召回任何东西(数值条件挡光了):还是 (no results)', () => {
    expect(mcp.sakugaResult({ output: [] }, { clauses }).text).toBe('(no results)')
  })

  it('仍带着不能翻译的 like 而结果为空:给出警告,不能当成不存在的证据', () => {
    const r = mcp.sakugaResult({ output: [] }, { sawLike: true })
    expect(r.text).toContain('CAUTION')
    expect(r.text).toContain('PREFIX-ONLY')
    expect(r.text).toContain('does NOT prove')
  })

  it('没有 like 的空结果维持原样,不乱加警告', () => {
    expect(mcp.sakugaResult({ output: [] }, { sawLike: false }).text).toBe('(no results)')
    expect(mcp.sakugaResult({ output: [] }).text).toBe('(no results)')
  })

  it('上游报错照旧是失败', () => {
    const r = mcp.sakugaResult({ code: -2021, message: 'collection not exist' }, { clauses })
    expect(r.success).toBe(false)
    expect(r.error).toBe('DashVector code -2021')
  })
})

describe('工具描述', () => {
  it('不再教 agent 写「上游会静默吞掉」的 like,并写明前缀匹配 + 本地筛', () => {
    const tool = mcp.TOOLS.find((t) => t.name === 'query_sakuga_dataset')!
    expect(tool.description).not.toContain("user_tags like '%smears%'")
    expect(tool.description).toContain('never proves')
    const filterDoc = tool.inputSchema.properties.filter.description ?? ''
    expect(filterDoc).toContain('prefix-only')
    expect(filterDoc).toContain('locally')
  })
})

describe('querySakuga 端到端(假中转模拟 DashVector 的前缀匹配)', () => {
  const ENV_KEYS = [
    'CATIMATION_KB_RELAY_URL',
    'CATIMATION_KB_RELAY_TOKEN',
    'DASHSCOPE_API_KEY',
    'DASHVECTOR_API_KEY',
    'DASHVECTOR_ENDPOINT',
  ] as const
  let savedEnv: Record<string, string | undefined> = {}
  const cleanups: Array<() => Promise<void>> = []

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
    for (const key of ENV_KEYS) delete process.env[key]
  })
  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
    while (cleanups.length > 0) await cleanups.pop()!()
  })

  /** 带前导 % 的 like(包含匹配)在真实 DashVector 里匹配不到任何文档,也不报错。 */
  const upstreamDropsEverything = (filter: unknown): boolean =>
    typeof filter === 'string' && /\blike\s+['"]%/i.test(filter)

  async function startRelay(candidates: Hit[]): Promise<Array<{ path: string; body: any }>> {
    const calls: Array<{ path: string; body: any }> = []
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk as Buffer)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      calls.push({ path: request.url ?? '', body })
      response.writeHead(200, { 'Content-Type': 'application/json' })
      if (request.url === '/embeddings') {
        response.end(JSON.stringify({ data: [{ index: 0, embedding: Array.from({ length: 512 }, (_, i) => i / 512) }] }))
      } else {
        const output = upstreamDropsEverything(body.filter) ? [] : candidates.slice(0, body.topk)
        response.end(JSON.stringify({ code: 0, output }))
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    cleanups.push(() => new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    }))
    process.env.CATIMATION_KB_RELAY_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    process.env.CATIMATION_KB_RELAY_TOKEN = 'relay-token-for-test'
    return calls
  }

  const pool = [
    ...Array.from({ length: 30 }, (_, i) => hit(`plain-${i}`, 'fire water')),
    hit('smear-late', 'smears impact_frames'),
    hit('smear-other', 'smears'),
  ]

  it("user_tags like '%smears%' 不再得到静默空集:找出候选池里真有 smears 的片段", async () => {
    const calls = await startRelay(pool)
    const r = await mcp.querySakuga({ query: 'smear frames', filter: "user_tags like '%smears%'" })
    const upstream = calls.find((c) => c.path === '/vector/query')!
    expect(JSON.stringify(upstream.body)).not.toMatch(/like/i)
    expect(upstream.body.topk).toBe(mcp.SAKUGA_TAG_SCAN_TOPK)
    expect(r.success).toBe(true)
    expect(r.text).not.toBe('(no results)')
    expect(r.text).toContain('clip smear-late')
    expect(r.text).toContain('clip smear-other')
    expect(r.text).not.toContain('clip plain-0')
  })

  it('混用数值条件:数值照旧发给上游,标签本地筛', async () => {
    const calls = await startRelay(pool)
    const r = await mcp.querySakuga({
      query: 'smear frames',
      top_k: 1,
      filter: "aesthetic_score > 0.7 and user_tags like '%smears%'",
    })
    expect(calls.find((c) => c.path === '/vector/query')!.body.filter).toBe('aesthetic_score > 0.7')
    expect(r.text).toContain('clip smear-late')
    expect(r.text).not.toContain('clip smear-other')
  })

  it('候选池里真的没有:明说是「这批候选里没有」,不是「数据集里没有」', async () => {
    await startRelay(pool)
    const r = await mcp.querySakuga({ query: 'smear frames', filter: "user_tags like '%henkei%'" })
    expect(r.success).toBe(true)
    expect(r.text).toContain('NOT "not in the dataset"')
  })

  it('其它字段上的包含式 like 仍会被上游吞掉 —— 但这次空结果带着警告', async () => {
    await startRelay(pool)
    const r = await mcp.querySakuga({ query: 'smear frames', filter: "url_link like '%abc%'" })
    expect(r.text).toContain('CAUTION')
  })

  it('不带 filter 的查询不受影响', async () => {
    const calls = await startRelay(pool)
    const r = await mcp.querySakuga({ query: 'smear frames', top_k: 3 })
    expect(calls.find((c) => c.path === '/vector/query')!.body.topk).toBe(3)
    expect(r.text).toContain('clip plain-0')
    expect(r.text).not.toContain('[tag filter]')
  })
})
