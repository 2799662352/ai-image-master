/**
 * attachmentsIpc — 扩展名白名单回归测试。
 *
 * `attachments:read-thumb` 是导演台 agent「本地路径 → blob:」链路的唯一入口
 * (resolveAssetUrl → resolveMediaSrcOnce → readThumb)。白名单少一个扩展名,
 * agent 导对应本地文件就会被拒 —— MMD 系(vmd/pmx/pmd/zip)此前就缺席,
 * 逼得 agent 自开静态 HTTP 服务绕行。这里锁死:
 *
 *   1. 3D/MMD 资产扩展名(glb/gltf/fbx/json/vmd/pmx/pmd/zip)可读。
 *   2. 无扩展名 / 未知扩展名仍被拒(exfiltration 防线不因扩容而松动)。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

import { handleReadThumb } from '../attachmentsIpc'

let dir: string

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'att-ipc-'))
})

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function writeTmp(name: string): Promise<string> {
  const p = path.join(dir, name)
  await fs.writeFile(p, Buffer.from([1, 2, 3, 4]))
  return p
}

describe('attachments:read-thumb 扩展名白名单', () => {
  it.each([
    ['model.glb', 'model/gltf-binary'],
    ['anim.fbx', 'application/octet-stream'],
    ['dance.vmd', 'application/octet-stream'],
    ['miku.pmx', 'application/octet-stream'],
    ['old.pmd', 'application/octet-stream'],
    ['miku-textures.zip', 'application/zip'],
  ])('%s 可读且 mime 正确', async (name, mime) => {
    const res = await handleReadThumb(await writeTmp(name))
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.mime).toBe(mime)
  })

  it('无扩展名(如 ssh 私钥)与未知扩展名仍被拒', async () => {
    const noExt = await handleReadThumb(await writeTmp('id_rsa'))
    expect(noExt).toEqual({ ok: false, reason: 'mime whitelist: extension not allowed' })

    const exe = await handleReadThumb(await writeTmp('payload.exe'))
    expect(exe.ok).toBe(false)
  })
})
