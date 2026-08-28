// 计费归属请求头。
//
// 真机查出来的那个 bug:钱扣对了,但用量流水一条都查不到。
//
// 根因在 new-api 侧:任务与消费日志的归属字段是**从请求头取的**
// (`controller/relay.go:801-806` 的 `task.PrivateData.PlatformUserId = c.GetHeader(...)`,
// `model/log.go:400-423` 有同款回退),而桌面端只发了 `Authorization`。于是行写进去时
// `platform_user_id=''` / `project_id=0`,而查询是
// `WHERE platform_user_id=<uuid> AND project_id=<id>` —— 一条都匹配不上。
//
// 扣费不受影响(它走 token 的 allocation,与请求头无关),所以症状是
// 「钱少了、记录为 0」,用户第一反应必然是钱被吞了。

import { beforeEach, describe, expect, it, vi } from 'vitest'

const cred = { current: null as unknown }
vi.mock('../credentials', () => ({
  getCredential: () => cred.current,
}))
vi.mock('../authBaseUrl', () => ({ authBaseUrl: () => 'https://example.test' }))
vi.mock('electron', () => ({
  app: { getPath: () => 'C:/tmp', isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from(''),
    decryptString: () => '',
  },
}))

const LOGGED_IN = {
  token: 't',
  userId: 'user-uuid-1',
  username: 'u',
  displayName: 'u',
  role: 'USER',
  expiresAt: 0,
}

describe('gatewayAttributionHeaders', () => {
  beforeEach(() => {
    cred.current = { ...LOGGED_IN }
  })

  it('普通池:带上 platform user 与 project,不带 producer', async () => {
    const m = await import('../gatewayToken')
    m.setActivePool({ projectId: 345, producerProjectId: null })

    expect(m.gatewayAttributionHeaders()).toEqual({
      'X-Platform-User-Id': 'user-uuid-1',
      'X-Project-Id': '345',
    })
  })

  /**
   * producer 池的池键是两半。少发一半的后果不是报错,是流水记到错的子项目上 ——
   * 而那正是后台那句「无法单独拆出当前池(子项目 #82)」要解决的问题。
   */
  it('producer 池:两半都带', async () => {
    const m = await import('../gatewayToken')
    m.setActivePool({ projectId: 346, producerProjectId: 82 })

    expect(m.gatewayAttributionHeaders()).toEqual({
      'X-Platform-User-Id': 'user-uuid-1',
      'X-Project-Id': '346',
      'X-Producer-Project-Id': '82',
    })
  })

  /**
   * 没登录 / 没选池时**不发空头**。`X-Platform-User-Id: ''` 与不发是两回事:
   * 前者会让上游把空串当成一个合法的归属值写进去,而那与今天的坏状态一模一样,
   * 只是从「没写」变成「明确写了个空的」,更难在事后分辨。
   */
  it('没选池时回空对象,不发空串头', async () => {
    const m = await import('../gatewayToken')
    m.setActivePool(null)
    expect(m.gatewayAttributionHeaders()).toEqual({})
  })

  it('没登录时回空对象', async () => {
    const m = await import('../gatewayToken')
    m.setActivePool({ projectId: 345, producerProjectId: null })
    cred.current = null
    expect(m.gatewayAttributionHeaders()).toEqual({})
  })
})
