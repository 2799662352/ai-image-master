import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { parse } from 'yaml'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const nonWindowsArtifactPattern = /\.(?:dmg|zip|AppImage|deb)/

function loadWorkflow(name) {
  return parse(readFileSync(path.join(repoRoot, '.github', 'workflows', name), 'utf8'))
}

function loadPackageJson() {
  return JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
}

function findStep(job, name) {
  return job.steps.find((step) => step.name === name)
}

function assertFetchesWindowsRuntimes(job) {
  const fetchStep = findStep(job, 'Fetch Windows runtime binaries')
  assert.ok(fetchStep, 'Windows packaging job must fetch bundled runtime binaries')
  assert.equal(
    fetchStep.run.trim(),
    ['pnpm codex:fetch', 'pnpm ffmpeg:fetch', 'pnpm docker-mcp:fetch'].join('\n'),
  )
  assert.ok(fetchStep.env, 'Runtime fetch step must authenticate GitHub API requests')
  assert.equal(fetchStep.env.GITHUB_TOKEN, '${{ secrets.GITHUB_TOKEN }}')
}

test('Build and Release produces only Windows artifacts', () => {
  const workflow = loadWorkflow('build.yml')
  const build = workflow.jobs.build

  assert.equal(build['runs-on'], 'windows-latest')
  assert.equal(build.strategy, undefined)
  assertFetchesWindowsRuntimes(build)
  assert.equal(findStep(build, 'Build Electron app').run, 'pnpm run build:win')

  const artifactStep = findStep(build, 'Upload artifacts')
  assert.equal(artifactStep.with.name, 'win-build')
  assert.match(artifactStep.with.path, /release\/\*\.exe/)
  assert.doesNotMatch(artifactStep.with.path, nonWindowsArtifactPattern)
})

test('CI packages the Electron app only on Windows', () => {
  const workflow = loadWorkflow('ci.yml')
  const build = workflow.jobs.build

  assert.equal(build.name, 'Build (Windows)')
  assert.equal(build['runs-on'], 'windows-latest')
  assert.equal(build.strategy, undefined)
  assertFetchesWindowsRuntimes(build)
  assert.equal(findStep(build, 'Build Electron app').run, 'pnpm run build:win')
})

test('CI runs the Windows-only workflow contract tests', () => {
  const workflow = loadWorkflow('ci.yml')
  const packageJson = loadPackageJson()

  assert.equal(
    packageJson.scripts['test:workflows'],
    'node --test tests/windows-only-workflows.test.mjs',
  )
  assert.equal(
    findStep(workflow.jobs['lint-and-typecheck'], 'Run workflow contract tests').run,
    'pnpm run test:workflows',
  )
})

test('CI passes Playwright projects without a stray argument separator', () => {
  const workflow = loadWorkflow('ci.yml')

  assert.equal(
    findStep(workflow.jobs['e2e-tests'], 'Run E2E tests').run,
    'pnpm exec playwright test --project=electron',
  )
  assert.equal(
    findStep(workflow.jobs['visual-tests'], 'Run visual regression tests').run,
    'pnpm exec playwright test --project=visual',
  )
})

test('tag releases build and publish only Windows artifacts', () => {
  const workflow = loadWorkflow('release.yml')
  const release = workflow.jobs.release

  assert.equal(release.name, 'Build (Windows)')
  assert.equal(release['runs-on'], 'windows-latest')
  assert.equal(release.strategy, undefined)
  assertFetchesWindowsRuntimes(release)
  const windowsBuildStep = findStep(release, 'Build and publish (Windows)')
  assert.equal(windowsBuildStep.if, undefined)
  assert.equal(windowsBuildStep.run, 'pnpm exec electron-builder --win')
  assert.equal(findStep(release, 'Build and publish (macOS)'), undefined)

  const artifactStep = findStep(release, 'Upload release artifacts')
  assert.equal(artifactStep.with.name, 'release-win')
  assert.match(artifactStep.with.path, /release\/\*\.exe/)
  assert.doesNotMatch(artifactStep.with.path, nonWindowsArtifactPattern)

  const createReleaseStep = findStep(workflow.jobs['create-release'], 'Create Release')
  assert.match(createReleaseStep.with.files, /release-artifacts\/\*\*\/\*\.exe/)
  assert.doesNotMatch(createReleaseStep.with.files, nonWindowsArtifactPattern)
})
