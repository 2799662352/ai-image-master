import { describe, expect, it, vi } from 'vitest'
import { makeCanvasAssetStore } from '../canvasAssetStore'

/**
 * The asset store is the single place tldraw turns a dropped/pasted File into a
 * persisted src. It must NEVER produce a `data:` URL (that is the renderer-OOM /
 * app-relaunch bug) and must never produce an EMPTY src (broken shape).
 */
function makeFile(name: string, type: string): File {
  return new File(['x'], name, { type })
}

describe('makeCanvasAssetStore.upload', () => {
  it('uses the resolved disk path as a local-file src', async () => {
    const resolveDiskPath = vi.fn(async () => 'D:/work/shot.png')
    const store = makeCanvasAssetStore({ resolveDiskPath, getThreadId: () => 't1' })
    const res = await store.upload({}, makeFile('shot.png', 'image/png'))
    expect(res.src).toBe('local-file:///D:/work/shot.png')
    expect(resolveDiskPath).toHaveBeenCalledWith(expect.any(File), 't1')
  })

  it('uses the streamable media host for a video path', async () => {
    const store = makeCanvasAssetStore({
      resolveDiskPath: async () => 'D:/clips/out.mp4',
      getThreadId: () => 't1',
    })
    const res = await store.upload({}, makeFile('out.mp4', 'video/mp4'))
    expect(res.src).toBe(`local-file://media/?p=${encodeURIComponent('D:/clips/out.mp4')}`)
  })

  it('falls back to an object URL (never empty, never data:) when there is no path', async () => {
    const createObjectURL = vi.fn(() => 'blob:fake-1')
    const store = makeCanvasAssetStore({
      resolveDiskPath: async () => undefined,
      getThreadId: () => '',
      createObjectURL,
    })
    const res = await store.upload({}, makeFile('pasted.png', 'image/png'))
    expect(res.src).toBe('blob:fake-1')
    expect(createObjectURL).toHaveBeenCalledOnce()
  })

  it('still yields an object URL when path resolution throws', async () => {
    const store = makeCanvasAssetStore({
      resolveDiskPath: async () => {
        throw new Error('IPC down')
      },
      getThreadId: () => 't1',
      createObjectURL: () => 'blob:fake-2',
    })
    const res = await store.upload({}, makeFile('x.png', 'image/png'))
    expect(res.src).toBe('blob:fake-2')
  })
})

describe('makeCanvasAssetStore.resolve', () => {
  const store = makeCanvasAssetStore({
    resolveDiskPath: async () => undefined,
    getThreadId: () => '',
  })

  it('prefers meta.assetPath over props.src', () => {
    expect(
      store.resolve({ meta: { assetPath: 'D:/a/b.png' }, props: { src: 'blob:stale' } }),
    ).toBe('local-file:///D:/a/b.png')
  })

  it('passes a canonical local-file src straight through', () => {
    expect(store.resolve({ meta: {}, props: { src: 'local-file:///D:/a.png' } })).toBe(
      'local-file:///D:/a.png',
    )
  })

  // Canvases persisted by older builds hold `local-file:///D%3A/…` srcs — an
  // invalid URL for a standard scheme, so tldraw rendered them as broken
  // images. Records with `meta.assetPath` heal via the branch above; records
  // without it must heal here, at resolve time, without a store migration.
  it('heals a legacy %3A local-file src at resolve time', () => {
    expect(store.resolve({ meta: {}, props: { src: 'local-file:///D%3A/a.png' } })).toBe(
      'local-file:///D:/a.png',
    )
  })

  it('leaves a blob: src and a short data: src alone', () => {
    expect(store.resolve({ meta: {}, props: { src: 'blob:abc' } })).toBe('blob:abc')
    expect(store.resolve({ meta: {}, props: { src: 'data:image/png;base64,QUJD' } })).toBe(
      'data:image/png;base64,QUJD',
    )
  })

  it('refuses a legacy inline data: blob (v1 store) instead of rehydrating it', () => {
    const huge = `data:image/png;base64,${'A'.repeat(20_000)}`
    expect(store.resolve({ meta: {}, props: { src: huge } })).toBeNull()
  })

  it('returns null (not undefined) for an unusable asset', () => {
    expect(store.resolve({ meta: {}, props: {} })).toBeNull()
  })
})
