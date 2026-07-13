import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { parse } from 'yaml'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const workflowsDirectory = path.join(repoRoot, '.github', 'workflows')

function loadWorkflow(name) {
  return parse(readFileSync(path.join(workflowsDirectory, name), 'utf8'))
}

function collectUses(value, result = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectUses(item, result)
  } else if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      if (key === 'uses' && typeof nested === 'string') result.push(nested)
      collectUses(nested, result)
    }
  }
  return result
}

function collectContinueOnError(value, result = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectContinueOnError(item, result)
  } else if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      if (key === 'continue-on-error') result.push(nested)
      collectContinueOnError(nested, result)
    }
  }
  return result
}

test('pnpm is the only lockfile', () => {
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))

  assert.equal(packageJson.packageManager, 'pnpm@10.12.4')
  assert.equal(
    existsSync(path.join(repoRoot, 'package-lock.json')),
    false,
    'package-lock.json must not coexist with the authoritative pnpm-lock.yaml',
  )
  assert.doesNotMatch(
    Object.values(packageJson.scripts).join('\n'),
    /\b(?:npm run|npx)\b/,
    'package scripts must not shell out through a second package manager',
  )
})

test('the active source suite and legacy updater suite have explicit runners', () => {
  const config = readFileSync(path.join(repoRoot, 'vitest.config.ts'), 'utf8')
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))

  assert.match(config, /src\/\*\*/)
  assert.doesNotMatch(
    config,
    /tests\/\*\*/,
    'legacy root suites must not be silently added to the blocking source suite',
  )
  assert.match(config, /maxWorkers:\s*4/)
  assert.match(config, /testTimeout:\s*30000/)
  assert.match(config, /hookTimeout:\s*30000/)
  assert.equal(
    packageJson.scripts['test:updater'],
    'vitest run -c vitest.legacy.config.ts tests/main/updater.test.ts',
  )
  assert.equal(
    packageJson.scripts['test:workflows'],
    'node --test tests/windows-only-workflows.test.mjs',
  )
})

test('CI delegates to one blocking reusable quality gate', () => {
  const workflow = loadWorkflow('ci.yml')
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  assert.equal(
    workflow.jobs.quality.uses,
    './.github/workflows/_quality-gates.yml',
  )
  assert.equal(Object.keys(workflow.jobs).length, 1)
  assert.equal(workflow.concurrency['cancel-in-progress'], true)
})

test('required quality gates are blocking and aggregate explicitly', () => {
  const workflow = loadWorkflow('_quality-gates.yml')
  const requiredJobs = [
    'contracts',
    'typecheck',
    'unit-tests',
    'skill-gates',
    'build',
    'e2e-stable',
  ]
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  for (const jobName of requiredJobs) {
    assert.ok(workflow.jobs[jobName], `missing required job ${jobName}`)
    assert.deepEqual(collectContinueOnError(workflow.jobs[jobName]), [])
  }
  assert.deepEqual(workflow.jobs['quality-gate'].needs, requiredJobs)
  assert.equal(workflow.jobs['quality-gate'].if, '${{ always() }}')
  assert.match(
    workflow.jobs['quality-gate'].steps[0].run,
    /failure\(\)|cancelled\(\)|result/,
  )
  assert.equal(
    workflow.jobs['e2e-stable'].steps.find(
      (step) => step.name === 'Run stable Electron E2E',
    ).run,
    'pnpm run test:e2e:stable',
  )
  const actionlint = workflow.jobs.contracts.steps.find(
    (step) => step.name === 'Validate workflows with actionlint',
  )
  assert.match(actionlint.run, /actionlint_1\.7\.7_linux_amd64/)
  assert.match(
    actionlint.run,
    /023070a287cd8cccd71515fedc843f1985bf96c436b7effaecce67290e7e0757/,
  )
})

