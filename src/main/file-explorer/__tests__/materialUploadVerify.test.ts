// @vitest-environment node
//
// 工作台素材「预传地址」落库后的体检:重启后还能不能信那个缓存的 COS 地址。
//
// 之前 `uploadedUrl` 一律不落库,理由是「不知道桶会不会清文件、本地文件有没有被改」。
// 现在落库了,这两件事就必须在**用之前**当场确认,否则:
// - 本地文件被编辑过 → 提交的是旧字节(静默出错的那种,最难查);
// - COS 对象没了 → 拿死链去提交,重试还是同一个死链,这张卡永久废掉。
//
// 判定的底线(也是这份测试钉住的):**拿不准就丢掉缓存**。丢掉的代价只是回到「提交
// 时主进程从本地路径现传」的老行为,慢一点但一定对;留着一个不确定的地址才有风险。
// 唯一的例外是「本地文件没变、但云端暂时探不通(断网 / 5xx)」—— 这时丢掉意味着
// 对一个几 GB 的视频白白重传,所以保留。

import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  verifyUploadedMaterials,
  type UploadedMaterialProbe,
} from '../materialUploadVerify'

const COS = 'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/image-history/a.png'

let dir: string
let file: string

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'vw-verify-'))
  file = path.join(dir, 'a.png')
  writeFileSync(file, Buffer.from('12345678'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function probeFor(overrides: Partial<UploadedMaterialProbe> = {}): UploadedMaterialProbe {
  const s = statSync(file)
  return {
    src: file,
    uploadedUrl: COS,
    uploadedFrom: { src: file, size: s.size, mtimeMs: s.mtimeMs },
    ...overrides,
  }
}

function headReturning(status: number) {
  return vi.fn(async () => ({ status }) as { status: number })
}

describe('本地文件指纹', () => {
  it('大小和修改时间都没变 → same,保留(不碰网络)', async () => {
    const head = headReturning(200)
    const [v] = await verifyUploadedMaterials([probeFor()], { checkRemote: false }, { head })
    expect(v).toMatchObject({ keep: true, local: 'same', remote: 'skipped' })
    expect(head).not.toHaveBeenCalled()
  })

  it('文件被改过(大小变了)→ changed,丢掉缓存地址 —— 否则会提交旧字节', async () => {
    const [v] = await verifyUploadedMaterials(
      [probeFor({ uploadedFrom: { src: file, size: 999, mtimeMs: statSync(file).mtimeMs } })],
      { checkRemote: false },
      { head: headReturning(200) },
    )
    expect(v).toMatchObject({ keep: false, local: 'changed' })
  })

  it('大小没变但修改时间变了 → 同样判 changed(原地覆盖保存的常见情形)', async () => {
    const s = statSync(file)
    const [v] = await verifyUploadedMaterials(
      [probeFor({ uploadedFrom: { src: file, size: s.size, mtimeMs: s.mtimeMs - 60_000 } })],
      { checkRemote: false },
      { head: headReturning(200) },
    )
    expect(v).toMatchObject({ keep: false, local: 'changed' })
  })

  it('指纹绑的是另一个路径(src 被换过)→ changed,别把 A 的地址挂在 B 身上', async () => {
    const other = path.join(dir, 'b.png')
    const [v] = await verifyUploadedMaterials(
      [probeFor({ src: other })],
      { checkRemote: false },
      { head: headReturning(200) },
    )
    expect(v).toMatchObject({ keep: false, local: 'changed' })
  })

  it('没有指纹(旧数据 / 主进程当时没取到)→ unverifiable,保守丢掉', async () => {
    const [v] = await verifyUploadedMaterials(
      [probeFor({ uploadedFrom: undefined })],
      { checkRemote: false },
      { head: headReturning(200) },
    )
    expect(v).toMatchObject({ keep: false, local: 'unverifiable' })

    const [v2] = await verifyUploadedMaterials(
      [probeFor({ uploadedFrom: { src: file } })],
      { checkRemote: false },
      { head: headReturning(200) },
    )
    expect(v2).toMatchObject({ keep: false, local: 'unverifiable' })
  })

  it('本地文件没了(被 7 天清理扫掉 / 换了机器)→ missing,但云端地址照留 —— 它正是这时候的唯一来源', async () => {
    const gone = path.join(dir, 'gone.png')
    const [v] = await verifyUploadedMaterials(
      [probeFor({ src: gone, uploadedFrom: { src: gone, size: 8, mtimeMs: 1 } })],
      { checkRemote: false },
      { head: headReturning(200) },
    )
    expect(v).toMatchObject({ keep: true, local: 'missing' })
  })

  it('修改时间差 ≤1ms 不算变(不同文件系统取整)', async () => {
    const s = statSync(file)
    const [v] = await verifyUploadedMaterials(
      [probeFor({ uploadedFrom: { src: file, size: s.size, mtimeMs: s.mtimeMs + 0.4 } })],
      { checkRemote: false },
      { head: headReturning(200) },
    )
    expect(v).toMatchObject({ keep: true, local: 'same' })
  })

  it('真的改了文件(utimes)→ 探测得出', async () => {
    const f2 = path.join(dir, 'c.png')
    writeFileSync(f2, Buffer.from('abcd'))
    const before = statSync(f2)
    const p: UploadedMaterialProbe = {
      src: f2,
      uploadedUrl: COS,
      uploadedFrom: { src: f2, size: before.size, mtimeMs: before.mtimeMs },
    }
    expect((await verifyUploadedMaterials([p], { checkRemote: false }, { head: headReturning(200) }))[0].keep).toBe(true)

    const later = new Date(before.mtimeMs + 5_000)
    utimesSync(f2, later, later)
    expect((await verifyUploadedMaterials([p], { checkRemote: false }, { head: headReturning(200) }))[0]).toMatchObject({
      keep: false,
      local: 'changed',
    })
  })
})

describe('云端探活(HEAD)', () => {
  it('200 → alive,保留', async () => {
    const [v] = await verifyUploadedMaterials([probeFor()], { checkRemote: true }, { head: headReturning(200) })
    expect(v).toMatchObject({ keep: true, remote: 'alive' })
  })

  it('404 / 403 / 410 → dead,丢掉缓存地址(提交时回落本地路径重传)', async () => {
    for (const status of [404, 403, 410]) {
      const [v] = await verifyUploadedMaterials([probeFor()], { checkRemote: true }, { head: headReturning(status) })
      expect(v, `HTTP ${status}`).toMatchObject({ keep: false, remote: 'dead' })
    }
  })

  it('5xx / 抛错(断网、超时)→ unknown;本地没变就保留 —— 别因为一次抖动重传几 GB', async () => {
    const [a] = await verifyUploadedMaterials([probeFor()], { checkRemote: true }, { head: headReturning(503) })
    expect(a).toMatchObject({ keep: true, remote: 'unknown', local: 'same' })

    const boom = vi.fn(async () => {
      throw new Error('ENETUNREACH')
    })
    const [b] = await verifyUploadedMaterials([probeFor()], { checkRemote: true }, { head: boom })
    expect(b).toMatchObject({ keep: true, remote: 'unknown' })
  })

  it('本地没了 + 云端也死了 → 丢掉(没有任何可用来源,交给提交时报「文件不存在」)', async () => {
    const gone = path.join(dir, 'gone2.png')
    const [v] = await verifyUploadedMaterials(
      [probeFor({ src: gone, uploadedFrom: { src: gone, size: 8, mtimeMs: 1 } })],
      { checkRemote: true },
      { head: headReturning(404) },
    )
    expect(v).toMatchObject({ keep: false, local: 'missing', remote: 'dead' })
  })

  it('不是本应用自己的 COS 地址(非 https / 外部域名)→ 不探测、直接丢 —— 这个 IPC 不能被当成任意 URL 探测器', async () => {
    const head = headReturning(200)
    for (const url of ['http://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/a.png', 'https://evil.example.com/a.png', 'file:///etc/passwd', 'not a url']) {
      const [v] = await verifyUploadedMaterials([probeFor({ uploadedUrl: url })], { checkRemote: true }, { head })
      expect(v, url).toMatchObject({ keep: false })
    }
    expect(head).not.toHaveBeenCalled()
  })

  it('同一个地址只探一次(批量里很常见)', async () => {
    const head = headReturning(200)
    await verifyUploadedMaterials([probeFor(), probeFor(), probeFor()], { checkRemote: true }, { head })
    expect(head).toHaveBeenCalledTimes(1)
  })

  it('checkRemote:false 时一次网络都不发', async () => {
    const head = headReturning(200)
    await verifyUploadedMaterials([probeFor()], { checkRemote: false }, { head })
    expect(head).not.toHaveBeenCalled()
  })
})

describe('输入防御', () => {
  it('结果与输入一一对应、顺序不变;坏条目只影响自己', async () => {
    const out = await verifyUploadedMaterials(
      [probeFor(), { src: 1, uploadedUrl: null } as unknown as UploadedMaterialProbe, probeFor()],
      { checkRemote: false },
      { head: headReturning(200) },
    )
    expect(out.map((v) => v.keep)).toEqual([true, false, true])
  })
})
