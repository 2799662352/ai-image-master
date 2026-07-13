#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { z } from 'zod'

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const quarantineEntrySchema = z
  .object({
    testId: z.string().min(1),
    reason: z.string().min(10),
    issue: z.string().url().regex(/^https:\/\/github\.com\//),
    addedAt: z.string().regex(DATE_PATTERN),
    expiresAt: z.string().regex(DATE_PATTERN),
  })
  .strict()

function listE2eFiles(directory) {
  if (!existsSync(directory)) return []
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...listE2eFiles(fullPath))
    } else if (entry.isFile() && entry.name.endsWith('.e2e.ts')) {
      files.push(fullPath)
    }
  }
  return files
}

function taggedTests(repoRoot) {
  const result = new Set()
  const titlePattern =
    /\btest(?:\.(?:only|skip|fixme))?\s*\(\s*(['"`])([^'"`\r\n]*@quarantine[^'"`\r\n]*)\1/g
  for (const filePath of listE2eFiles(path.join(repoRoot, 'e2e'))) {
    const source = readFileSync(filePath, 'utf8')
    for (const match of source.matchAll(titlePattern)) {
      const relativePath = path.relative(repoRoot, filePath).replaceAll('\\', '/')
      result.add(`${relativePath} :: ${match[2]}`)
    }
  }
  return result
}

function entryFilePath(repoRoot, testId) {
  const separator = ' :: '
  const separatorIndex = testId.indexOf(separator)
  if (separatorIndex < 0) {
    throw new Error(`Invalid quarantine testId: ${testId}`)
  }
  const relativePath = testId.slice(0, separatorIndex)
  if (
    !relativePath.startsWith('e2e/') ||
    relativePath.includes('..') ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(`Invalid quarantine test path: ${relativePath}`)
  }
  return path.join(repoRoot, ...relativePath.split('/'))
}

export function validateQuarantineManifest(
  entries,
  { repoRoot, now = new Date() },
) {
  const parsedEntries = z.array(quarantineEntrySchema).parse(entries)
  const ids = new Set()
  for (const entry of parsedEntries) {
    if (ids.has(entry.testId)) {
      throw new Error(`Duplicate quarantine testId: ${entry.testId}`)
    }
    ids.add(entry.testId)

    const expiresAt = new Date(`${entry.expiresAt}T23:59:59.999Z`)
    if (now > expiresAt) {
      throw new Error(`Quarantine entry expired: ${entry.testId}`)
    }
    if (!existsSync(entryFilePath(repoRoot, entry.testId))) {
      throw new Error(`Quarantined test file does not exist: ${entry.testId}`)
    }
  }

  const tagged = taggedTests(repoRoot)
  for (const testId of ids) {
    if (!tagged.has(testId)) {
      throw new Error(`Quarantine entry has no matching tagged test: ${testId}`)
    }
  }
  for (const testId of tagged) {
    if (!ids.has(testId)) {
      throw new Error(`Tagged quarantine test is not registered: ${testId}`)
    }
  }

  return parsedEntries
}

function runCli() {
  const repoRoot = process.cwd()
  const manifestPath = path.join(repoRoot, 'e2e', 'quarantine.json')
  const entries = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const validated = validateQuarantineManifest(entries, { repoRoot })
  console.log(`Validated ${validated.length} E2E quarantine entries`)
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    runCli()
  } catch (error) {
    console.error(
      `[e2e-quarantine] ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exitCode = 1
  }
}
