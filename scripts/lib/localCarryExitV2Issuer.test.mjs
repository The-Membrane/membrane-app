import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  appendLocalCarryExitV2IssuerAttempt,
  appendLocalCarryExitV2IssuerIssues,
} from './localCarryExitV2Issuer.mjs'
import {
  appendLocalCarryExitV2Record,
  verifyLocalCarryExitV2Ledger,
} from './localCarryExitV2Store.mjs'

const rootFor = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'carry-exit-v2-issuer-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'store')
}
const destination = `0x${'1'.repeat(40)}`
const asset = `0x${'2'.repeat(40)}`
const blockHash = `0x${'3'.repeat(64)}`
const recordedAt = '2026-10-06T12:00:00.000Z'

const plan = (overrides = {}) => ({
  version: 'carry_exit_v2',
  clock: 'db_issued_at',
  endpointSelection: 'first_finalized_at_or_after_target',
  captureDeadlineHours: 2,
  horizons: [1, 4, 24, 48, 168],
  routeKey: 'USDC → VaultV2 [USDC]',
  slotAt: '2026-10-06T11:55:00.000Z',
  destination,
  asset,
  assetDecimals: 6,
  holder: `0x${'4'.repeat(40)}`,
  baselineBlock: '123',
  baselineHash: blockHash,
  baselineBlockAt: '2026-10-06T11:59:00.000Z',
  baselineObservedAt: '2026-10-06T11:59:30.000Z',
  candidateProvenance: 'receipt_verified_transfer',
  candidateEvidenceSha256: 'a'.repeat(64),
  candidateEvidenceDoc: { ladder: 'proof' },
  canonicalityEvidenceDoc: { finalized: true },
  omittedLadder: [],
  cases: [
    {
      assetsRaw: '1000000',
      baselineStatus: 'success',
      coverageKind: 'shares',
      holderCoverageRaw: '2000000',
      requiredCoverageRaw: '1000000',
      actualConsumedRaw: '900000',
      simulationStatus: 'success',
      callEvidenceSha256: 'b'.repeat(64),
      callEvidenceDoc: { pinnedBlock: '123' },
      entitlementEvidenceSha256: null,
      entitlementEvidenceDoc: null,
      inconclusiveReason: null,
      unavailableReason: null,
    },
    {
      assetsRaw: '2000000',
      baselineStatus: 'unavailable',
      coverageKind: null,
      holderCoverageRaw: null,
      requiredCoverageRaw: null,
      actualConsumedRaw: null,
      simulationStatus: null,
      callEvidenceSha256: null,
      callEvidenceDoc: null,
      entitlementEvidenceSha256: null,
      entitlementEvidenceDoc: null,
      inconclusiveReason: null,
      unavailableReason: 'quote_unavailable',
    },
  ],
  ...overrides,
})

test('attempt mirror and durable batch produce exact append-only local records', (t) => {
  const root = rootFor(t)
  const attempt = {
    schema: 'carry_exit_v2_issue_attempt_v1',
    slot: 1,
    routeKey: plan().routeKey,
    destination,
    asset,
    at: recordedAt,
    status: 'issued',
    reason: null,
    batchId: '42',
  }
  appendLocalCarryExitV2IssuerAttempt('morpho', attempt, {
    root,
    minFreeBytes: 0,
  })
  appendLocalCarryExitV2IssuerIssues(
    { source: 'morpho', batchId: '42', plan: plan(), recordedAt },
    { root, minFreeBytes: 0 },
  )
  // A recovered replay is idempotent and keeps the first local issue clock.
  appendLocalCarryExitV2IssuerIssues(
    {
      source: 'morpho',
      batchId: '42',
      plan: plan(),
      recordedAt: '2026-10-06T12:05:00.000Z',
    },
    { root, minFreeBytes: 0 },
  )

  const state = verifyLocalCarryExitV2Ledger({ root })
  assert.equal(state.attempts.size, 1)
  assert.equal(state.issues.size, 2)
  const issues = [...state.issues.values()]
  assert.deepEqual(
    issues.map((row) => row.payload.assetsRaw),
    ['1000000', '2000000'],
  )
  assert.ok(issues.every((row) => row.payload.routeKey === plan().routeKey))
  assert.ok(issues.every((row) => row.payload.decimals === 6))
  assert.ok(issues.every((row) => row.payload.issuedAtUtc === recordedAt))
  assert.deepEqual(
    issues[0].payload.plan.map((row) => row.horizonH),
    [1, 4, 24, 48, 168],
  )
  assert.equal(issues[0].payload.proofEnvelope.schema, 'carry_local_exit_v2_issue_proof_v1')
  assert.equal(issues[0].payload.issueEnvelope.schema, 'carry_local_exit_v2_issue_envelope_v1')
  assert.equal(issues[0].payload.issueEnvelope.authoritativeBatchId, '42')
  assert.equal(issues[0].payload.issueEnvelope.sourcePlan.routeKey, issues[0].payload.routeKey)
  assert.equal(
    issues[0].payload.issueEnvelope.caseClassification.assetsRaw,
    issues[0].payload.assetsRaw,
  )
})

test('invalid horizon plan and duplicate exact Q fail before append', () => {
  let writes = 0
  const append = () => {
    writes += 1
  }
  assert.throws(
    () =>
      appendLocalCarryExitV2IssuerIssues(
        { source: 'direct', batchId: '7', plan: plan({ horizons: [1] }), recordedAt },
        { append, verify: () => ({ issues: new Map() }) },
      ),
    /local_exit_v2_plan_invalid/,
  )
  assert.throws(
    () =>
      appendLocalCarryExitV2IssuerIssues(
        {
          source: 'sync_vault',
          batchId: '8',
          plan: plan({ cases: [plan().cases[0], plan().cases[0]] }),
          recordedAt,
        },
        { append, verify: () => ({ issues: new Map() }) },
      ),
    /local_exit_v2_duplicate_q/,
  )
  assert.equal(writes, 0)
})

test('partial batch recovery keeps its first issue clock and appends at the current clock', (t) => {
  const root = rootFor(t)
  let calls = 0
  assert.throws(
    () =>
      appendLocalCarryExitV2IssuerIssues(
        { source: 'direct', batchId: '9', plan: plan(), recordedAt },
        {
          root,
          minFreeBytes: 0,
          append: (...args) => {
            calls += 1
            if (calls === 2) throw Error('simulated_crash')
            return appendLocalCarryExitV2Record(...args)
          },
        },
      ),
    /simulated_crash/,
  )
  assert.equal(verifyLocalCarryExitV2Ledger({ root }).issues.size, 1)

  appendLocalCarryExitV2IssuerIssues(
    {
      source: 'direct',
      batchId: '9',
      plan: plan(),
      recordedAt: '2026-10-06T12:05:00.000Z',
    },
    { root, minFreeBytes: 0 },
  )
  const state = verifyLocalCarryExitV2Ledger({ root })
  assert.equal(state.issues.size, 2)
  assert.ok([...state.issues.values()].every((row) => row.payload.issuedAtUtc === recordedAt))
  assert.equal(state.records.at(-1).recordedAtUtc, '2026-10-06T12:05:00.000Z')
})
