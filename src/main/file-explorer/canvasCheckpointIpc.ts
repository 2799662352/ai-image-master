import { ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'

/**
 * `canvas:save-checkpoint` / `canvas:read-checkpoint` / `canvas:list-checkpoints`
 * — restorable canvas checkpoints (gap-analysis §8/§9).
 *
 * The renderer serialises the live tldraw editor with `getSnapshot(editor.store)`
 * (a JSON `{ document, session }`) and restores it with `loadSnapshot` — that
 * native path already orders assets-before-shapes, de-dupes bindings and re-runs
 * onBeforeCreate, so #8's manual `applySnapshot` logic is unnecessary. What was
 * missing is a place to PUT the JSON: `attachments:save` only accepts
 * image/video mimes, so a `.tldr.json` needs this dedicated file channel.
 *
 * "Multi-canvas fork" (#9) for our single embedded editor = named checkpoints:
 * each `save_checkpoint` is a branch point, `load_checkpoint` switches the
 * canvas to any saved branch. We don't run two simultaneous stores (the official
 * mcp-app only needs that because it's stateless serverless + Durable Objects).
 *
 * Security: checkpoint ids are slug-safe (`[a-z0-9-]`), so a malicious renderer
 * can't traverse out of the checkpoints dir. Snapshot bodies are written
 * verbatim; a tiny `.meta.json` sidecar holds the listing fields so listing
 * never has to parse multi-MB snapshot bodies.
 */

const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/

export function isSafeCheckpointId(id: unknown): boolean {
  return typeof id === 'string' && SAFE_ID.test(id) && !id.includes('..')
}

export function slugifyCheckpointName(name: string | undefined): string {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug : 'canvas'
}

export function makeCheckpointId(name: string | undefined, now: number = Date.now()): string {
  return `${slugifyCheckpointName(name)}-${now}`
}

export interface CheckpointMeta {
  checkpointId: string
  name: string
  createdAt: string
  shapeCount: number
  path: string
}

export type SaveCheckpointResult =
  | { ok: true; checkpointId: string; path: string }
  | { ok: false; reason: string }

export type ReadCheckpointResult =
  | { ok: true; checkpointId: string; json: string }
  | { ok: false; reason: string }

export async function saveCheckpointFile(
  dir: string,
  payload: { id: string; name: string; createdAt: string; shapeCount: number; snapshotJson: string },
): Promise<SaveCheckpointResult> {
  if (!isSafeCheckpointId(payload.id)) {
    return { ok: false, reason: `unsafe checkpoint id: ${payload.id}` }
  }
  if (typeof payload.snapshotJson !== 'string' || payload.snapshotJson.length === 0) {
    return { ok: false, reason: 'empty snapshot' }
  }
  try {
    await fs.mkdir(dir, { recursive: true })
    const snapshotPath = path.join(dir, `${payload.id}.json`)
    const metaPath = path.join(dir, `${payload.id}.meta.json`)
    // Snapshot body verbatim; sidecar holds only the cheap listing fields.
    await fs.writeFile(snapshotPath, payload.snapshotJson, 'utf8')
    await fs.writeFile(
      metaPath,
      JSON.stringify({ checkpointId: payload.id, name: payload.name, createdAt: payload.createdAt, shapeCount: payload.shapeCount }),
      'utf8',
    )
    return { ok: true, checkpointId: payload.id, path: snapshotPath }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

export async function readCheckpointFile(dir: string, id: string): Promise<ReadCheckpointResult> {
  if (!isSafeCheckpointId(id)) {
    return { ok: false, reason: `unsafe checkpoint id: ${id}` }
  }
  try {
    const json = await fs.readFile(path.join(dir, `${id}.json`), 'utf8')
    return { ok: true, checkpointId: id, json }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return { ok: false, reason: `checkpoint not found: ${id}` }
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

export async function listCheckpointFiles(dir: string): Promise<CheckpointMeta[]> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  const metas: CheckpointMeta[] = []
  for (const file of names) {
    if (!file.endsWith('.meta.json')) continue
    try {
      const raw = await fs.readFile(path.join(dir, file), 'utf8')
      const parsed = JSON.parse(raw) as Partial<CheckpointMeta>
      if (!parsed.checkpointId || !isSafeCheckpointId(parsed.checkpointId)) continue
      metas.push({
        checkpointId: parsed.checkpointId,
        name: typeof parsed.name === 'string' ? parsed.name : parsed.checkpointId,
        createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
        shapeCount: typeof parsed.shapeCount === 'number' ? parsed.shapeCount : 0,
        path: path.join(dir, `${parsed.checkpointId}.json`),
      })
    } catch {
      // Skip corrupt sidecars rather than failing the whole listing.
    }
  }
  // Newest first.
  metas.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
  return metas
}

export function registerCanvasCheckpointIpc(dir: string): void {
  ipcMain.removeHandler('canvas:save-checkpoint')
  ipcMain.handle(
    'canvas:save-checkpoint',
    async (
      _event,
      args: { name?: unknown; snapshotJson?: unknown; shapeCount?: unknown },
    ): Promise<SaveCheckpointResult> => {
      const snapshotJson = typeof args?.snapshotJson === 'string' ? args.snapshotJson : ''
      if (!snapshotJson) return { ok: false, reason: 'canvas:save-checkpoint requires snapshotJson' }
      const name = typeof args?.name === 'string' ? args.name : ''
      const shapeCount = typeof args?.shapeCount === 'number' ? args.shapeCount : 0
      const id = makeCheckpointId(name)
      return saveCheckpointFile(dir, { id, name: name || id, createdAt: new Date().toISOString(), shapeCount, snapshotJson })
    },
  )

  ipcMain.removeHandler('canvas:read-checkpoint')
  ipcMain.handle('canvas:read-checkpoint', async (_event, args: { checkpointId?: unknown }): Promise<ReadCheckpointResult> => {
    const id = typeof args?.checkpointId === 'string' ? args.checkpointId : ''
    if (!id) return { ok: false, reason: 'canvas:read-checkpoint requires checkpointId' }
    return readCheckpointFile(dir, id)
  })

  ipcMain.removeHandler('canvas:list-checkpoints')
  ipcMain.handle('canvas:list-checkpoints', async (): Promise<CheckpointMeta[]> => listCheckpointFiles(dir))
}
