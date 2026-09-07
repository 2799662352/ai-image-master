import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() },
  app: { getPath: () => '' },
}))

import {
  PROJECT_FILE_IO_MAX_BYTES,
  defaultProjectFilePath,
  readProjectFileText,
  safeProjectFileName,
  writeProjectFileAtomic,
} from '../projectFileIpc'

let tmp: string
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-project-file-'))
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('safeProjectFileName / defaultProjectFilePath', () => {
  it('去掉文件系统不接受的字符与控制字符,空名回退,过长截断,后缀固定', () => {
    expect(safeProjectFileName('追车戏 · 夜景')).toBe('追车戏 · 夜景.catwb.json')
    expect(safeProjectFileName('a/b\\c:d*e?f"g<h>i|j\u0000k')).toBe('abcdefghijk.catwb.json')
    expect(safeProjectFileName('   ')).toBe('工程.catwb.json')
    expect(safeProjectFileName('.')).toBe('工程.catwb.json')
    expect(safeProjectFileName('x'.repeat(200))).toBe(`${'x'.repeat(80)}.catwb.json`)
  })

  it('默认落在 文档/CATIMATION 工程/ 下', () => {
    expect(defaultProjectFilePath('D:\\Docs', '追车戏')).toBe(path.join('D:\\Docs', 'CATIMATION 工程', '追车戏.catwb.json'))
  })
})

describe('writeProjectFileAtomic', () => {
  it('建目录、写临时文件、rename 到位;目录里不留临时文件', async () => {
    const target = path.join(tmp, 'sub', 'a.catwb.json')
    const r = await writeProjectFileAtomic(target, '{"a":1}')
    expect(r).toEqual({ ok: true, path: target })
    expect(await fs.readFile(target, 'utf8')).toBe('{"a":1}')
    expect(await fs.readdir(path.join(tmp, 'sub'))).toEqual(['a.catwb.json'])
  })

  it('rename 失败 → 删掉临时文件,目标不存在,返回原因(不留半个文件)', async () => {
    const target = path.join(tmp, 'b.catwb.json')
    const r = await writeProjectFileAtomic(target, '{"a":1}', {
      rename: async () => { throw new Error('disk yanked') },
    })
    expect(r).toEqual({ ok: false, reason: 'disk yanked' })
    expect(await fs.readdir(tmp)).toEqual([])
  })

  it('拒绝非 .catwb.json 后缀与超闸内容', async () => {
    expect(await writeProjectFileAtomic(path.join(tmp, 'x.json'), '{}')).toMatchObject({ ok: false })
    expect(await writeProjectFileAtomic(path.join(tmp, 'x.catwb.json'), 'x'.repeat(PROJECT_FILE_IO_MAX_BYTES + 1))).toMatchObject({ ok: false })
    expect(await fs.readdir(tmp)).toEqual([])
  })
})

describe('readProjectFileText', () => {
  it('读回文本;不存在 / 后缀不对 / 超闸各给 code', async () => {
    const p = path.join(tmp, 'c.catwb.json')
    await fs.writeFile(p, '{"ok":true}', 'utf8')
    expect(await readProjectFileText(p)).toEqual({ ok: true, path: p, text: '{"ok":true}' })
    expect(await readProjectFileText(path.join(tmp, 'missing.catwb.json'))).toMatchObject({ ok: false, code: 'not-found' })
    expect(await readProjectFileText(path.join(tmp, 'c.txt'))).toMatchObject({ ok: false, code: 'not-project-file' })
    const big = path.join(tmp, 'big.catwb.json')
    await fs.writeFile(big, 'x'.repeat(16), 'utf8')
    expect(await readProjectFileText(big, 8)).toMatchObject({ ok: false, code: 'too-large' })
  })
})
