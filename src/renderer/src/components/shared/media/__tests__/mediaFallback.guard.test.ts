/**
 * guardThumbCandidates —— 「缩略图位置不许加载原图」的候选链整理。
 *
 * 链里的远程 / 内联原图(自家 COS 裸链接、带签名的直出链接、别家 CDN、data: 内联图)
 * 不能直接交给 <img>:那等于把整张原图下载并解码进 80px 的框。它们改写成
 * `remote-thumb:`(主进程下载并缩小),并且排到所有便宜的候选(缩略链接、本地副本)后面。
 */
import { describe, expect, it } from 'vitest'
import {
  REMOTE_THUMB_PREFIX,
  guardThumbCandidates,
  parseRemoteThumbSrc,
  toRemoteThumbSrc,
} from '../mediaFallback'

const BUCKET = 'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com'
const HISTORY = `${BUCKET}/image-history/2026/11/17/abc.png`
const HISTORY_PERSISTED = `${BUCKET}/image-history/2026/11/17/abc.thumb512.webp`
const HISTORY_LIVE = `${HISTORY}?imageMogr2/thumbnail/512x512%3E/format/webp/quality/85/ignore-error/1`
const OLD_HISTORY = `${BUCKET}/image-history/2026/08/01/old.png` // 日期闸之前:没有持久化缩略图
const OLD_HISTORY_LIVE = `${OLD_HISTORY}?imageMogr2/thumbnail/512x512%3E/format/webp/quality/85/ignore-error/1`
const SIGNED = `${BUCKET}/x.png?q-sign-algorithm=sha1&q-ak=AKID&q-sign-time=1900000000;1900003600&q-signature=abc`
const R2 = 'https://pub-abc.r2.dev/gen/1.png'
const LOCAL = 'local-file:///C:/out/a.png'

describe('toRemoteThumbSrc / parseRemoteThumbSrc', () => {
  it('互为逆运算', () => {
    expect(parseRemoteThumbSrc(toRemoteThumbSrc(R2))).toBe(R2)
    expect(toRemoteThumbSrc(R2)).toBe(`${REMOTE_THUMB_PREFIX}${R2}`)
  })

  it('带查询串的地址原样还原(签名参数一个字符都不能少)', () => {
    expect(parseRemoteThumbSrc(toRemoteThumbSrc(SIGNED))).toBe(SIGNED)
  })

  it('不是这个前缀 / 前缀后面没东西 → null', () => {
    expect(parseRemoteThumbSrc(R2)).toBeNull()
    expect(parseRemoteThumbSrc(LOCAL)).toBeNull()
    expect(parseRemoteThumbSrc('')).toBeNull()
    expect(parseRemoteThumbSrc(REMOTE_THUMB_PREFIX)).toBeNull()
    expect(parseRemoteThumbSrc(undefined as unknown as string)).toBeNull()
  })
})

describe('guardThumbCandidates — 原图改走主进程', () => {
  it('别家 CDN 的原图:只剩主进程缩略这一条', () => {
    expect(guardThumbCandidates([R2])).toEqual([toRemoteThumbSrc(R2)])
  })

  it('带签名的直出链接(拼缩略参数会让签名失效):不拼参数,只走主进程缩略', () => {
    expect(guardThumbCandidates([SIGNED])).toEqual([toRemoteThumbSrc(SIGNED)])
  })

  it('自家 COS 裸链接:先补出持久化缩略图与实时缩略,原图排最后', () => {
    expect(guardThumbCandidates([HISTORY])).toEqual([HISTORY_PERSISTED, HISTORY_LIVE, toRemoteThumbSrc(HISTORY)])
  })

  it('日期闸之前的老图:没有持久化缩略图,只补实时缩略', () => {
    expect(guardThumbCandidates([OLD_HISTORY])).toEqual([OLD_HISTORY_LIVE, toRemoteThumbSrc(OLD_HISTORY)])
  })

  it('data: 内联图 → 主进程缩略', () => {
    const data = 'data:image/png;base64,iVBORw0KGgo='
    expect(guardThumbCandidates([data])).toEqual([toRemoteThumbSrc(data)])
  })

  it('自己的缩略形态(持久化缩略图 / imageMogr2 缩略链接)原样保留,不绕主进程', () => {
    expect(guardThumbCandidates([HISTORY_PERSISTED, HISTORY_LIVE])).toEqual([HISTORY_PERSISTED, HISTORY_LIVE])
  })

  it('本地路径 / local-file / file / blob / http 原样保留', () => {
    const keep = [LOCAL, 'file:///C:/out/b.png', 'C:\\out\\c.png', '/home/u/d.png', 'blob:https://app/uuid', 'http://10.0.0.5/e.png']
    expect(guardThumbCandidates(keep)).toEqual(keep)
  })

  it('SVG 是矢量文本:https .svg(含带查询串的)与 data:image/svg+xml 都直接给浏览器', () => {
    const svgs = [`${BUCKET}/a.svg`, `${BUCKET}/b.SVG?v=2`, 'data:image/svg+xml;base64,PHN2Zy8+']
    expect(guardThumbCandidates(svgs)).toEqual(svgs)
  })
})

describe('guardThumbCandidates — 顺序', () => {
  it('缩略链接 → 本地副本 → 主进程缩略的原图(本地有就根本不下载)', () => {
    // 这正是 ArtifactCard 生成的链:[持久化, 实时, 裸 URL, ...本地副本]
    const out = guardThumbCandidates([HISTORY_PERSISTED, HISTORY_LIVE, HISTORY, LOCAL])
    expect(out).toEqual([HISTORY_PERSISTED, HISTORY_LIVE, LOCAL, toRemoteThumbSrc(HISTORY)])
  })

  it('多条原图:保持它们之间的相对顺序,都排在非原图后面', () => {
    const out = guardThumbCandidates([R2, LOCAL, SIGNED, 'local-file:///C:/out/b.png'])
    expect(out).toEqual([LOCAL, 'local-file:///C:/out/b.png', toRemoteThumbSrc(R2), toRemoteThumbSrc(SIGNED)])
  })

  it('链里一条原图都没有 → 原样返回', () => {
    expect(guardThumbCandidates([HISTORY_LIVE, LOCAL])).toEqual([HISTORY_LIVE, LOCAL])
  })

  it('空链 → 空链', () => {
    expect(guardThumbCandidates([])).toEqual([])
  })

  it('重复项只留第一次出现', () => {
    expect(guardThumbCandidates([R2, LOCAL, R2, LOCAL])).toEqual([LOCAL, toRemoteThumbSrc(R2)])
    // 补出来的缩略形态与链里已有的重复时也去重
    expect(guardThumbCandidates([HISTORY_LIVE, HISTORY])).toEqual([HISTORY_LIVE, HISTORY_PERSISTED, toRemoteThumbSrc(HISTORY)])
  })

  it('幂等:整理过的链再整理一次不变', () => {
    const once = guardThumbCandidates([HISTORY, R2, LOCAL, SIGNED])
    expect(guardThumbCandidates(once)).toEqual(once)
  })

  it('整理后的链里没有任何一条是 https / data: 原图', () => {
    const out = guardThumbCandidates([HISTORY, R2, SIGNED, 'data:image/jpeg;base64,/9j/4AAQ', LOCAL, HISTORY_LIVE])
    for (const c of out) {
      const isRawRemote = /^https:/i.test(c) && !/imageMogr2\/thumbnail\/|\.thumb\d+\.webp$/.test(c)
      const isRawInline = /^data:image\//i.test(c)
      expect(isRawRemote || isRawInline, c).toBe(false)
    }
  })
})
