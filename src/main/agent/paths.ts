import path from 'node:path'

export function getCodexBinaryName(platform = process.platform): string {
  return platform === 'win32' ? 'codex.exe' : 'codex'
}

export function getCodexResourceDir(resourcesPath: string, platform = process.platform, arch = process.arch): string {
  return path.join(resourcesPath, 'codex', `${platform}-${arch}`)
}

export function resolveCodexBinary(resourcesPath: string): string {
  return path.join(getCodexResourceDir(resourcesPath), getCodexBinaryName())
}

export function getCodexResourceRoot(options: {
  appPath: string
  isPackaged: boolean
  resourcesPath?: string
}): string {
  return options.isPackaged && options.resourcesPath
    ? options.resourcesPath
    : path.join(options.appPath, 'resources')
}
