import { app } from 'electron'
import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import net from 'node:net'
import path from 'node:path'

let prisma: PrismaClient | null = null
let pgliteServer: PGLiteSocketServer | null = null
let pgliteDb: PGlite | null = null

export async function canConnect(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port })
    let settled = false

    const finish = (result: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }

    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(500, () => finish(false))
  })
}

export async function resolveDatabaseUrl(): Promise<string> {
  const envUrl = process.env.CATIMATION_AGENT_DATABASE_URL
  if (envUrl) return envUrl

  if (await canConnect(5432)) {
    return 'postgresql://sorauser:sora_password_2024@127.0.0.1:5432/soraui'
  }

  return startEmbeddedPGlite()
}

export async function startEmbeddedPGlite(): Promise<string> {
  if (pgliteServer) {
    return 'postgresql://postgres:postgres@127.0.0.1:5433/postgres'
  }

  const dataDir = path.join(app.getPath('userData'), 'pgdata')
  pgliteDb = await PGlite.create(dataDir)
  pgliteServer = new PGLiteSocketServer({ db: pgliteDb, host: '127.0.0.1', port: 5433 })
  await pgliteServer.start()
  return 'postgresql://postgres:postgres@127.0.0.1:5433/postgres'
}

export async function getPrisma(): Promise<PrismaClient> {
  if (!prisma) {
    const databaseUrl = await resolveDatabaseUrl()
    process.env.DATABASE_URL = databaseUrl
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl }),
    })
  }

  return prisma
}

export async function shutdownDatabase(): Promise<void> {
  await prisma?.$disconnect()
  await pgliteServer?.stop()
  await pgliteDb?.close()
  prisma = null
  pgliteServer = null
  pgliteDb = null
}
