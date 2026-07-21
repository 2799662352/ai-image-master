import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AUDIO_HISTORY_DIRNAME,
  audioHistoryDir,
  extensionForFormat,
  isInsideAudioHistoryDir,
  saveAudioHistoryFile,
  readAudioHistoryFile,
  deleteAudioHistoryFile,
} from '../audioHistoryFiles'

describe('audioHistoryFiles', () => {
  let userDataDir: string

  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-hist-'))
  })

  afterEach(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true })
  })

  it('maps formats to safe extensions (ogg_opus → ogg, unknown → mp3)', () => {
    expect(extensionForFormat('mp3')).toBe('mp3')
    expect(extensionForFormat('ogg_opus')).toBe('ogg')
    expect(extensionForFormat('wav')).toBe('wav')
    expect(extensionForFormat('pcm')).toBe('pcm')
    expect(extensionForFormat('weird')).toBe('mp3')
    expect(extensionForFormat('')).toBe('mp3')
  })

  it('save → read round-trips bytes inside the audio-history dir', async () => {
    const base64 = Buffer.from('hello audio').toString('base64')
    const saved = await saveAudioHistoryFile(userDataDir, base64, 'mp3')
    expect(saved.success).toBe(true)
    if (!saved.success) return

    expect(saved.filePath.startsWith(audioHistoryDir(userDataDir))).toBe(true)
    expect(saved.filePath.endsWith('.mp3')).toBe(true)

    const read = await readAudioHistoryFile(userDataDir, saved.filePath)
    expect(read).toEqual({ success: true, base64 })
  })

  it('delete removes the file and tolerates repeat deletes', async () => {
    const saved = await saveAudioHistoryFile(userDataDir, Buffer.from('x').toString('base64'), 'wav')
    if (!saved.success) throw new Error('save failed')

    expect((await deleteAudioHistoryFile(userDataDir, saved.filePath)).success).toBe(true)
    expect(fs.existsSync(saved.filePath)).toBe(false)
    // rm force:true → 幂等
    expect((await deleteAudioHistoryFile(userDataDir, saved.filePath)).success).toBe(true)
  })

  it('read/delete refuse paths outside the audio-history dir (renderer sandbox)', async () => {
    const outside = path.join(userDataDir, 'secret.txt')
    fs.writeFileSync(outside, 'secret')

    const read = await readAudioHistoryFile(userDataDir, outside)
    expect(read.success).toBe(false)
    if (!read.success) expect(read.error).toContain('outside')

    const traversal = path.join(audioHistoryDir(userDataDir), '..', 'secret.txt')
    expect((await readAudioHistoryFile(userDataDir, traversal)).success).toBe(false)
    expect((await deleteAudioHistoryFile(userDataDir, traversal)).success).toBe(false)
    expect(fs.existsSync(outside)).toBe(true)
  })

  it('isInsideAudioHistoryDir is a strict prefix check on the resolved dir', () => {
    const inside = path.join(userDataDir, AUDIO_HISTORY_DIRNAME, 'a.mp3')
    expect(isInsideAudioHistoryDir(userDataDir, inside)).toBe(true)
    // 同级前缀目录(audio-history-evil)不得放行
    const sibling = path.join(userDataDir, `${AUDIO_HISTORY_DIRNAME}-evil`, 'a.mp3')
    expect(isInsideAudioHistoryDir(userDataDir, sibling)).toBe(false)
  })

  it('save rejects empty payloads', async () => {
    const saved = await saveAudioHistoryFile(userDataDir, '', 'mp3')
    expect(saved.success).toBe(false)
  })
})
