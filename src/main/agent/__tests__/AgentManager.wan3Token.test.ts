// 万相的密钥来自 `wan3/credentials` 里那个**由外部注入**的取值函数,而注入这一步
// 在 AgentManager 构造时做。
//
// 为什么单独开一个文件盯它:`wan3/__tests__/credentials.test.ts` 每条用例都自己
// 调 `setWan3TokenSource` 再断言,所以那套全绿只证明「注入之后取值是对的」,
// **证明不了生产代码里真的有人注入**。这条线断掉的表现是用户明明在设置里填了
// Miau 密钥,工作台仍然报「未配置 Miau 密钥」—— 一个从卡片上完全看不出根因的错误。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentManager } from '../AgentManager'
import {
  __resetWan3Credentials,
  getWan3ApiKey,
  hasWan3ApiKey,
} from '../../services/wan3/credentials'

const ORIGINAL_ENV = process.env.MIAU_API_KEY

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-wan3-token-'))
  __resetWan3Credentials()
  // 环境变量是回落路径。留着它会让「注入没接上」也照样绿。
  delete process.env.MIAU_API_KEY
})

afterEach(async () => {
  __resetWan3Credentials()
  if (ORIGINAL_ENV === undefined) delete process.env.MIAU_API_KEY
  else process.env.MIAU_API_KEY = ORIGINAL_ENV
  await fs.rm(tmpDir, { recursive: true, force: true })
})

async function writeProvidersState(apiKeys: Record<string, string>): Promise<void> {
  await fs.writeFile(
    path.join(tmpDir, 'codex-providers.json'),
    JSON.stringify({
      version: 2,
      selectedGatewayId: 'apiyi',
      selectedModelId: 'grok-4.5',
      apiKeys,
      customProviders: [],
    }),
    'utf8',
  )
}

describe('AgentManager 把 Miau token 接给万相', () => {
  it('构造完万相就能拿到用户在图片生成设置里填的那枚密钥', async () => {
    // 渲染端把图片站点(Miau)的密钥镜像到 provider store 的 `qwen` 下 ——
    // 见 ApiService.syncMiauTokenToMain。万相复用的就是这一枚。
    await writeProvidersState({ qwen: 'sk-miau-from-settings' })

    new AgentManager({ userDataDir: tmpDir })

    expect(getWan3ApiKey()).toBe('sk-miau-from-settings')
    expect(hasWan3ApiKey()).toBe(true)
  })

  it('改完密钥立刻生效 —— 注入的是读实时值的闭包,不是构造时的快照', async () => {
    await writeProvidersState({ qwen: 'sk-old' })
    const mgr = new AgentManager({ userDataDir: tmpDir })

    await mgr.setProviderApiKey('qwen', 'sk-new')

    expect(getWan3ApiKey()).toBe('sk-new')
  })

  it('真的没配时如实报没有,好在提交前给人话提示而不是等上游 401', async () => {
    await writeProvidersState({})

    new AgentManager({ userDataDir: tmpDir })

    expect(hasWan3ApiKey()).toBe(false)
  })
})
