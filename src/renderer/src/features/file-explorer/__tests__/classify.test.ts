import { describe, it, expect } from 'vitest'
import { classify, TEXT_EDIT_LIMIT } from '../classify'

describe('classify', () => {
  it('classifies png as image regardless of mime', () => {
    expect(classify('a.PNG', 100)).toBe('image')
  })

  it('classifies avif and ico as images', () => {
    expect(classify('a.avif', 100)).toBe('image')
    expect(classify('favicon.ico', 100)).toBe('image')
  })

  it('classifies video files as video', () => {
    expect(classify('clip.mp4', 100)).toBe('video')
    expect(classify('clip.webm', 100)).toBe('video')
    expect(classify('clip.mov', 100)).toBe('video')
  })

  it('uses mime when given to classify video', () => {
    expect(classify('weirdname', 100, 'video/mp4')).toBe('video')
  })

  it('classifies pdf as pdf', () => {
    expect(classify('a.pdf', 100)).toBe('pdf')
  })

  it('classifies ts as text', () => {
    expect(classify('foo.ts', 100)).toBe('text')
  })

  it('classifies extensionless as text', () => {
    expect(classify('Makefile', 100)).toBe('text')
  })

  it('classifies file > TEXT_EDIT_LIMIT as binary even if extension is text', () => {
    expect(classify('big.log', TEXT_EDIT_LIMIT + 1)).toBe('binary')
  })

  it('classifies unknown extension as binary', () => {
    expect(classify('a.dat', 100)).toBe('binary')
  })

  it('uses mime when given to classify image', () => {
    expect(classify('weirdname', 100, 'image/jpeg')).toBe('image')
  })

  // 音频此前落进 binary 分支 —— 界面只给一句「二进制文件」,连播都播不了,
  // 而这个应用本身就在不停地生成配音和音效。
  it('把音频认成 audio 而不是 binary', () => {
    for (const name of ['bgm.mp3', 'voice.WAV', 'a.flac', 'a.m4a', 'a.aac', 'a.opus', 'a.oga']) {
      expect(classify(name, 100), name).toBe('audio')
    }
  })

  it('mime 说了算(文件名没扩展名时)', () => {
    expect(classify('weirdname', 100, 'audio/mpeg')).toBe('audio')
  })

  // ogg 既是音频容器也是视频容器。判不准时按视频走:<video> 放纯音轨还能出声
  // (只是画面全黑),反过来 <audio> 放 ogv 就把画面整个丢了。
  it('ogg 归视频(容器歧义时选损失更小的一边)', () => {
    expect(classify('a.ogg', 100)).toBe('video')
  })

  it('超过体积上限的音频仍然是 audio —— 它本来就不进编辑器', () => {
    expect(classify('long.mp3', TEXT_EDIT_LIMIT + 1)).toBe('audio')
  })
})
