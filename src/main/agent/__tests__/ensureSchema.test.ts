// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { ensureSchema } from '../ensureSchema'

describe('ensureSchema', () => {
  it('creates AgentThread and related tables on an empty PGlite database', async () => {
    const db = await PGlite.create()
    try {
      await ensureSchema(db)
      for (const table of [
        'AgentThread',
        'AgentMessage',
        'AgentToolCall',
        'AgentArtifact',
        'AgentAttachment',
      ]) {
        const result = await db.query<{ oid: string | null }>(
          `SELECT to_regclass('"${table}"') as oid`,
        )
        expect(result.rows[0]?.oid, `expected ${table} to exist after ensureSchema`).not.toBeNull()
      }
    } finally {
      await db.close()
    }
  })

  it('is idempotent — second call is a no-op', async () => {
    const db = await PGlite.create()
    try {
      await ensureSchema(db)
      await expect(ensureSchema(db)).resolves.toBeUndefined()
      const result = await db.query<{ oid: string | null }>(
        `SELECT to_regclass('"AgentThread"') as oid`,
      )
      expect(result.rows[0]?.oid).not.toBeNull()
    } finally {
      await db.close()
    }
  })

  it('lets prisma-style INSERT round-trip succeed after init', async () => {
    const db = await PGlite.create()
    try {
      await ensureSchema(db)
      await db.query(
        `INSERT INTO "AgentThread" ("id", "title", "model", "updatedAt") VALUES ($1, $2, $3, NOW())`,
        ['t1', 'Hello', 'gpt-5'],
      )
      const result = await db.query<{ id: string; title: string }>(
        `SELECT id, title FROM "AgentThread" WHERE id = $1`,
        ['t1'],
      )
      expect(result.rows[0]?.id).toBe('t1')
      expect(result.rows[0]?.title).toBe('Hello')
    } finally {
      await db.close()
    }
  })

  // Regression for the bug where Task 2 added manualTitle/lastMessageAt and
  // renamed contentJson→items in schema.prisma but left ensureSchema's INIT_SQL
  // stale, causing prisma.agentThread.create() to fail at runtime against a
  // db created from the old INIT_SQL. ensureSchema must self-heal stale DBs.
  it('aligns a legacy-schema database to current schema without losing data', async () => {
    const db = await PGlite.create()
    try {
      // Bootstrap the OLD (pre-Task-2) schema directly.
      await db.exec(`
        CREATE TABLE "AgentThread" (
          "id" TEXT NOT NULL,
          "title" TEXT NOT NULL,
          "model" TEXT NOT NULL,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP(3) NOT NULL,
          CONSTRAINT "AgentThread_pkey" PRIMARY KEY ("id")
        );
        CREATE TABLE "AgentMessage" (
          "id" TEXT NOT NULL,
          "threadId" TEXT NOT NULL,
          "role" TEXT NOT NULL,
          "contentJson" JSONB NOT NULL,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "AgentMessage_pkey" PRIMARY KEY ("id")
        );
      `)
      await db.query(
        `INSERT INTO "AgentThread" ("id", "title", "model", "updatedAt") VALUES ($1, $2, $3, NOW())`,
        ['legacy-thread', 'Legacy', 'gpt-5'],
      )
      await db.query(
        `INSERT INTO "AgentMessage" ("id", "threadId", "role", "contentJson") VALUES ($1, $2, $3, $4)`,
        ['legacy-msg', 'legacy-thread', 'user', JSON.stringify([{ type: 'text', text: 'hello' }])],
      )

      await ensureSchema(db)

      // New columns added with default values.
      const threadCols = await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='AgentThread'`,
      )
      const colNames = threadCols.rows.map((r) => r.column_name)
      expect(colNames).toContain('manualTitle')
      expect(colNames).toContain('lastMessageAt')
      // Crash-resume across a FULL app restart needs the persisted codex thread
      // id. Existing users' DBs (created before this column) must pick it up via
      // ALIGN_SCHEMA_SQL on the hot-update boot, or resume-on-restart silently
      // degrades back to amnesiac fresh threads.
      expect(colNames).toContain('codexThreadId')
      await db.query(
        `UPDATE "AgentThread" SET "codexThreadId" = $1 WHERE id = $2`,
        ['11111111-2222-3333-4444-555555555555', 'legacy-thread'],
      )
      const codexRow = await db.query<{ codexThreadId: string | null }>(
        `SELECT "codexThreadId" FROM "AgentThread" WHERE id = $1`,
        ['legacy-thread'],
      )
      expect(codexRow.rows[0]?.codexThreadId).toBe('11111111-2222-3333-4444-555555555555')

      // contentJson renamed to items, data preserved.
      const msgCols = await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='AgentMessage'`,
      )
      const msgColNames = msgCols.rows.map((r) => r.column_name)
      expect(msgColNames).toContain('items')
      expect(msgColNames).not.toContain('contentJson')

      const restored = await db.query<{ items: unknown }>(
        `SELECT items FROM "AgentMessage" WHERE id = $1`,
        ['legacy-msg'],
      )
      expect(restored.rows[0]?.items).toEqual([{ type: 'text', text: 'hello' }])

      // The original failure mode: prisma.agentThread.create equivalent must succeed.
      await db.query(
        `INSERT INTO "AgentThread" ("id", "title", "model", "manualTitle", "updatedAt") VALUES ($1, $2, $3, $4, NOW())`,
        ['new-thread', 'After migration', 'gpt-5', false],
      )
      const verify = await db.query<{ manualTitle: boolean }>(
        `SELECT "manualTitle" FROM "AgentThread" WHERE id = $1`,
        ['new-thread'],
      )
      expect(verify.rows[0]?.manualTitle).toBe(false)
    } finally {
      await db.close()
    }
  })
})
