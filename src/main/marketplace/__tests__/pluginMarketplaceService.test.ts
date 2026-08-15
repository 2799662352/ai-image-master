import { createHash } from 'node:crypto'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { beforeEach, describe, expect, it } from 'vitest'

import { PluginMarketplaceService } from '../pluginMarketplaceService'
import type { PluginCatalog, PluginCatalogEntry } from '../pluginMarketplaceService'

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix))
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

/** Build a plugin zip with the real `<plugin>/skills/<name>/SKILL.md` layout. */
async function buildPluginZip(
  pluginName: string,
  skills: Record<string, string>,
  extraFiles: Record<string, string> = {},
): Promise<Buffer> {
  const zip = new JSZip()
  for (const [skillName, body] of Object.entries(skills)) {
    zip.file(`${pluginName}/skills/${skillName}/SKILL.md`, body)
  }
  for (const [rel, body] of Object.entries(extraFiles)) {
    zip.file(`${pluginName}/${rel}`, body)
  }
  return zip.generateAsync({ type: 'nodebuffer' })
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

function makeEntry(
  name: string,
  version: string,
  sha: string,
  url: string,
  skills = 1,
): PluginCatalogEntry {
  return { name, version, description: `desc ${name}`, skills, commands: 0, size: 0, sha256: sha, url }
}

function makeCatalog(entries: PluginCatalogEntry[]): PluginCatalog {
  return { schemaVersion: 1, generatedAt: new Date(0).toISOString(), plugins: entries }
}

function makeFetcher(
  catalog: PluginCatalog,
  blobs: Map<string, Buffer>,
): (url: string) => Promise<Buffer> {
  return async (url: string) => {
    if (url.endsWith('plugins-catalog.json') || url.endsWith('catalog.json')) {
      return Buffer.from(JSON.stringify(catalog), 'utf8')
    }
    const b = blobs.get(url)
    if (!b) throw new Error(`mock fetcher: no blob for ${url}`)
    return b
  }
}

describe('PluginMarketplaceService', () => {
  let userSkillsDir: string
  let stateFile: string

  beforeEach(async () => {
    userSkillsDir = await makeTempDir('mpp-userskills-')
    const stateDir = await makeTempDir('mpp-state-')
    stateFile = path.join(stateDir, 'plugin-marketplace-state.json')
  })

  it('install extracts every bundled skill into userSkillsDir and records them', async () => {
    const zipBuf = await buildPluginZip(
      'catimation-demo',
      {
        'skill-a': '---\nname: skill-a\n---\nA',
        'skill-b': '---\nname: skill-b\n---\nB',
      },
      { 'commands/demo.md': '# demo cmd', '.claude-plugin/plugin.json': '{}' },
    )
    const digest = sha256Hex(zipBuf)
    const entry = makeEntry(
      'catimation-demo',
      '1.0.0',
      digest,
      'https://example.com/plugins/catimation-demo-1.0.0.zip',
      2,
    )
    const svc = new PluginMarketplaceService({
      catalogUrl: 'https://example.com/plugins/plugins-catalog.json',
      userSkillsDir,
      stateFile,
      fetcher: makeFetcher(makeCatalog([entry]), new Map([[entry.url, zipBuf]])),
    })

    const record = await svc.install('catimation-demo')
    expect(record).toMatchObject({ name: 'catimation-demo', version: '1.0.0', sha256: digest })
    expect(record.skills).toEqual(['skill-a', 'skill-b'])

    // Skills landed where Codex discovery looks.
    expect(await readFile(path.join(userSkillsDir, 'skill-a', 'SKILL.md'), 'utf8')).toContain('skill-a')
    expect(await readFile(path.join(userSkillsDir, 'skill-b', 'SKILL.md'), 'utf8')).toContain('skill-b')
    // Commands/hooks are NOT installed into the skills dir.
    expect(await exists(path.join(userSkillsDir, 'commands'))).toBe(false)

    const state = JSON.parse(await readFile(stateFile, 'utf8'))
    expect(state.installed['catimation-demo'].skills).toEqual(['skill-a', 'skill-b'])
  })

  it('install rejects on sha256 mismatch and leaves no skill dirs behind', async () => {
    const zipBuf = await buildPluginZip('catimation-bad', { 'skill-x': '---\nname: skill-x\n---\nx' })
    const entry = makeEntry(
      'catimation-bad',
      '1.0.0',
      '0'.repeat(64),
      'https://example.com/plugins/catimation-bad-1.0.0.zip',
    )
    const svc = new PluginMarketplaceService({
      catalogUrl: 'https://example.com/plugins/plugins-catalog.json',
      userSkillsDir,
      stateFile,
      fetcher: makeFetcher(makeCatalog([entry]), new Map([[entry.url, zipBuf]])),
    })

    await expect(svc.install('catimation-bad')).rejects.toThrow(/sha256/i)
    expect(await exists(path.join(userSkillsDir, 'skill-x'))).toBe(false)
    expect(await exists(stateFile)).toBe(false)
  })

  it('install rejects when the plugin is not in the catalog', async () => {
    const svc = new PluginMarketplaceService({
      catalogUrl: 'https://example.com/plugins/plugins-catalog.json',
      userSkillsDir,
      stateFile,
      fetcher: makeFetcher(makeCatalog([]), new Map()),
    })
    await expect(svc.install('ghost')).rejects.toThrow(/not found/i)
  })

  it('uninstall removes exactly the skill dirs the plugin recorded, then drops state', async () => {
    const zipBuf = await buildPluginZip('catimation-demo', {
      'skill-a': '---\nname: skill-a\n---\nA',
      'skill-b': '---\nname: skill-b\n---\nB',
    })
    const entry = makeEntry(
      'catimation-demo',
      '1.0.0',
      sha256Hex(zipBuf),
      'https://example.com/plugins/catimation-demo-1.0.0.zip',
      2,
    )
    const svc = new PluginMarketplaceService({
      catalogUrl: 'https://example.com/plugins/plugins-catalog.json',
      userSkillsDir,
      stateFile,
      fetcher: makeFetcher(makeCatalog([entry]), new Map([[entry.url, zipBuf]])),
    })

    await svc.install('catimation-demo')
    await svc.uninstall('catimation-demo')

    expect(await exists(path.join(userSkillsDir, 'skill-a'))).toBe(false)
    expect(await exists(path.join(userSkillsDir, 'skill-b'))).toBe(false)
    const state = JSON.parse(await readFile(stateFile, 'utf8'))
    expect(state.installed['catimation-demo']).toBeUndefined()
  })

  it('uninstall of a never-installed plugin is a no-op (no throw)', async () => {
    const svc = new PluginMarketplaceService({
      catalogUrl: 'https://example.com/plugins/plugins-catalog.json',
      userSkillsDir,
      stateFile,
      fetcher: makeFetcher(makeCatalog([]), new Map()),
    })
    await expect(svc.uninstall('ghost')).resolves.not.toThrow()
  })

  it('install upgrade replaces skill content and re-records the version', async () => {
    const v1 = await buildPluginZip('catimation-demo', { 'skill-a': '---\nname: skill-a\n---\nV1' })
    const v2 = await buildPluginZip('catimation-demo', { 'skill-a': '---\nname: skill-a\n---\nV2' })
    const e1 = makeEntry('catimation-demo', '1.0.0', sha256Hex(v1), 'https://example.com/plugins/catimation-demo-1.0.0.zip')
    const e2 = makeEntry('catimation-demo', '1.1.0', sha256Hex(v2), 'https://example.com/plugins/catimation-demo-1.1.0.zip')
    let active = makeCatalog([e1])
    const blobs = new Map<string, Buffer>([
      [e1.url, v1],
      [e2.url, v2],
    ])
    const svc = new PluginMarketplaceService({
      catalogUrl: 'https://example.com/plugins/plugins-catalog.json',
      userSkillsDir,
      stateFile,
      fetcher: async (url) => {
        if (url.endsWith('catalog.json')) return Buffer.from(JSON.stringify(active), 'utf8')
        const b = blobs.get(url)
        if (!b) throw new Error(`no blob for ${url}`)
        return b
      },
    })

    await svc.install('catimation-demo')
    expect(await readFile(path.join(userSkillsDir, 'skill-a', 'SKILL.md'), 'utf8')).toContain('V1')

    active = makeCatalog([e2])
    await svc.fetchCatalog(true)
    const rec = await svc.install('catimation-demo')
    expect(rec.version).toBe('1.1.0')
    expect(await readFile(path.join(userSkillsDir, 'skill-a', 'SKILL.md'), 'utf8')).toContain('V2')
  })

  // 升级差集。没有这一步的话,插件删掉的 skill 会留在盘上永不更新,而台账被整条
  // 替换后连卸载都碰不到它 —— 既不更新也删不掉的孤儿。
  //
  // 我们需要显式对账,是因为 skill 装在一个**共享的平铺命名空间**里。Codex 自己的
  // 市场是 git 检出、`marketplace/upgrade` 整棵树替换,删除自动传播;逐条目安装的
  // (我们、Homebrew)只能自己对。
  it('upgrade removes skills the new version no longer ships', async () => {
    const v1 = await buildPluginZip('catimation-demo', {
      'skill-a': '---\nname: skill-a\n---\nA',
      'skill-gone': '---\nname: skill-gone\n---\nGONE',
    })
    const v2 = await buildPluginZip('catimation-demo', { 'skill-a': '---\nname: skill-a\n---\nA2' })
    const e1 = makeEntry('catimation-demo', '1.0.0', sha256Hex(v1), 'https://example.com/plugins/d-1.0.0.zip')
    const e2 = makeEntry('catimation-demo', '1.1.0', sha256Hex(v2), 'https://example.com/plugins/d-1.1.0.zip')
    let active = makeCatalog([e1])
    const blobs = new Map<string, Buffer>([[e1.url, v1], [e2.url, v2]])
    const svc = new PluginMarketplaceService({
      catalogUrl: 'https://example.com/plugins/plugins-catalog.json',
      userSkillsDir,
      stateFile,
      fetcher: async (url) => {
        if (url.endsWith('catalog.json')) return Buffer.from(JSON.stringify(active), 'utf8')
        const b = blobs.get(url)
        if (!b) throw new Error(`no blob for ${url}`)
        return b
      },
    })

    await svc.install('catimation-demo')
    expect(await exists(path.join(userSkillsDir, 'skill-gone'))).toBe(true)

    active = makeCatalog([e2])
    await svc.fetchCatalog(true)
    const rec = await svc.install('catimation-demo')

    expect(await exists(path.join(userSkillsDir, 'skill-gone'))).toBe(false)
    expect(await exists(path.join(userSkillsDir, 'skill-a'))).toBe(true)
    // 台账也不能再声称拥有它,否则卸载时会去删一个已经不存在的目录。
    expect(rec.skills).toEqual(['skill-a'])
  })

  it('upgrade does NOT remove a dropped skill that something else owns', async () => {
    // 与卸载共用同一份所有权判定:另一个插件或单技能台账占着的目录不能删,
    // 否则升级 A 会静默毁掉 B 管理的 skill。
    const v1 = await buildPluginZip('catimation-demo', {
      'skill-a': '---\nname: skill-a\n---\nA',
      'shared': '---\nname: shared\n---\nS',
    })
    const v2 = await buildPluginZip('catimation-demo', { 'skill-a': '---\nname: skill-a\n---\nA2' })
    const e1 = makeEntry('catimation-demo', '1.0.0', sha256Hex(v1), 'https://example.com/plugins/s-1.0.0.zip')
    const e2 = makeEntry('catimation-demo', '1.1.0', sha256Hex(v2), 'https://example.com/plugins/s-1.1.0.zip')
    let active = makeCatalog([e1])
    const blobs = new Map<string, Buffer>([[e1.url, v1], [e2.url, v2]])

    const skillStateFile = path.join(path.dirname(stateFile), 'marketplace-state.json')
    await writeFile(
      skillStateFile,
      JSON.stringify({ schemaVersion: 1, installed: { shared: { name: 'shared' } } }),
      'utf8',
    )

    const svc = new PluginMarketplaceService({
      catalogUrl: 'https://example.com/plugins/plugins-catalog.json',
      userSkillsDir,
      stateFile,
      skillStateFile,
      fetcher: async (url) => {
        if (url.endsWith('catalog.json')) return Buffer.from(JSON.stringify(active), 'utf8')
        const b = blobs.get(url)
        if (!b) throw new Error(`no blob for ${url}`)
        return b
      },
    })

    await svc.install('catimation-demo')
    active = makeCatalog([e2])
    await svc.fetchCatalog(true)
    await svc.install('catimation-demo')

    expect(await exists(path.join(userSkillsDir, 'shared'))).toBe(true)
  })

  it('uninstall keeps skill dirs the per-skill marketplace ledger owns (I2)', async () => {
    const zipBuf = await buildPluginZip('catimation-demo', {
      'skill-a': '---\nname: skill-a\n---\nA',
      'skill-b': '---\nname: skill-b\n---\nB',
    })
    const entry = makeEntry(
      'catimation-demo',
      '1.0.0',
      sha256Hex(zipBuf),
      'https://example.com/plugins/catimation-demo-1.0.0.zip',
      2,
    )
    // Per-skill ledger independently owns skill-a.
    const skillStateDir = await makeTempDir('mpp-skillstate-')
    const skillStateFile = path.join(skillStateDir, 'marketplace-state.json')
    await writeFile(
      skillStateFile,
      JSON.stringify({ schemaVersion: 1, installed: { 'skill-a': { name: 'skill-a' } } }),
      'utf8',
    )
    const svc = new PluginMarketplaceService({
      catalogUrl: 'https://example.com/plugins/plugins-catalog.json',
      userSkillsDir,
      stateFile,
      skillStateFile,
      fetcher: makeFetcher(makeCatalog([entry]), new Map([[entry.url, zipBuf]])),
    })

    await svc.install('catimation-demo')
    await svc.uninstall('catimation-demo')

    // skill-a survives (owned by the per-skill ledger); skill-b is removed.
    expect(await exists(path.join(userSkillsDir, 'skill-a'))).toBe(true)
    expect(await exists(path.join(userSkillsDir, 'skill-b'))).toBe(false)
  })

  it('install rejects a Zip Slip entry that escapes the extract root (I3)', async () => {
    const zip = new JSZip()
    zip.file('catimation-evil/skills/skill-a/SKILL.md', '---\nname: skill-a\n---\nA')
    zip.file('../../evil-marker.txt', 'pwned')
    const zipBuf = await zip.generateAsync({ type: 'nodebuffer' })
    const entry = makeEntry(
      'catimation-evil',
      '1.0.0',
      sha256Hex(zipBuf),
      'https://example.com/plugins/catimation-evil-1.0.0.zip',
    )
    const svc = new PluginMarketplaceService({
      catalogUrl: 'https://example.com/plugins/plugins-catalog.json',
      userSkillsDir,
      stateFile,
      fetcher: makeFetcher(makeCatalog([entry]), new Map([[entry.url, zipBuf]])),
    })
    await expect(svc.install('catimation-evil')).rejects.toThrow(/unsafe zip entry/i)
    expect(await exists(stateFile)).toBe(false)
  })

  it('a failed upgrade (bad new zip) preserves the previously installed version (I1)', async () => {
    const v1 = await buildPluginZip('catimation-demo', { 'skill-a': '---\nname: skill-a\n---\nV1' })
    // v2 carries a Zip Slip entry → extract throws before any swap.
    const v2zip = new JSZip()
    v2zip.file('catimation-demo/skills/skill-a/SKILL.md', '---\nname: skill-a\n---\nV2')
    v2zip.file('../../escape.txt', 'x')
    const v2 = await v2zip.generateAsync({ type: 'nodebuffer' })
    const e1 = makeEntry('catimation-demo', '1.0.0', sha256Hex(v1), 'https://example.com/plugins/catimation-demo-1.0.0.zip')
    const e2 = makeEntry('catimation-demo', '1.1.0', sha256Hex(v2), 'https://example.com/plugins/catimation-demo-1.1.0.zip')
    let active = makeCatalog([e1])
    const blobs = new Map<string, Buffer>([[e1.url, v1], [e2.url, v2]])
    const svc = new PluginMarketplaceService({
      catalogUrl: 'https://example.com/plugins/plugins-catalog.json',
      userSkillsDir,
      stateFile,
      fetcher: async (url) => {
        if (url.includes('catalog.json')) return Buffer.from(JSON.stringify(active), 'utf8')
        const b = blobs.get(url)
        if (!b) throw new Error(`no blob for ${url}`)
        return b
      },
    })

    await svc.install('catimation-demo')
    active = makeCatalog([e2])
    await svc.fetchCatalog(true)
    await expect(svc.install('catimation-demo')).rejects.toThrow(/unsafe zip entry/i)

    // Prior install intact: content still V1 and ledger still 1.0.0.
    expect(await readFile(path.join(userSkillsDir, 'skill-a', 'SKILL.md'), 'utf8')).toContain('V1')
    const state = JSON.parse(await readFile(stateFile, 'utf8'))
    expect(state.installed['catimation-demo'].version).toBe('1.0.0')
  })

  it('install handles a flat skills/ layout with no plugin top-dir', async () => {
    const zip = new JSZip()
    zip.file('skills/skill-flat/SKILL.md', '---\nname: skill-flat\n---\nflat')
    const zipBuf = await zip.generateAsync({ type: 'nodebuffer' })
    const entry = makeEntry(
      'catimation-flat',
      '1.0.0',
      sha256Hex(zipBuf),
      'https://example.com/plugins/catimation-flat-1.0.0.zip',
    )
    const svc = new PluginMarketplaceService({
      catalogUrl: 'https://example.com/plugins/plugins-catalog.json',
      userSkillsDir,
      stateFile,
      fetcher: makeFetcher(makeCatalog([entry]), new Map([[entry.url, zipBuf]])),
    })
    const record = await svc.install('catimation-flat')
    expect(record.skills).toEqual(['skill-flat'])
    expect(await exists(path.join(userSkillsDir, 'skill-flat', 'SKILL.md'))).toBe(true)
  })

  it('install throws when skills/ has dirs but none contain a SKILL.md', async () => {
    const zip = new JSZip()
    zip.file('catimation-empty/skills/not-a-skill/README.md', 'no skill here')
    const zipBuf = await zip.generateAsync({ type: 'nodebuffer' })
    const entry = makeEntry(
      'catimation-empty',
      '1.0.0',
      sha256Hex(zipBuf),
      'https://example.com/plugins/catimation-empty-1.0.0.zip',
    )
    const svc = new PluginMarketplaceService({
      catalogUrl: 'https://example.com/plugins/plugins-catalog.json',
      userSkillsDir,
      stateFile,
      fetcher: makeFetcher(makeCatalog([entry]), new Map([[entry.url, zipBuf]])),
    })
    await expect(svc.install('catimation-empty')).rejects.toThrow(/no installable skills/i)
    expect(await exists(stateFile)).toBe(false)
  })

  it('listInstalled returns persisted state across new service instances', async () => {
    const zipBuf = await buildPluginZip('catimation-demo', { 'skill-a': '---\nname: skill-a\n---\nA' })
    const entry = makeEntry(
      'catimation-demo',
      '1.0.0',
      sha256Hex(zipBuf),
      'https://example.com/plugins/catimation-demo-1.0.0.zip',
    )
    const opts = {
      catalogUrl: 'https://example.com/plugins/plugins-catalog.json',
      userSkillsDir,
      stateFile,
      fetcher: makeFetcher(makeCatalog([entry]), new Map([[entry.url, zipBuf]])),
    }
    await new PluginMarketplaceService(opts).install('catimation-demo')

    const list = await new PluginMarketplaceService(opts).listInstalled()
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('catimation-demo')
  })
})
