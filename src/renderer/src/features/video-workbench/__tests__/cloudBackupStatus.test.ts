// 状态行:每一种「没备份上」的情形都要明说,不能只在成功时才有一行字。
import { describe, expect, it } from 'vitest'
import type { BackupPassResult } from '../cloudBackup'
import { describeBackupStatus, type BackupStatusInput } from '../cloudBackupStatus'

const result = (over: Partial<BackupPassResult> = {}): BackupPassResult => ({
  uploaded: 0, unchanged: 0, empty: 0, localOnly: 0, failures: [], stopped: null, ...over,
})

const base: BackupStatusInput = {
  available: true, authenticated: true, enabled: true, running: false, pending: false, last: null, lastError: null, ago: '',
}
const line = (over: Partial<BackupStatusInput>) => describeBackupStatus({ ...base, ...over })

describe('describeBackupStatus', () => {
  it('没通道 / 没登录:明说不能备份,而不是沉默', () => {
    expect(line({ available: false })).toMatchObject({ tone: 'warn' })
    expect(line({ authenticated: false }).text).toContain('登录')
    // 没登录压过一切(包括过期的上一轮结果)
    expect(line({ authenticated: false, last: result({ uploaded: 3 }) }).text).toContain('登录')
  })

  it('正在备份压过旧结果与旧错误', () => {
    expect(line({ running: true, lastError: 'x', last: result({ stopped: 'NETWORK' }) }).text).toBe('正在备份…')
  })

  it('各种中止原因各有一句:服务端没开要说「没有备份任何内容」', () => {
    expect(line({ last: result({ stopped: 'NOT_CONFIGURED' }) })).toMatchObject({ tone: 'warn' })
    expect(line({ last: result({ stopped: 'NOT_CONFIGURED' }) }).text).toContain('没有备份任何内容')
    expect(line({ last: result({ stopped: 'NETWORK' }) }).text).toContain('网络')
    expect(line({ last: result({ stopped: 'SERVER' }) }).text).toContain('暂时不可用')
    expect(line({ last: result({ stopped: 'NOT_AUTHENTICATED' }) }).text).toContain('失效')
  })

  it('单部失败:太大 / 剧数超限点名,别的带服务端原因;多部时提示还有几部', () => {
    const tooLarge = line({
      last: result({ failures: [{ dramaId: 'a', name: '大剧', code: 'TOO_LARGE', message: 'x' }, { dramaId: 'b', name: 'B', code: 'NETWORK', message: 'y' }] }),
    })
    expect(tooLarge.tone).toBe('error')
    expect(tooLarge.text).toContain('「大剧」太大')
    expect(tooLarge.text).toContain('另有 1 部')
    expect(line({ last: result({ failures: [{ dramaId: 'a', name: 'A', code: 'TOO_MANY', message: '' }] }) }).text).toContain('300')
    expect(line({ last: result({ failures: [{ dramaId: 'a', name: 'A', code: 'INVALID', message: '格式不对' }] }) }).text).toContain('格式不对')
  })

  it('开关关了:说明是关的(优先于「有改动稍后备份」)', () => {
    expect(line({ enabled: false, pending: true }).text).toContain('已关闭')
  })

  it('有改动待传:说稍后备份', () => {
    expect(line({ pending: true, last: result({ uploaded: 1 }) }).text).toContain('稍后')
  })

  it('成功:区分上传了几部 / 内容没变;有本机素材没带上时如实告知', () => {
    expect(line({ last: result({ uploaded: 2 }), ago: '刚刚' })).toMatchObject({ tone: 'ok', text: '已备份,本次上传 2 部(刚刚)。' })
    expect(line({ last: result({ unchanged: 2 }) }).text).toBe('已备份,内容没有变化。')
    const withLocal = line({ last: result({ unchanged: 1, localOnly: 4 }) }).text
    expect(withLocal).toContain('4 个素材')
    expect(withLocal).toContain('导出当前剧')
  })

  it('从没跑过:提示会自动开始', () => {
    expect(line({}).text).toContain('还没有备份过')
  })
})
