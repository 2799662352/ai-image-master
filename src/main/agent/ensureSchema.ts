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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentMessage" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "contentJson" JSONB NOT NULL,
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

export async function ensureSchema(db: PGlite): Promise<void> {
  const result = await db.query<{ oid: string | null }>(
    `SELECT to_regclass('"AgentThread"') as oid`,
  )
  if (result.rows[0]?.oid) return
  await db.exec(INIT_SQL)
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
    if (probe.rows[0]?.oid) return
    await client.query(INIT_SQL)
  } finally {
    await client.end()
  }
}
