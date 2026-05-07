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
})
