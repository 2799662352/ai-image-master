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
