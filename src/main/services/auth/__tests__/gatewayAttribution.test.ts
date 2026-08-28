// 打网关的完整请求头:`Authorization` 与计费归属**绑在一起**。
//
// 真机撞到的那个 bug:钱扣对了,但用量流水一条都查不到。
//
// 根因在 new-api 侧是**按请求头认归属**
// (`controller/relay.go:801-806` 把 X-Platform-User-Id 读进 task.PrivateData,
// `model/log.go:400-423` 有同款回退),而桌面端当时只发了 Authorization。于是行以
// `platform_user_id=''` / `project_id=0` 落库,而查询按
// `WHERE platform_user_id=? AND project_id=?` 走 —— 一条都匹配不上。
//
// 扣费不受影响(走 token 的 allocation),所以症状是「余额少了、记录为 0」,
// 用户第一反应必然是钱被吞了。
//
// 所以这个函数**不提供只取 Authorization、或只取归属的入口** —— 分开取的那一天
// 就是归属被忘掉的那一天,而忘掉不报任何错。

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

describe('gatewayPlatformHeaders', () => {
  beforeEach(() => {
    cred.current = { ...LOGGED_IN }
  })

  it('普通池:Authorization 与归属一起给,不带 producer', async () => {
    const m = await import('../gatewayToken')
    m.setActivePool({ projectId: 345, producerProjectId: null })

    expect(m.gatewayPlatformHeaders('sk-abc')).toEqual({
      Authorization: 'Bearer sk-abc',
      'X-Platform-User-Id': 'user-uuid-1',
      'X-Project-Id': '345',
    })
  })

  /**
   * 🧬 变异点:把 producer 那一支删掉,这条必红。
   *
   * 池键是两半。少发一半,流水会记到错的子项目上 —— 后台那句
   * 「无法单独拆出当前池(子项目 #82)」正是这个问题的表现。
   */
  it('producer 池:两半都带', async () => {
    const m = await import('../gatewayToken')
    m.setActivePool({ projectId: 346, producerProjectId: 82 })

    expect(m.gatewayPlatformHeaders('sk-abc')).toEqual({
      Authorization: 'Bearer sk-abc',
      'X-Platform-User-Id': 'user-uuid-1',
      'X-Project-Id': '346',
      'X-Producer-Project-Id': '82',
    })
  })

  /**
   * 缺池或缺登录时**只回 Authorization,不发空串头**。
   *
   * `X-Platform-User-Id: ''` 与不发是两回事:前者会让上游把空串当成一个合法的
   * 归属值写进去,与今天的坏状态一样查不到,却更难在事后分辨「没带头」和
   * 「带了个空的」。
   *
   * 仍然回 Authorization 而不是整个失败:请求该不该发是调用方的决定,
   * 这一层只负责「要发的话,头长什么样」。
   */
  it('没选池时只回 Authorization,不发空串归属', async () => {
    const m = await import('../gatewayToken')
    m.setActivePool(null)
    expect(m.gatewayPlatformHeaders('sk-abc')).toEqual({ Authorization: 'Bearer sk-abc' })
  })

  it('没登录时同理', async () => {
    const m = await import('../gatewayToken')
    m.setActivePool({ projectId: 345, producerProjectId: null })
    cred.current = null
    expect(m.gatewayPlatformHeaders('sk-abc')).toEqual({ Authorization: 'Bearer sk-abc' })
  })
})
