import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { beforeEach, describe, expect, it } from 'vitest'

import { MarketplaceService } from '../marketplaceService'
import type { Catalog, CatalogEntry } from '../marketplaceService'

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

async function buildZipBuffer(files: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip()
  for (const [k, v] of Object.entries(files)) {
    zip.file(k, v)
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
  description = `desc for ${name}`,
): CatalogEntry {
  return { name, version, description, size: 0, sha256: sha, url }
}

function makeCatalog(entries: CatalogEntry[]): Catalog {
  return { schemaVersion: 1, generatedAt: new Date(0).toISOString(), skills: entries }
}

interface FetchCall {
  url: string
}

function makeFetcher(
  catalog: Catalog,
  blobs: Map<string, Buffer>,
  callLog: FetchCall[] = [],
): (url: string) => Promise<Buffer> {
  return async (url: string) => {
    callLog.push({ url })
    if (url.endsWith('/catalog.json') || url.endsWith('catalog.json')) {
      return Buffer.from(JSON.stringify(catalog), 'utf8')
    }
    const b = blobs.get(url)
    if (!b) throw new Error(`mock fetcher: no blob registered for ${url}`)
    return b
  }
}

// MarketplaceService is the install/uninstall/adopt brain of the Skill
// Marketplace MVP. It must be:
//   - dependency-injected (fetcher + filesystem paths) so unit tests can
//     simulate every catalog/network/disk state without spinning up Electron;
//   - fail-safe: a sha256 mismatch or a partial extract must leave NOTHING
//     half-installed on the user's machine;
//   - idempotent for the adoption pass (so launching the app twice doesn't
//     double-record any skill);
//   - the single source of truth for "which skills the user has installed"
//     via `<userData>/marketplace-state.json`.

describe('MarketplaceService', () => {
  let userSkillsDir: string
  let stateFile: string

  beforeEach(async () => {
    userSkillsDir = await makeTempDir('mp-userskills-')
    const stateDir = await makeTempDir('mp-state-')
    stateFile = path.join(stateDir, 'marketplace-state.json')
  })

  it('fetchCatalog hits the network once and caches the result until forced', async () => {
    const catalog = makeCatalog([])
    const calls: FetchCall[] = []
    const svc = new MarketplaceService({
      catalogUrl: 'https://example.com/skills/catalog.json',
      userSkillsDir,
      stateFile,
      fetcher: makeFetcher(catalog, new Map(), calls),
    })

    const a = await svc.fetchCatalog()
    const b = await svc.fetchCatalog()
    expect(a).toEqual(catalog)
    expect(b).toEqual(catalog)
    expect(calls.filter((c) => c.url.endsWith('catalog.json'))).toHaveLength(1)

    await svc.fetchCatalog(true)
    expect(calls.filter((c) => c.url.endsWith('catalog.json'))).toHaveLength(2)
  })

  it('install downloads, sha256-verifies, extracts, and records state', async () => {
    const zipBuf = await buildZipBuffer({
      'SKILL.md': '---\nname: foo\n---\nbody',
      'references/notes.md': 'note-content',
    })
    const digest = sha256Hex(zipBuf)
    const entry = makeEntry('foo', '1.0.0', digest, 'https://example.com/skills/foo-1.0.0.zip')
    const catalog = makeCatalog([entry])
    const blobs = new Map<string, Buffer>([[entry.url, zipBuf]])

    const svc = new MarketplaceService({
      catalogUrl: 'https://example.com/skills/catalog.json',
      userSkillsDir,
      stateFile,
      fetcher: makeFetcher(catalog, blobs),
    })

    const record = await svc.install('foo')
    expect(record).toMatchObject({
      name: 'foo',
      version: '1.0.0',
      sha256: digest,
      source: 'marketplace',
    })
    expect(typeof record.installedAt).toBe('string')

    const skillMdPath = path.join(userSkillsDir, 'foo', 'SKILL.md')
    expect(await readFile(skillMdPath, 'utf8')).toContain('name: foo')
    expect(
      await readFile(path.join(userSkillsDir, 'foo', 'references', 'notes.md'), 'utf8'),
    ).toBe('note-content')

    const stateJson = JSON.parse(await readFile(stateFile, 'utf8'))
    expect(stateJson.installed.foo).toMatchObject({
      name: 'foo',
      version: '1.0.0',
      sha256: digest,
      source: 'marketplace',
    })
  })

  it('install rejects on sha256 mismatch and leaves no half-installed dir', async () => {
    const zipBuf = await buildZipBuffer({ 'SKILL.md': '---\nname: bad\n---\nx' })
    const wrongDigest = '0'.repeat(64)
    const entry = makeEntry('bad', '1.0.0', wrongDigest, 'https://example.com/skills/bad-1.0.0.zip')
    const catalog = makeCatalog([entry])
    const blobs = new Map<string, Buffer>([[entry.url, zipBuf]])

    const svc = new MarketplaceService({
      catalogUrl: 'https://example.com/skills/catalog.json',
      userSkillsDir,
      stateFile,
      fetcher: makeFetcher(catalog, blobs),
    })

    await expect(svc.install('bad')).rejects.toThrow(/sha256/i)
    expect(await exists(path.join(userSkillsDir, 'bad'))).toBe(false)
    expect(await exists(stateFile)).toBe(false)
  })

  it('install rejects when the skill name is not in the catalog', async () => {
    const catalog = makeCatalog([])
    const svc = new MarketplaceService({
      catalogUrl: 'https://example.com/skills/catalog.json',
      userSkillsDir,
      stateFile,
      fetcher: makeFetcher(catalog, new Map()),
    })
    await expect(svc.install('nonexistent')).rejects.toThrow(/not found/i)
  })

  it('install replaces a previously-installed older version cleanly', async () => {
    const oldZip = await buildZipBuffer({ 'SKILL.md': '---\nname: dual\n---\nv1' })
    const newZip = await buildZipBuffer({ 'SKILL.md': '---\nname: dual\n---\nv2' })
    const oldEntry = makeEntry(
      'dual',
      '1.0.0',
      sha256Hex(oldZip),
      'https://example.com/skills/dual-1.0.0.zip',
    )
    const newEntry = makeEntry(
      'dual',
      '1.1.0',
      sha256Hex(newZip),
      'https://example.com/skills/dual-1.1.0.zip',
    )

    // First catalog ships only v1.
    let activeCatalog = makeCatalog([oldEntry])
    const blobs = new Map<string, Buffer>([
      [oldEntry.url, oldZip],
      [newEntry.url, newZip],
    ])
    const svc = new MarketplaceService({
      catalogUrl: 'https://example.com/skills/catalog.json',
      userSkillsDir,
      stateFile,
      fetcher: async (url) => {
        if (url.endsWith('catalog.json')) {
          return Buffer.from(JSON.stringify(activeCatalog), 'utf8')
        }
        const b = blobs.get(url)
        if (!b) throw new Error(`no blob for ${url}`)
        return b
      },
    })
    await svc.install('dual')
    expect(await readFile(path.join(userSkillsDir, 'dual', 'SKILL.md'), 'utf8')).toContain('v1')

    // Catalog now serves v1.1.0; install again to upgrade.
    activeCatalog = makeCatalog([newEntry])
    await svc.fetchCatalog(true)
    const rec = await svc.install('dual')
    expect(rec.version).toBe('1.1.0')
    expect(await readFile(path.join(userSkillsDir, 'dual', 'SKILL.md'), 'utf8')).toContain('v2')
  })

  // 改名迁移 —— 我们逐条目装进**共享平铺命名空间**,改名之后新名字装进来,旧目录
  // 既不被覆盖(不在新包里)也不被删除(没人记得它),变成既不更新也删不掉的孤儿,
  // 而它的正文引用的还是老名字,新旧两套会同时被 agent 看见。做法同 Homebrew 的
  // formula_renames.json:改名必须在清单里显式声明,客户端没法自己看出来。
  it('install 按 renamedFrom 清掉旧目录并迁移台账', async () => {
    const zipBuf = await buildZipBuffer({ 'SKILL.md': '---\nname: new-name\n---\nv2' })
    const entry: CatalogEntry = {
      ...makeEntry('new-name', '2.0.0', sha256Hex(zipBuf), 'https://example.com/skills/new-name-2.0.0.zip'),
      renamedFrom: ['old-name'],
    }
    const catalog = makeCatalog([entry])
    const blobs = new Map<string, Buffer>([[entry.url, zipBuf]])

    // 盘上有旧名字的安装,台账里也有它。
    await mkdir(path.join(userSkillsDir, 'old-name'), { recursive: true })
    await writeFile(
      path.join(userSkillsDir, 'old-name', 'SKILL.md'),
      '---\nname: old-name\n---\nv1',
      'utf8',
    )
    await writeFile(
      stateFile,
      JSON.stringify({
        schemaVersion: 1,
        installed: {
          'old-name': {
            name: 'old-name',
            version: '1.0.0',
            installedAt: new Date(0).toISOString(),
            sha256: '0'.repeat(64),
            source: 'marketplace',
          },
        },
      }),
      'utf8',
    )

    const svc = new MarketplaceService({
      catalogUrl: 'https://example.com/skills/catalog.json',
      userSkillsDir,
      stateFile,
      fetcher: makeFetcher(catalog, blobs),
    })
    await svc.install('new-name')

    expect(await exists(path.join(userSkillsDir, 'old-name'))).toBe(false)
    expect(await exists(path.join(userSkillsDir, 'new-name'))).toBe(true)
    const st = JSON.parse(await readFile(stateFile, 'utf8'))
    expect(st.installed['old-name']).toBeUndefined()
    expect(st.installed['new-name']).toMatchObject({ version: '2.0.0' })
  })

  it('旧名字目录不存在时,改名迁移是安全的 no-op', async () => {
    // 绝大多数用户从没装过旧名字 —— 迁移不能因此报错或留下痕迹。
    const zipBuf = await buildZipBuffer({ 'SKILL.md': '---\nname: fresh\n---\n' })
    const entry: CatalogEntry = {
      ...makeEntry('fresh', '1.0.0', sha256Hex(zipBuf), 'https://example.com/skills/fresh-1.0.0.zip'),
      renamedFrom: ['never-had-this'],
    }
    const svc = new MarketplaceService({
      catalogUrl: 'https://example.com/skills/catalog.json',
      userSkillsDir,
      stateFile,
      fetcher: makeFetcher(makeCatalog([entry]), new Map([[entry.url, zipBuf]])),
    })
    await expect(svc.install('fresh')).resolves.toMatchObject({ name: 'fresh' })
    expect(await exists(path.join(userSkillsDir, 'fresh'))).toBe(true)
  })

  it('旧名字如果仍在 catalog 里,就不是改名 —— 不删它', async () => {
    // 防御一次手滑:改名表把一个仍在售的 skill 写成了别人的旧名。删掉它等于
    // 静默卸载用户正在用的东西,而 catalog 明明还在提供它。
    const oldZip = await buildZipBuffer({ 'SKILL.md': '---\nname: still-listed\n---\n' })
    const newZip = await buildZipBuffer({ 'SKILL.md': '---\nname: claimer\n---\n' })
    const stillListed = makeEntry(
      'still-listed',
      '1.0.0',
      sha256Hex(oldZip),
      'https://example.com/skills/still-listed-1.0.0.zip',
    )
    const claimer: CatalogEntry = {
      ...makeEntry('claimer', '1.0.0', sha256Hex(newZip), 'https://example.com/skills/claimer-1.0.0.zip'),
      renamedFrom: ['still-listed'],
    }
    const svc = new MarketplaceService({
      catalogUrl: 'https://example.com/skills/catalog.json',
      userSkillsDir,
      stateFile,
      fetcher: makeFetcher(
        makeCatalog([stillListed, claimer]),
        new Map([[stillListed.url, oldZip], [claimer.url, newZip]]),
      ),
    })

    await svc.install('still-listed')
    await svc.install('claimer')

    expect(await exists(path.join(userSkillsDir, 'still-listed'))).toBe(true)
    const st = JSON.parse(await readFile(stateFile, 'utf8'))
    expect(st.installed['still-listed']).toBeDefined()
  })

  it('uninstall removes the skill directory and its state entry', async () => {
    const zipBuf = await buildZipBuffer({ 'SKILL.md': '---\nname: dropme\n---\n' })
    const entry = makeEntry(
      'dropme',
      '1.0.0',
      sha256Hex(zipBuf),
      'https://example.com/skills/dropme-1.0.0.zip',
    )
    const catalog = makeCatalog([entry])
    const blobs = new Map<string, Buffer>([[entry.url, zipBuf]])
    const svc = new MarketplaceService({
      catalogUrl: 'https://example.com/skills/catalog.json',
      userSkillsDir,
      stateFile,
      fetcher: makeFetcher(catalog, blobs),
    })

    await svc.install('dropme')
    await svc.uninstall('dropme')
    expect(await exists(path.join(userSkillsDir, 'dropme'))).toBe(false)
    const st = JSON.parse(await readFile(stateFile, 'utf8'))
    expect(st.installed.dropme).toBeUndefined()
  })

  it('uninstall of a skill that was never installed is a no-op (no throw)', async () => {
    const svc = new MarketplaceService({
      catalogUrl: 'https://example.com/skills/catalog.json',
      userSkillsDir,
      stateFile,
      fetcher: makeFetcher(makeCatalog([]), new Map()),
    })
    await expect(svc.uninstall('ghost')).resolves.not.toThrow()
  })

  it('adoptExisting tags pre-existing skill dirs that match catalog entries as source=adopted', async () => {
    const adoptedEntry = makeEntry(
      'pre-existing',
      '2.0.0',
      '0'.repeat(64),
      'https://example.com/skills/pre-existing-2.0.0.zip',
    )
    const noiseEntry = makeEntry(
      'never-installed',
      '1.0.0',
      '1'.repeat(64),
      'https://example.com/skills/never-installed-1.0.0.zip',
    )
    const catalog = makeCatalog([adoptedEntry, noiseEntry])

    // Simulate a v4.3.4 leftover.
    await mkdir(path.join(userSkillsDir, 'pre-existing'), { recursive: true })
    await writeFile(
      path.join(userSkillsDir, 'pre-existing', 'SKILL.md'),
      '---\nname: pre-existing\n---\nold body',
      'utf8',
    )

    const svc = new MarketplaceService({
      catalogUrl: 'https://example.com/skills/catalog.json',
      userSkillsDir,
      stateFile,
      fetcher: makeFetcher(catalog, new Map()),
    })
    const adopted = await svc.adoptExisting()

    expect(adopted).toHaveLength(1)
    expect(adopted[0]).toMatchObject({
      name: 'pre-existing',
      source: 'adopted',
    })

    const list = await svc.listInstalled()
    expect(list.map((r) => r.name)).toEqual(['pre-existing'])
  })

  it('adoptExisting 顺带完成改名迁移 —— 用户不必先去装新名字', async () => {
    // 缺口:install 时的迁移只在用户**主动安装新名字**时触发。装了旧名字之后
    // 什么都不做的用户,会永远留着那个孤儿。adoptExisting 每次启动都跑
    // (src/main/index.ts),它已经在扫目录、手里也有 catalog —— 让它顺带做,
    // 用户下次开应用就自动迁移。
    const renamedEntry: CatalogEntry = {
      ...makeEntry('new-id', '2.0.0', '0'.repeat(64), 'https://example.com/skills/new-id-2.0.0.zip'),
      renamedFrom: ['legacy-id'],
    }
    await mkdir(path.join(userSkillsDir, 'legacy-id'), { recursive: true })
    await writeFile(
      path.join(userSkillsDir, 'legacy-id', 'SKILL.md'),
      '---\nname: legacy-id\n---\nold',
      'utf8',
    )
    await writeFile(
      stateFile,
      JSON.stringify({
        schemaVersion: 1,
        installed: {
          'legacy-id': {
            name: 'legacy-id',
            version: '1.0.0',
            installedAt: new Date(0).toISOString(),
            sha256: '0'.repeat(64),
            source: 'marketplace',
          },
        },
      }),
      'utf8',
    )

    const svc = new MarketplaceService({
      catalogUrl: 'https://example.com/skills/catalog.json',
      userSkillsDir,
      stateFile,
      fetcher: makeFetcher(makeCatalog([renamedEntry]), new Map()),
    })
    await svc.adoptExisting()

    expect(await exists(path.join(userSkillsDir, 'legacy-id'))).toBe(false)
    const st = JSON.parse(await readFile(stateFile, 'utf8'))
    expect(st.installed['legacy-id']).toBeUndefined()
  })

  it('adoptExisting 不认领旧名字 —— 它该被清掉,不是被登记成已安装', async () => {
    // 旧名字仍在 catalog 的 renamedFrom 里,但它不是一个可安装条目。认领它等于
    // 把一个已经改名的东西登记成「已安装」,用户会在列表里看到一个装不了、
    // 更新不了的幽灵。
    const renamedEntry: CatalogEntry = {
      ...makeEntry('cur', '1.0.0', '0'.repeat(64), 'https://example.com/skills/cur-1.0.0.zip'),
      renamedFrom: ['gone'],
    }
    await mkdir(path.join(userSkillsDir, 'gone'), { recursive: true })
    await writeFile(path.join(userSkillsDir, 'gone', 'SKILL.md'), '---\nname: gone\n---\n', 'utf8')

    const svc = new MarketplaceService({
      catalogUrl: 'https://example.com/skills/catalog.json',
      userSkillsDir,
      stateFile,
      fetcher: makeFetcher(makeCatalog([renamedEntry]), new Map()),
    })
    const adopted = await svc.adoptExisting()

    expect(adopted.map((r) => r.name)).not.toContain('gone')
    expect(await exists(path.join(userSkillsDir, 'gone'))).toBe(false)
  })

  it('adoptExisting is idempotent — second call returns empty, listInstalled unchanged', async () => {
    const entry = makeEntry(
      'p1',
      '1.0.0',
      '0'.repeat(64),
      'https://example.com/skills/p1-1.0.0.zip',
    )
    const catalog = makeCatalog([entry])
    await mkdir(path.join(userSkillsDir, 'p1'), { recursive: true })
    await writeFile(path.join(userSkillsDir, 'p1', 'SKILL.md'), '---\nname: p1\n---\n', 'utf8')

    const svc = new MarketplaceService({
      catalogUrl: 'https://example.com/skills/catalog.json',
      userSkillsDir,
      stateFile,
      fetcher: makeFetcher(catalog, new Map()),
    })
    await svc.adoptExisting()
    const second = await svc.adoptExisting()
    expect(second).toEqual([])
    expect(await svc.listInstalled()).toHaveLength(1)
  })

  it('adoptExisting ignores user-created dirs whose names are not in catalog', async () => {
    const catalog = makeCatalog([])
    await mkdir(path.join(userSkillsDir, 'my-private-skill'), { recursive: true })
    await writeFile(
      path.join(userSkillsDir, 'my-private-skill', 'SKILL.md'),
      '---\nname: my-private-skill\n---\n',
      'utf8',
    )
    const svc = new MarketplaceService({
      catalogUrl: 'https://example.com/skills/catalog.json',
      userSkillsDir,
      stateFile,
      fetcher: makeFetcher(catalog, new Map()),
    })
    expect(await svc.adoptExisting()).toEqual([])
    expect(await svc.listInstalled()).toEqual([])
  })

  it('listInstalled returns persisted state across new service instances', async () => {
    const zipBuf = await buildZipBuffer({ 'SKILL.md': '---\nname: persistme\n---\n' })
    const entry = makeEntry(
      'persistme',
      '1.0.0',
      sha256Hex(zipBuf),
      'https://example.com/skills/persistme-1.0.0.zip',
    )
    const catalog = makeCatalog([entry])
    const blobs = new Map<string, Buffer>([[entry.url, zipBuf]])

    const svc1 = new MarketplaceService({
      catalogUrl: 'https://example.com/skills/catalog.json',
      userSkillsDir,
      stateFile,
      fetcher: makeFetcher(catalog, blobs),
    })
    await svc1.install('persistme')

    const svc2 = new MarketplaceService({
      catalogUrl: 'https://example.com/skills/catalog.json',
      userSkillsDir,
      stateFile,
      fetcher: makeFetcher(catalog, blobs),
    })
    const list = await svc2.listInstalled()
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('persistme')
  })
})
