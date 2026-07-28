import { describe, expect, it } from 'vitest'
import { QWEN_UNDERSTAND_PROVIDER } from '../codexProviders'

/**
 * qwen 理解通道同样不许指回 Miau 源站 IP。
 *
 * 这个 provider 是给 codex 子代理用的第二条腿(主理解路径走渲染端的
 * `/v1/chat/completions`),所以它指错了不会立刻炸,只会在派子代理时才暴露 ——
 * 更值得用一条读配置的检查钉住。地址在每次 spawn 时现读、不落库,改常量即生效。
 */
describe('QWEN_UNDERSTAND_PROVIDER', () => {
  it('走加速域名的 https,而不是源站 IP', () => {
    expect(QWEN_UNDERSTAND_PROVIDER.baseUrl).not.toContain('175.178.198.17')
    expect(QWEN_UNDERSTAND_PROVIDER.baseUrl.startsWith('https://')).toBe(true)
  })
})
