import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 「花平台的钱」与「花完报一声」必须成对出现。
 *
 * ## 这条测试挡的是什么
 *
 * `gatewayPlatformHeaders()` 是取平台凭据的唯一入口 —— 想花组织的钱就绕不过它。
 * 但「报一声好让余额刷新」是另一件事,而且**漏掉它完全没有信号**:功能照常工作,
 * 钱照常扣,只是余额数字停在旧值。这正是 2026-08-31 修的那个 bug 的形状,而它
 * 之所以拖了那么久,就是因为没有任何东西会因此变红。
 *
 * 将来接第四条出网路径时(比如某个新的上游),这条测试会在只接了凭据、忘了接
 * 上报点时立刻挂掉,并把该做什么写在失败信息里。
 *
 * ## 为什么读源码文本而不是 import 模块
 *
 * `runtime.ts` 之类会把 prisma / MCP / electron 全家桶一起拉起来,在 vitest 里根本
 * import 不动。读文本是脆一点(改个名就得同步改这里),但它守的这条不变量值这个价 ——
 * 而且真改了名,这条测试挂掉正是提醒你去看所有调用点。
 */

/**
 * 仓库的 `src`。
 *
 * 从 `process.cwd()` 推,不用 `import.meta.url` —— vitest 转换后那个不是 file 协议,
 * `fileURLToPath` 会直接抛(踩过)。cwd 取错时下面两条自检会响亮地挂:命中数为 0,
 * 以及豁免文件读不到。
 */
const SRC_ROOT = path.resolve(process.cwd(), 'src')

/** 拿凭据的入口。出现它 = 这个文件参与花平台的钱。 */
const CREDENTIAL_SYMBOL = 'gatewayPlatformHeaders'

/**
 * 报上报点的入口。`notePlatformSpend` 是直接报,`onBilledExchange` 是把报点
 * 交给下游模块(视频客户端那条就是这么接的)。两者有其一即可。
 */
const SPEND_SYMBOLS = ['notePlatformSpend', 'onBilledExchange']

interface Exemption {
  /** 为什么这个文件不需要自己上报。 */
  why: string
  /**
   * 它把发请求这件事交给了谁 —— 那个文件必须真的上报。
   *
   * 这一栏把「委托」从一句自述变成可验证的事实:下面第二条用例会去读它,
   * 确认上报点还在。没有这一栏的话,哪天代理里的上报被删掉,这条豁免会
   * 继续绿着,而它保护的不变量早就没了。
   */
  delegatesTo?: string
}

/**
 * 豁免名单。**加进来必须写清楚为什么这个文件不花钱。**
 *
 * 空豁免比漏检更危险:一句「这个先跳过」会让这条不变量在无人注意时失效。
 */
const EXEMPT: ReadonlyMap<string, Exemption> = new Map([
  [
    'main/services/auth/gatewayToken.ts',
    {
      why: '凭据的定义方。它自己不发请求,只把 Authorization 与归属头组在一起给别人。',
    },
  ],
  [
    'main/agent/CodexLocalBackend.ts',
    {
      why: '只是把组头函数当参数递给兼容代理(codex 聊天那条),自己不发上游请求。',
      delegatesTo: 'main/agent/responsesCompatibilityProxy.ts',
    },
  ],
  [
    'main/services/videoTransport.ts',
    {
      why: '只负责按 billing 组出万相那一次的鉴权头,请求由 wan3 客户端发,上报也在那儿。',
      delegatesTo: 'main/services/wan3/client.ts',
    },
  ],
])

/**
 * 递归收集 `.ts` 生产源码。
 *
 * 手写而不用 glob 库:能解析到的那个是**传递依赖**(经 vite 进来的),一次 lockfile
 * 更新就可能没有,而那时这条守卫会以「模块找不到」的形式挂掉 —— 与它真正要报的
 * 问题毫无关系,查起来还费劲。十行遍历换一个零依赖,划算。
 */
async function collectSourceFiles(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const out: string[] = []
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue
      out.push(...(await collectSourceFiles(path.join(dir, entry.name), rel)))
      continue
    }
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(rel)
  }
  return out
}

/** 生产源码里所有出现凭据入口的文件。测试与类型声明不算。 */
async function filesUsingCredentials(): Promise<string[]> {
  const candidates = await collectSourceFiles(SRC_ROOT)
  const hits: string[] = []
  for (const rel of candidates) {
    const text = await readFile(path.join(SRC_ROOT, rel), 'utf8')
    if (text.includes(CREDENTIAL_SYMBOL)) hits.push(rel)
  }
  return hits.sort()
}

describe('平台消费上报覆盖', () => {
  it('每个动用平台凭据的生产模块都接了上报点', async () => {
    const files = await filesUsingCredentials()

    // 自检:一个都没找到多半是路径/符号写错了,而那会让这条测试**永远为真** ——
    // 一条永远绿的守卫测试比没有还糟,它让人以为有保护。
    expect(files.length).toBeGreaterThan(1)

    const missing: string[] = []
    for (const rel of files) {
      if (EXEMPT.has(rel)) continue
      const text = await readFile(path.join(SRC_ROOT, rel), 'utf8')
      if (!SPEND_SYMBOLS.some((symbol) => text.includes(symbol))) missing.push(rel)
    }

    expect(
      missing,
      missing.length === 0
        ? ''
        : `这些文件动用了平台凭据却没接消费上报,扣费后余额不会刷新:\n` +
          `${missing.map((f) => `  - ${f}`).join('\n')}\n` +
          `接法:响应回来之后调 ${SPEND_SYMBOLS[0]}(),或给下游模块传 ${SPEND_SYMBOLS[1]}。\n` +
          `确实不花钱的话,把它加进本文件的 EXEMPT 并写明理由。`,
    ).toEqual([])
  })

  it('豁免名单里的文件仍然真实存在,且被委托方确实在上报', async () => {
    // 文件被重命名 / 删除后,豁免会静默地变成一条死规则,而它保护的那个文件
    // 可能已经改名回到检查范围之外了。
    for (const [rel, exemption] of EXEMPT) {
      const text = await readFile(path.join(SRC_ROOT, rel), 'utf8').catch(() => null)
      expect(text, `豁免名单指向了不存在的文件:${rel}`).not.toBeNull()
      expect(text, `${rel} 已经不再动用平台凭据,这条豁免该删了`).toContain(CREDENTIAL_SYMBOL)

      if (!exemption.delegatesTo) continue
      const delegate = await readFile(path.join(SRC_ROOT, exemption.delegatesTo), 'utf8').catch(
        () => null,
      )
      expect(delegate, `${rel} 声称委托给 ${exemption.delegatesTo},但那个文件不存在`).not.toBeNull()
      expect(
        SPEND_SYMBOLS.some((symbol) => delegate?.includes(symbol)),
        `${rel} 的豁免建立在「${exemption.delegatesTo} 会上报」之上,而那边已经不报了 ——` +
          `codex 聊天扣了钱,余额不会刷新。`,
      ).toBe(true)
    }
  })
})