test('nonblocking checks are isolated from PR quality status', () => {
  const workflow = loadWorkflow('nonblocking-quality.yml')
  assert.ok(workflow.on.schedule)
  assert.ok(workflow.on.workflow_dispatch !== undefined)
  for (const jobName of ['e2e-extended', 'e2e-quarantine', 'visual', 'benchmark']) {
    assert.equal(workflow.jobs[jobName]['continue-on-error'], true)
  }
})

test('formal release is manual, serialized, and reuses quality/build workflows', () => {
  const workflow = loadWorkflow('release.yml')
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch'])
  assert.deepEqual(
    Object.keys(workflow.on.workflow_dispatch.inputs),
    ['version', 'dry_run', 'canonical_run_id'],
  )
  assert.equal(workflow.concurrency.group, 'production-release')
  assert.equal(workflow.concurrency['cancel-in-progress'], false)
  assert.equal(
    workflow.jobs.quality.uses,
    './.github/workflows/_quality-gates.yml',
  )
  assert.equal(
    workflow.jobs.build.uses,
    './.github/workflows/_windows-release-build.yml',
  )
  assert.deepEqual(workflow.jobs.build.needs, [
    'validate',
    'quality',
    'discover',
  ])
  assert.match(workflow.jobs.build.if, /needs_build/)
  assert.deepEqual(workflow.jobs.discover.permissions, {
    contents: 'read',
    actions: 'read',
  })
  assert.equal(
    workflow.jobs.discover.steps.find(
      (step) => step.name === 'Select trusted source',
    ).env.RELEASE_TAG_EXISTS,
    '${{ needs.validate.outputs.tag_exists }}',
  )
  const historicalDownload = workflow.jobs.canonical.steps.find(
    (step) => step.name === 'Download trusted historical Actions artifact',
  )
  assert.match(historicalDownload.with['github-token'], /GITHUB_TOKEN/)
  assert.match(historicalDownload.with['run-id'], /discover\.outputs\.run_id/)
  assert.equal(workflow.jobs.authenticode['runs-on'], 'windows-latest')
  assert.equal(workflow.jobs.authenticode.needs, 'canonical')
  const canonicalSignatureCheck = workflow.jobs.authenticode.steps.find(
    (step) => step.name === 'Verify declared Windows signature state',
  )
  assert.match(canonicalSignatureCheck.run, /Get-AuthenticodeSignature/)
  assert.match(canonicalSignatureCheck.run, /TimeStamperCertificate/)
  assert.match(canonicalSignatureCheck.run, /NotSigned/)
  assert.deepEqual(workflow.jobs.publish.needs, [
    'validate',
    'quality',
    'canonical',
    'authenticode',
  ])
  assert.equal(workflow.jobs.publish.environment, 'production')
  assert.match(workflow.jobs.publish.if, /dry_run == false/)
  const publishCheckout = workflow.jobs.publish.steps.find(
    (step) => step.name === 'Checkout release control plane',
  )
  assert.equal(publishCheckout.with.ref, '${{ github.sha }}')
  assert.equal(workflow.jobs.summary.if, 'always()')
  assert.ok(workflow.jobs.summary.needs.includes('publish'))
  assert.ok(workflow.jobs.summary.needs.includes('quality'))
  const releaseSummary = workflow.jobs.summary.steps.find(
    (step) => step.name === 'Write unified release summary',
  )
  assert.equal(
    releaseSummary.run,
    'node scripts/release/write-release-summary.mjs',
  )
  assert.ok(releaseSummary.env.QUALITY_RESULT)
  assert.ok(releaseSummary.env.CURRENT_CHANNEL_VERSION)
  const preflightNames = workflow.jobs['cos-preflight'].steps.map(
    (step) => step.name,
  )
  assert.ok(
    preflightNames.indexOf('Verify packaged and runtime updater URLs') <
      preflightNames.indexOf('Verify COS access and remote release state'),
  )
})

