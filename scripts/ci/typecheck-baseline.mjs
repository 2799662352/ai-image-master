#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import {
  readFileSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

function diagnosticKey(diagnostic) {
  return `${diagnostic.file}\u0000${diagnostic.code}\u0000${diagnostic.message}`
}

function normalizeDiagnosticMessage(message, repoRoot) {
  const root = String(repoRoot).replace(/[\\/]+$/, '')
  const rootVariants = new Set([
    root,
    root.replaceAll('\\', '/'),
    root.replaceAll('/', '\\'),
  ])
  let normalized = message.trim()
  for (const variant of rootVariants) {
    if (variant) normalized = normalized.replaceAll(variant, '<repo>')
  }
  return normalized
}

export function parseTypeScriptDiagnostics(output, repoRoot = process.cwd()) {
  const diagnostics = []
  const positionedPattern =
    /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/
  const globalPattern = /^error (TS\d+): (.+)$/
  for (const line of output.split(/\r?\n/)) {
    if (!/error TS\d+:/.test(line)) continue
    const positioned = line.match(positionedPattern)
    if (positioned) {
      let file = path.normalize(positioned[1])
      if (path.isAbsolute(file)) file = path.relative(repoRoot, file)
      diagnostics.push({
        file: file.replaceAll('\\', '/'),
        code: positioned[4],
        message: normalizeDiagnosticMessage(positioned[5], repoRoot),
      })
      continue
    }
    const global = line.match(globalPattern)
    if (global) {
      diagnostics.push({
        file: '<global>',
        code: global[1],
        message: normalizeDiagnosticMessage(global[2], repoRoot),
      })
      continue
    }
    throw new Error(`Unparseable TypeScript error line: ${line}`)
  }
  return diagnostics
}

function countsFor(diagnostics) {
  const counts = new Map()
  for (const diagnostic of diagnostics) {
    const key = diagnosticKey(diagnostic)
    const previous = counts.get(key)
    counts.set(key, {
      diagnostic,
      count: (previous?.count ?? 0) + (diagnostic.count ?? 1),
    })
  }
  return counts
}

export function compareDiagnosticsToBaseline(diagnostics, baselineEntries) {
  const current = countsFor(diagnostics)
  const baseline = countsFor(baselineEntries)
  const additions = []
  let removed = 0

  for (const [key, value] of current) {
    const allowed = baseline.get(key)?.count ?? 0
    for (let index = allowed; index < value.count; index += 1) {
      additions.push(value.diagnostic)
    }
  }
  for (const [key, value] of baseline) {
    const remaining = current.get(key)?.count ?? 0
    removed += Math.max(0, value.count - remaining)
  }

  return { additions, removed }
}

export function validateBaselineExpiry(expiresAt, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) {
    throw new Error('Typecheck baseline expiresAt must use YYYY-MM-DD')
  }
  if (now > new Date(`${expiresAt}T23:59:59.999Z`)) {
    throw new Error(`Typecheck baseline expired on ${expiresAt}`)
  }
}

function baselineEntriesFromDiagnostics(diagnostics) {
  return [...countsFor(diagnostics).values()]
    .map(({ diagnostic, count }) => ({ ...diagnostic, count }))
    .toSorted((left, right) => diagnosticKey(left).localeCompare(diagnosticKey(right)))
}

function runTypeScript(repoRoot) {
  const executable = path.join(
    repoRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsc.cmd' : 'tsc',
  )
  return spawnSync(executable, ['--noEmit', '--pretty', 'false'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    shell: process.platform === 'win32',
  })
}

function runCli() {
  const repoRoot = process.cwd()
  const baselinePath = path.join(
    repoRoot,
    'tests',
    'ci-cd',
    'typecheck-baseline.json',
  )
  const result = runTypeScript(repoRoot)
  if (result.error) throw result.error
  if (result.signal) {
    throw new Error(`TypeScript was terminated by ${result.signal}`)
  }

  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  const diagnostics = parseTypeScriptDiagnostics(output, repoRoot)
  if (result.status !== 0 && diagnostics.length === 0) {
    throw new Error(`TypeScript failed without parseable diagnostics:\n${output}`)
  }

  if (process.argv.includes('--write')) {
    const baseline = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      expiresAt: '2026-08-31',
      diagnostics: baselineEntriesFromDiagnostics(diagnostics),
    }
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`)
    console.log(
      `Wrote ${diagnostics.length} TypeScript diagnostics to ${path.relative(repoRoot, baselinePath)}`,
    )
    return
  }

  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
  if (baseline.schemaVersion !== 1 || !Array.isArray(baseline.diagnostics)) {
    throw new Error('Invalid typecheck baseline schema')
  }
  validateBaselineExpiry(baseline.expiresAt)
  const comparison = compareDiagnosticsToBaseline(
    diagnostics,
    baseline.diagnostics,
  )
  if (comparison.additions.length > 0) {
    const detail = comparison.additions
      .slice(0, 50)
      .map(
        (diagnostic) =>
          `${diagnostic.file}: ${diagnostic.code}: ${diagnostic.message}`,
      )
      .join('\n')
    throw new Error(
      `${comparison.additions.length} new TypeScript diagnostic(s):\n${detail}`,
    )
  }

  console.log(
    `Typecheck debt gate passed: ${diagnostics.length} existing, ${comparison.removed} fixed since baseline, 0 new`,
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    runCli()
  } catch (error) {
    console.error(
      `[typecheck-baseline] ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exitCode = 1
  }
}
