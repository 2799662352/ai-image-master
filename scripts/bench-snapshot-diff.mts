/**
 * 量一下 diffSnapshots 在几种真实形态下的主进程占用。一次性脚本,不进构建。
 * 跑法: npx tsx scripts/bench-snapshot-diff.mts
 */
import { diffSnapshots } from '../src/main/agent/snapshotDiff'
import type { Snapshot } from '../src/main/agent/workspaceSnapshot'

function snap(files: Record<string, string>): Snapshot {
  return { files: new Map(Object.entries(files)), skipped: new Set(), complete: true }
}

function lines(n: number, seed: string): string {
  return Array.from({ length: n }, (_, i) => `${seed} line ${i} lorem ipsum dolor sit amet`).join('\n')
}

/** 小改:只动其中 3 行。 */
function tweak(text: string): string {
  const ls = text.split('\n')
  for (const i of [1, Math.floor(ls.length / 2), ls.length - 2]) ls[i] = `CHANGED ${ls[i]}`
  return ls.join('\n')
}

function bench(label: string, before: Snapshot, after: Snapshot) {
  const t0 = performance.now()
  const out = diffSnapshots(before, after)
  const ms = performance.now() - t0
  const stalled = out.filter((c) => c.diff.includes('差异过大')).length
  console.log(
    `${label.padEnd(44)} ${ms.toFixed(0).padStart(6)} ms   ${String(out.length).padStart(4)} 个改动` +
      (stalled ? `   (${stalled} 个渲染超时降级)` : ''),
  )
}

// A. 典型:20 个文件,每个 500 行,各改 3 行
{
  const b: Record<string, string> = {}
  const a: Record<string, string> = {}
  for (let i = 0; i < 20; i++) {
    const t = lines(500, `f${i}`)
    b[`/w/a${i}.ts`] = t
    a[`/w/a${i}.ts`] = tweak(t)
  }
  bench('A 典型 20 文件 x 500 行,各改 3 行', snap(b), snap(a))
}

// B. prettier --write . 形态:200 个文件,每个 500 行,各改 3 行
{
  const b: Record<string, string> = {}
  const a: Record<string, string> = {}
  for (let i = 0; i < 200; i++) {
    const t = lines(500, `f${i}`)
    b[`/w/b${i}.ts`] = t
    a[`/w/b${i}.ts`] = tweak(t)
  }
  bench('B 200 文件 x 500 行,各改 3 行', snap(b), snap(a))
}

// C. 病态:单个 5000 行文件被整份重写(每行都不同)
{
  const before = lines(5000, 'old')
  const after = lines(5000, 'new')
  bench('C 单文件 5000 行整份重写', snap({ '/w/c.json': before }), snap({ '/w/c.json': after }))
}

// D. 最坏:20 个 5000 行文件全部整份重写
{
  const b: Record<string, string> = {}
  const a: Record<string, string> = {}
  for (let i = 0; i < 20; i++) {
    b[`/w/d${i}.json`] = lines(5000, `old${i}`)
    a[`/w/d${i}.json`] = lines(5000, `new${i}`)
  }
  bench('D 20 个 5000 行文件全部整份重写', snap(b), snap(a))
}

// E. 逼近单文件上限:256KB 单行(压缩产物形态)
{
  const before = 'x'.repeat(250 * 1024)
  const after = 'y'.repeat(250 * 1024)
  bench('E 250KB 单行整份替换', snap({ '/w/e.min.js': before }), snap({ '/w/e.min.js': after }))
}
