import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildSyncVaultRollbackPlan,
  frozenUsd3Route,
  runSyncVaultRollbackGate,
} from './check-carry-sync-vault-exit-v2-issue-rollback.mjs'

const route = frozenUsd3Route()
const baseline = {
  assetDecimals: 6,
  targetBlock: '123',
  targetHash: `0x${'3'.repeat(64)}`,
  targetBlockAt: '2026-09-30T00:00:00.000Z',
  targetObservedAt: '2026-09-30T00:01:00.000Z',
  canonicalityEvidenceDoc: { schema: 'carry_exit_v2_headers_v1' },
}
const candidate = {
  holder: `0x${'4'.repeat(40)}`,
  evidenceDoc: {
    schema: 'carry_exit_v2_sync_vault_candidate_v1',
    selectedHolderCommitment: 'a'.repeat(64),
    ladder: {
      labels: [
        { label: 'holder', assetsRaw: '5', reason: null },
        { label: 'fraction', assetsRaw: '50', reason: null },
        { label: 'third', assetsRaw: null, reason: 'zero_sized' },
        { label: 'fourth', assetsRaw: null, reason: 'duplicate_q', duplicateOf: 'holder' },
        { label: 'fifth', assetsRaw: null, reason: 'duplicate_q', duplicateOf: 'fraction' },
        { label: 'sixth', assetsRaw: null, reason: 'zero_sized' },
      ],
    },
  },
}
const cases = [
  {
    assetsRaw: '5',
    baselineStatus: 'success',
    coverageKind: 'shares',
    callEvidenceDoc: { schema: 'public_call' },
    callEvidenceSha256: null,
  },
  {
    assetsRaw: '50',
    baselineStatus: 'inconclusive',
    simulationStatus: 'evm_revert',
    coverageKind: 'shares',
    callEvidenceDoc: { schema: 'public_call' },
    entitlementEvidenceDoc: { schema: 'public_entitlement' },
    callEvidenceSha256: null,
    entitlementEvidenceSha256: null,
  },
]
const planArgs = {
  route,
  baseline,
  candidate,
  cases,
  slotAt: '2026-09-30T00:10:00.000Z',
  candidateDigest: 'a'.repeat(64),
}

test('rollback plan preserves ordered positive Q and requires a measured inconclusive case', () => {
  const plan = buildSyncVaultRollbackPlan(planArgs)
  assert.deepEqual(
    plan.cases.map((x) => x.assetsRaw),
    ['5', '50'],
  )
  assert.equal(plan.omittedLadder.length, 4)
  assert.equal(plan.candidateProvenance, 'receipt_verified_transfer')
  assert.deepEqual(plan.horizons, [1, 4, 24, 48, 168])
  assert.throws(
    () => buildSyncVaultRollbackPlan({ ...planArgs, cases: cases.toReversed() }),
    /case_ladder_mismatch/,
  )
  assert.throws(
    () =>
      buildSyncVaultRollbackPlan({
        ...planArgs,
        cases: [cases[0], { assetsRaw: '50', baselineStatus: 'unavailable' }],
      }),
    /inconclusive_q_unavailable/,
  )
})

test('all public holder/Q evidence precedes DB pool creation; issue is rolled back and same-XID witness rejected', async () => {
  let publicReady = false
  let rolledBack = false
  let ddlApplied = false
  let released = false
  let ended = false
  const queries = []
  let issuedPlan
  const client = {
    async query(sql, args = []) {
      queries.push(sql)
      if (sql.includes('pg_class c JOIN pg_namespace'))
        return { rows: [{ relations: 0, functions: 0 }] }
      if (sql.startsWith('SELECT date_bin'))
        return { rows: [{ slot_at: new Date(planArgs.slotAt) }] }
      if (sql.startsWith('SELECT encode(sha256')) return { rows: [{ digest: 'a'.repeat(64) }] }
      if (sql.includes('SELECT carry_exit_v2_issue(')) {
        issuedPlan = JSON.parse(args[0])
        return { rows: [{ batch_id: '7' }] }
      }
      if (sql.includes('SELECT carry_exit_v2_witness_committed_issue'))
        throw Error('exit_v2_issue_not_visibly_committed_before_first_target')
      if (sql.includes('count(*)::integer FROM carry_exit_v2_cases WHERE batch_id'))
        return { rows: [{ cases: 2, plans: 10, inconclusive: 1, unavailable: 0 }] }
      if (sql === 'ROLLBACK') rolledBack = true
      return { rows: [] }
    },
    release() {
      released = true
    },
  }
  const result = await runSyncVaultRollbackGate({
    dbUrl: 'private-db-value',
    rpcUrls: 'public-rpc-value',
    publicEvidence: async () => {
      publicReady = true
      return { route, baseline, candidate, cases }
    },
    poolFactory: (url) => {
      assert.equal(url, 'private-db-value')
      assert.equal(publicReady, true)
      return {
        connect: async () => client,
        end: async () => {
          ended = true
        },
      }
    },
    applyDdl: async () => {
      ddlApplied = true
    },
  })
  assert.equal(ddlApplied, true)
  assert.equal(rolledBack, true)
  assert.equal(released, true)
  assert.equal(ended, true)
  assert.equal(result.schema, 'absent_after_rollback')
  assert.equal(result.sameXidWitness, 'rejected')
  assert.equal(result.inconclusive, 1)
  assert.equal(issuedPlan.cases[1].entitlementEvidenceSha256, 'a'.repeat(64))
  assert.ok(!queries.includes('COMMIT'))
  assert.ok(queries.indexOf('SAVEPOINT witness_probe') < queries.indexOf('ROLLBACK'))
  assert.ok(!JSON.stringify(result).includes(candidate.holder))
  assert.ok(!JSON.stringify(result).includes('private-db-value'))
})

test('missing public inconclusive Q prevents any private DB connection', async () => {
  let opened = false
  await assert.rejects(
    () =>
      runSyncVaultRollbackGate({
        dbUrl: 'private-db-value',
        rpcUrls: 'public-rpc-value',
        publicEvidence: async () => ({
          route,
          baseline,
          candidate,
          cases: [cases[0], { assetsRaw: '50', baselineStatus: 'unavailable' }],
        }),
        poolFactory: () => {
          opened = true
          throw Error('must_not_connect')
        },
      }),
    /inconclusive_q_unavailable/,
  )
  assert.equal(opened, false)
})
