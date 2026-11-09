import { describe, expect, it } from 'vitest'
import { BUILTIN_CHANNELS } from '../gatewayModelRouting'
import { MIAU_BASE_URL } from '../../../shared/miau'
import { buildChannelIdentityInstructions } from '../channelIdentity'

const channel = (id: string) => {
  const found = BUILTIN_CHANNELS.find((c) => c.id === id)
  if (!found) throw new Error(`missing channel ${id}`)
  return found
}

describe('buildChannelIdentityInstructions', () => {
  it('Miau 通道:点明 rightcode 只是内部分组 id,别把问题归给 Right.Codes', () => {
    const text = buildChannelIdentityInstructions(channel('rightcode-deepseek-miau'), { webSearch: 'live' })
    expect(text).toBeDefined()
    expect(text).toContain('Miau')
    expect(text).toContain('`rightcode`')
    expect(text).toContain('Right.Codes')
    expect(text).toMatch(/不要.*归.*Right\.Codes/)
  })

  it('开着联网搜索:说明火山方舟的 web_search 是托管工具,函数清单里没有它是正常的', () => {
    const text = buildChannelIdentityInstructions(channel('apiyi-deepseek-miau'), { webSearch: 'live' })
    expect(text).toContain('web_search')
    expect(text).toContain('deepseek-v4-1-flash')
    expect(text).toContain('火山方舟')
    expect(text).toMatch(/不会出现在你的函数工具清单/)
    expect(text).toMatch(/不要回答.{0,6}没有联网能力/)
  })

  it('cached 也算开着(codex 仍会发出 web_search 工具)', () => {
    const text = buildChannelIdentityInstructions(channel('rightcode-deepseek-miau'), { webSearch: 'cached' })
    expect(text).toContain('web_search')
  })

  it('用户把联网搜索关了:不能再告诉模型「能搜」,但身份说明仍在', () => {
    const text = buildChannelIdentityInstructions(channel('rightcode-deepseek-miau'), { webSearch: 'disabled' })
    expect(text).toBeDefined()
    expect(text).toContain('`rightcode`')
    expect(text).not.toContain('web_search')
    expect(text).not.toContain('联网搜索')
  })

  it('千问 / Grok 的 Miau 通道:有身份说明,但不替它们声明联网搜索(没验过)', () => {
    for (const id of ['rightcode-qwen', 'apiyi-qwen', 'rightcode-grok-miau']) {
      const text = buildChannelIdentityInstructions(channel(id), { webSearch: 'live' })
      expect(text, id).toContain('`rightcode`')
      expect(text, id).not.toContain('web_search')
    }
  })

  it('不是 Miau 的通道(Right.Codes / API易 自家端点)一个字都不加', () => {
    for (const id of ['rightcode-standard', 'rightcode-grok', 'apiyi-standard', 'apiyi-grok']) {
      expect(buildChannelIdentityInstructions(channel(id), { webSearch: 'live' }), id).toBeUndefined()
    }
  })

  it('凡是指向 Miau 的内置通道都有说明,其余都没有(新增通道时的守卫)', () => {
    for (const c of BUILTIN_CHANNELS) {
      const text = buildChannelIdentityInstructions(c, { webSearch: 'live' })
      if (c.baseUrl === MIAU_BASE_URL) expect(text, c.id).toBeTypeOf('string')
      else expect(text, c.id).toBeUndefined()
    }
  })

  it('说明不带任何 key / 令牌样子的字符串', () => {
    const text = buildChannelIdentityInstructions(channel('rightcode-deepseek-miau'), { webSearch: 'live' }) ?? ''
    expect(text).not.toMatch(/sk-[A-Za-z0-9]{8,}/)
    expect(text).not.toMatch(/Bearer\s/i)
  })

  it('长度克制:这是每个新对话都要带的固定开销', () => {
    const text = buildChannelIdentityInstructions(channel('rightcode-deepseek-miau'), { webSearch: 'live' }) ?? ''
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(1600)
  })
})
