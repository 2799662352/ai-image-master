import assert from 'node:assert/strict'
import test from 'node:test'

import {
  compareDiagnosticsToBaseline,
  parseTypeScriptDiagnostics,
  validateBaselineExpiry,
} from './typecheck-baseline.mjs'

test('normalizes TypeScript diagnostics without line-number churn', () => {
  const diagnostics = parseTypeScriptDiagnostics(
    [
      'src/a.ts(10,2): error TS2322: Type string is not assignable to number.',
      'src/a.ts(99,4): error TS2322: Type string is not assignable to number.',
      'src/b.ts(1,1): error TS7006: Parameter x implicitly has an any type.',
    ].join('\n'),
  )

  assert.deepEqual(diagnostics, [
    {
      file: 'src/a.ts',
      code: 'TS2322',
      message: 'Type string is not assignable to number.',
    },
    {
      file: 'src/a.ts',
      code: 'TS2322',
      message: 'Type string is not assignable to number.',
    },
    {
      file: 'src/b.ts',
      code: 'TS7006',
      message: 'Parameter x implicitly has an any type.',
    },
  ])
})

test('captures global diagnostics and fails closed on unknown error formats', () => {
  assert.deepEqual(
    parseTypeScriptDiagnostics(
      [
        'src/a.ts(1,1): error TS2322: Existing positioned error.',
        'error TS18003: No inputs were found in config file.',
      ].join('\n'),
    ),
    [
      {
        file: 'src/a.ts',
        code: 'TS2322',
        message: 'Existing positioned error.',
      },
      {
        file: '<global>',
        code: 'TS18003',
        message: 'No inputs were found in config file.',
      },
    ],
  )
  assert.throws(
    () =>
      parseTypeScriptDiagnostics(
        'prefix: error TS5058: The specified path does not exist.',
      ),
    /Unparseable TypeScript error line/,
  )
})

test('allows fixed diagnostics but rejects additions and higher multiplicity', () => {
  const baseline = [
    {
      file: 'src/a.ts',
      code: 'TS2322',
      message: 'Type string is not assignable to number.',
      count: 2,
    },
  ]

  assert.deepEqual(
    compareDiagnosticsToBaseline(
      [
        {
          file: 'src/a.ts',
          code: 'TS2322',
          message: 'Type string is not assignable to number.',
        },
      ],
      baseline,
    ).additions,
    [],
  )
  assert.equal(
    compareDiagnosticsToBaseline(
      [
        {
          file: 'src/a.ts',
          code: 'TS2322',
          message: 'Type string is not assignable to number.',
        },
        {
          file: 'src/a.ts',
          code: 'TS2322',
          message: 'Type string is not assignable to number.',
        },
        {
          file: 'src/a.ts',
          code: 'TS2322',
          message: 'Type string is not assignable to number.',
        },
      ],
      baseline,
    ).additions.length,
    1,
  )
})

test('requires a future baseline review date', () => {
  assert.doesNotThrow(() =>
    validateBaselineExpiry('2026-08-31', new Date('2026-07-13T00:00:00Z')),
  )
  assert.throws(
    () => validateBaselineExpiry('2026-07-12', new Date('2026-07-13T00:00:00Z')),
    /expired/i,
  )
})