test('release writes external state in the required order and promotes last', () => {
  const workflow = loadWorkflow('release.yml')
  const names = workflow.jobs.publish.steps.map((step) => step.name)
  const order = [
    'Create or verify draft and GitHub assets',
    'Upload and verify immutable COS assets',
    'Publish and re-verify GitHub Release',
    'Create deterministic release-ready marker',
    'Upload verified release-ready marker',
    'Promote COS channel and verify public endpoint transactionally',
  ]
  let previous = -1
  for (const name of order) {
    const current = names.indexOf(name)
    assert.ok(current > previous, `${name} is out of order`)
    previous = current
  }
  assert.equal(
    workflow.jobs.publish.steps.some(
      (step) => step.run?.includes('cos-release.mjs verify-public'),
    ),
    false,
  )
  assert.equal(
    names.at(-1),
    'Promote COS channel and verify public endpoint transactionally',
    'channel promotion must remain the last production write step',
  )
})

test('Windows release build never publishes from electron-builder', () => {
  const workflow = loadWorkflow('_windows-release-build.yml')
  const build = workflow.jobs.build
  assert.equal(build['runs-on'], 'windows-latest')
  assert.equal(build.environment, 'production')
  assert.equal(build.strategy, undefined)
  assert.ok(workflow.on.workflow_call.inputs.release_sha.required)
  assert.match(
    build.steps.find((step) => step.name === 'Checkout').with.ref,
    /release_sha/,
  )
  assert.equal(
    build.steps.find((step) => step.name === 'Install dependencies').run,
    'pnpm install --frozen-lockfile',
  )
  const packageStep = build.steps.find(
    (step) => step.name === 'Package Windows x64 artifact',
  )
  assert.match(packageStep.run, /--win --x64 --publish never/)
  const artifactStep = build.steps.find(
    (step) => step.name === 'Upload canonical artifact',
  )
  assert.match(artifactStep.with.path, /release-manifest\.json/)
  assert.doesNotMatch(artifactStep.with.path, /\.(?:dmg|AppImage|deb|zip)/)
  assert.equal(artifactStep.with['retention-days'], 90)
  assert.ok(workflow.on.workflow_call.outputs.artifact_digest)
  assert.match(
    build.steps.find((step) => step.name === 'Verify Authenticode signature').run,
    /TimeStamperCertificate/,
  )
  assert.match(
    build.steps.find((step) => step.name === 'Verify Authenticode signature').run,
    /Write-GitHubOutput "signing_subject"/,
  )
  const signingCleanup = build.steps.find(
    (step) => step.name === 'Cleanup signing material',
  )
  assert.equal(signingCleanup.if, 'always()')
  assert.match(signingCleanup.run, /Remove-Item/)
  assert.match(
    build.steps.find((step) => step.name === 'Record signing mode').run,
    /GITHUB_STEP_SUMMARY[\s\S]*unsigned/,
  )
  const signatureOutput = build.steps.find(
    (step) => step.name === 'Verify Authenticode signature',
  ).run
  assert.match(signatureOutput, /ghadelimiter_/)
  assert.doesNotMatch(signatureOutput, /signing_subject=\$\(/)
})

test('production runtime binaries are pinned by version and SHA-256', () => {
  const packageJson = JSON.parse(
    readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
  )
  const lock = JSON.parse(
    readFileSync(
      path.join(repoRoot, 'scripts', 'runtime-assets.lock.json'),
      'utf8',
    ),
  )
  assert.equal(lock.components.codex.version, packageJson.codexCliVersion)
  assert.equal(lock.components.ffmpeg.version, packageJson.ffmpegBuildTag)
  assert.equal(
    lock.components.dockerMcp.version,
    packageJson.dockerMcpGatewayVersion,
  )
  for (const component of Object.values(lock.components)) {
    const assets = component.targets['win32-x64']
    assert.ok(assets)
    for (const digest of Object.values(assets)) {
      assert.match(digest, /^sha256:[a-f0-9]{64}$/)
    }
  }
})

test('migration and rollback are manual protected serialized operations', () => {
  const migration = loadWorkflow('migrate-release-baseline.yml')
  const rollback = loadWorkflow('rollback-hot-update.yml')
  for (const [name, workflow] of [
    ['migration', migration],
    ['rollback', rollback],
  ]) {
    assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch'])
    assert.equal(workflow.concurrency.group, 'production-release')
    assert.equal(workflow.concurrency['cancel-in-progress'], false)
    const job = Object.values(workflow.jobs)[0]
    assert.equal(job.environment, 'production', `${name} must be protected`)
    assert.ok(
      job.steps.some(
        (step) => step.name === 'Validate explicit confirmation',
      ),
    )
    assert.equal(
      job.steps.find((step) => step.name === 'Validate explicit confirmation')
        .env.WORKFLOW_REF,
      '${{ github.ref }}',
    )
  }
  assert.deepEqual(
    Object.keys(rollback.on.workflow_dispatch.inputs),
    ['version', 'confirm'],
  )
  const rollbackText = readFileSync(
    path.join(workflowsDirectory, 'rollback-hot-update.yml'),
    'utf8',
  )
  assert.doesNotMatch(rollbackText, /electron-builder|gh release|channel:\s*\$\{\{/)
  assert.match(rollbackText, /cos-release\.mjs rollback/)
  const rollbackSummary = rollback.jobs.rollback.steps.find(
    (step) => step.name === 'Record rollback scope',
  )
  assert.ok(rollbackSummary.env.PREVIOUS_VERSION)
  assert.ok(rollbackSummary.env.MANIFEST_SHA256)
  const migrationText = readFileSync(
    path.join(workflowsDirectory, 'migrate-release-baseline.yml'),
    'utf8',
  )
  assert.match(migrationText, /RELEASE_PROVENANCE_KIND:\s*legacy-import/)
  assert.doesNotMatch(migrationText, /RELEASE_PROVENANCE_KIND:\s*actions-build/)
  assert.match(migrationText, /cos-release\.mjs verify-version/)
  assert.match(migrationText, /cos-release\.mjs complete-legacy/)
  assert.match(
    migrationText,
    /Download and verify current public release[\s\S]*manifest_exists != 'true'/,
  )
  assert.match(
    migration.jobs.migrate.steps.find(
      (step) => step.name === 'Inspect existing Authenticode state',
    ).run,
    /ghadelimiter_/,
  )
})

test('third-party actions are pinned to immutable commit SHAs', () => {
  for (const workflowName of [
    'ci.yml',
    '_quality-gates.yml',
    '_windows-release-build.yml',
    'nonblocking-quality.yml',
    'release.yml',
    'migrate-release-baseline.yml',
    'rollback-hot-update.yml',
    'codex-auto-update.yml',
  ]) {
    for (const usage of collectUses(loadWorkflow(workflowName))) {
      if (usage.startsWith('./')) continue
      assert.match(
        usage,
        /^[^@\s]+@[a-f0-9]{40}$/,
        `${workflowName} has an unpinned action: ${usage}`,
      )
    }
  }
})

test('obsolete release side doors and fixed latest channel are absent', () => {
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  const builderConfig = readFileSync(path.join(repoRoot, 'electron-builder.yml'), 'utf8')
  assert.equal(existsSync(path.join(workflowsDirectory, 'build.yml')), false)
  assert.equal(packageJson.scripts['upload:cos'], undefined)
  assert.equal(packageJson.scripts['release:cn'], undefined)
  assert.equal(packageJson.scripts.release, undefined)
  assert.equal(
    packageJson.scripts['release:verify'],
    'node scripts/release/prepare-release.mjs verify',
  )
  assert.match(packageJson.scripts['release:cos:dry'], /--dry-run/)
  assert.doesNotMatch(builderConfig, /^\s*channel:\s*latest\s*$/m)
})

test('Codex bump validation matches the Windows-only release target', () => {
  const workflowText = readFileSync(
    path.join(workflowsDirectory, 'codex-auto-update.yml'),
    'utf8',
  )
  assert.match(workflowText, /CODEX_TARGETS:\s*win32-x64/)
  assert.match(workflowText, /scripts\/runtime-assets\.lock\.json/)
  assert.doesNotMatch(workflowText, /darwin-|linux-x64/)
})
