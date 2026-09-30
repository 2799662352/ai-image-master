import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ipcMain, shell } from 'electron'

import { resolveStableCodexHome } from '../agent/CodexLocalBackend'
import { scanCustomPets } from './customPets'

export function customPetsDir(): string {
  return path.join(resolveStableCodexHome(), 'pets')
}

export function registerPetsIpc(): void {
  ipcMain.handle('pets:list-custom', async () => {
    try {
      return { ok: true, ...(await scanCustomPets(customPetsDir())) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('pets:open-folder', async () => {
    const dir = customPetsDir()
    try {
      await fs.mkdir(dir, { recursive: true })
      const error = await shell.openPath(dir)
      return error ? { ok: false, error } : { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
