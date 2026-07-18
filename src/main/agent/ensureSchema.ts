import type { PGlite } from '@electric-sql/pglite'
import { Client as PgClient } from 'pg'

// Auto-generated DDL from prisma/schema.prisma.
// To regenerate after schema changes, run:
//   npm run agent:init-sql
// then copy the output of prisma/init.sql into the INIT_SQL constant below.
const INIT_SQL = `
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "AgentThread" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "manualTitle" BOOLEAN NOT NULL DEFAULT false,
    "codexThreadId" TEXT,
    "gatewayId" TEXT,
    "modelProvider" TEXT,
    "lastMessageAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentMessage" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "items" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentToolCall" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "paramsJson" JSONB NOT NULL,
    "resultJson" JSONB,
    "status" TEXT NOT NULL,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentToolCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentArtifact" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "messageId" TEXT,
    "type" TEXT NOT NULL,
    "uri" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentAttachment" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "localPath" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentThread_lastMessageAt_idx" ON "AgentThread"("lastMessageAt" DESC);

-- CreateIndex
CREATE INDEX "AgentMessage_threadId_createdAt_idx" ON "AgentMessage"("threadId", "createdAt");

-- AddForeignKey
ALTER TABLE "AgentMessage" ADD CONSTRAINT "AgentMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "AgentThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentToolCall" ADD CONSTRAINT "AgentToolCall_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "AgentMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentArtifact" ADD CONSTRAINT "AgentArtifact_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "AgentThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentAttachment" ADD CONSTRAINT "AgentAttachment_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "AgentThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
`

// Idempotent migrations that align an existing-but-stale schema with current
// `prisma/schema.prisma`. Each statement is a no-op when already applied so
// they can run on every boot without losing data. Add new entries here when
// schema.prisma changes — fresh DBs get the columns from INIT_SQL above,
// existing user DBs pick them up here.
const ALIGN_SCHEMA_SQL: readonly string[] = [
  `ALTER TABLE "AgentThread" ADD COLUMN IF NOT EXISTS "manualTitle" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "AgentThread" ADD COLUMN IF NOT EXISTS "codexThreadId" TEXT`,
  // Per-thread provider routing (Plan B): existing user DBs pick these up on
  // the hot-update boot; rows stay NULL (= unbound) until their next send.
  `ALTER TABLE "AgentThread" ADD COLUMN IF NOT EXISTS "gatewayId" TEXT`,
  `ALTER TABLE "AgentThread" ADD COLUMN IF NOT EXISTS "modelProvider" TEXT`,
  `ALTER TABLE "AgentThread" ADD COLUMN IF NOT EXISTS "lastMessageAt" TIMESTAMP(3)`,
  `CREATE INDEX IF NOT EXISTS "AgentThread_lastMessageAt_idx" ON "AgentThread"("lastMessageAt" DESC)`,
  `ALTER TABLE "AgentMessage" ADD COLUMN IF NOT EXISTS "items" JSONB NOT NULL DEFAULT '[]'`,
] as const

// Returns true when AgentMessage has the legacy `contentJson` column but not
// the current `items` column — caller should rename rather than drop.
const RENAME_PROBE_SQL = `
  SELECT
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'AgentMessage' AND column_name = 'contentJson'
    ) AS has_old,
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'AgentMessage' AND column_name = 'items'
    ) AS has_new
`

interface QueryRunner {
  query: (sql: string) => Promise<{ rows: Array<{ has_old?: boolean; has_new?: boolean }> }>
}

async function alignSchema(runner: QueryRunner): Promise<void> {
  // Rename BEFORE add-column so legacy contentJson data survives the upgrade.
  // If we add `items` first, the rename probe sees `has_new=true` and skips
  // the rename, silently dropping the legacy column's data on a later cleanup.
  const probe = await runner.query(RENAME_PROBE_SQL)
  const row = probe.rows[0]
  if (row?.has_old && !row?.has_new) {
    await runner.query(`ALTER TABLE "AgentMessage" RENAME COLUMN "contentJson" TO "items"`)
  }
  for (const sql of ALIGN_SCHEMA_SQL) {
    await runner.query(sql)
  }
}

export async function ensureSchema(db: PGlite): Promise<void> {
  const result = await db.query<{ oid: string | null }>(
    `SELECT to_regclass('"AgentThread"') as oid`,
  )
  if (!result.rows[0]?.oid) {
    await db.exec(INIT_SQL)
    return
  }
  await alignSchema({
    query: async (sql) => {
      const r = await db.query<{ has_old?: boolean; has_new?: boolean }>(sql)
      return { rows: r.rows }
    },
  })
}

// Variant that works against ANY Postgres-compatible URL — embedded PGlite
// (via its socket server on 5433) or a real external Postgres (e.g. 5432).
// Uses node-postgres' simple query protocol so the multi-statement INIT_SQL
// runs as a single round-trip without splitting.
export async function ensureSchemaViaConnection(connectionString: string): Promise<void> {
  const client = new PgClient({ connectionString })
  await client.connect()
  try {
    const probe = await client.query<{ oid: string | null }>(
      `SELECT to_regclass('"AgentThread"') as oid`,
    )
    if (!probe.rows[0]?.oid) {
      await client.query(INIT_SQL)
      return
    }
    await alignSchema({
      query: async (sql) => {
        const r = await client.query<{ has_old?: boolean; has_new?: boolean }>(sql)
        return { rows: r.rows }
      },
    })
  } finally {
    await client.end()
  }
}
