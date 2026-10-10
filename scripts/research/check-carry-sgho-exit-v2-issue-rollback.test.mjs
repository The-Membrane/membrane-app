import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildSghoRollbackPlan,
  derivePublicSghoEvidence,
  frozenSghoRoute,
  runSghoRollbackGate,
} from './check-carry-sgho-exit-v2-issue-rollback.mjs'

const route = frozenSghoRoute()
const baseline = {
  routeKey: route.routeKey,
  destination: route.destination,
  asset: route.asset,
  assetDecimals: 18,
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
    simulationStatus: 'success',
    coverageKind: 'shares',
    actualConsumedRaw: '4',
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

test('rollback plan preserves ordered positive Q and requires measured success', () => {
  const plan = buildSghoRollbackPlan(planArgs)
  assert.deepEqual(
    plan.cases.map((x) => x.assetsRaw),
    ['5', '50'],
  )
  assert.equal(plan.omittedLadder.length, 4)
  assert.equal(plan.candidateProvenance, 'receipt_verified_transfer')
  assert.deepEqual(plan.horizons, [1, 4, 24, 48, 168])
  assert.throws(
    () => buildSghoRollbackPlan({ ...planArgs, cases: cases.toReversed() }),
    /case_ladder_mismatch/,
  )
  assert.throws(
    () =>
      buildSghoRollbackPlan({
        ...planArgs,
        cases: [{ assetsRaw: '5', baselineStatus: 'unavailable' }, cases[1]],
      }),
    /measured_success_unavailable/,
  )
  assert.throws(
    () =>
      buildSghoRollbackPlan({
        ...planArgs,
        cases: [{ ...cases[0], callEvidenceDoc: null }, cases[1]],
      }),
    /measured_success_unavailable/,
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
  let objectCountReads = 0
  const client = {
    async query(sql, args = []) {
      queries.push(sql)
      if (sql.includes('pg_class c JOIN pg_namespace')) {
        objectCountReads++
        return { rows: [{ relations: 0, functions: 0 }] }
      }
      if (sql.startsWith('SELECT date_bin'))
        return { rows: [{ slot_at: new Date(planArgs.slotAt) }] }
      if (sql.startsWith('SELECT encode(sha256')) return { rows: [{ digest: 'a'.repeat(64) }] }
      if (sql.startsWith('WITH sample AS MATERIALIZED'))
        return {
          rows: [
            {
              baseline_age_minutes: 18.5,
              baseline_fresh: true,
              slot_matches_current_bin: true,
              candidate_identity_matches: true,
              candidate_selection_valid: true,
              ladder_basis_matches: true,
              ladder_claim_matches: true,
              ladder_total_matches: true,
              candidate_ladder_valid: true,
              ladder_label_matches: [true, true, true, true, true, true],
              legacy_floor_matches_exact_division: [true, true, true, false, false, false],
              candidate_state_valid: true,
              candidate_screen_matches: true,
            },
          ],
        }
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
  const result = await runSghoRollbackGate({
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
  assert.equal(objectCountReads, 2)
  assert.equal(result.sameXidWitness, 'rejected')
  assert.equal(result.inconclusive, 1)
  assert.equal(issuedPlan.cases[1].entitlementEvidenceSha256, 'a'.repeat(64))
  assert.ok(!queries.includes('COMMIT'))
  assert.ok(queries.indexOf('SAVEPOINT witness_probe') < queries.indexOf('ROLLBACK'))
  assert.ok(
    queries.findIndex((sql) => sql.startsWith('SELECT date_bin')) >
      queries.findIndex((sql) => sql.startsWith('SELECT encode(sha256')),
  )
  assert.ok(!JSON.stringify(result).includes(candidate.holder))
  assert.ok(!JSON.stringify(result).includes('private-db-value'))
})

test('missing measured public success prevents any private DB connection', async () => {
  let opened = false
  await assert.rejects(
    () =>
      runSghoRollbackGate({
        dbUrl: 'private-db-value',
        rpcUrls: 'public-rpc-value',
        publicEvidence: async () => ({
          route,
          baseline,
          candidate,
          cases: [{ assetsRaw: '5', baselineStatus: 'unavailable' }, cases[1]],
        }),
        poolFactory: () => {
          opened = true
          throw Error('must_not_connect')
        },
      }),
    /measured_success_unavailable/,
  )
  assert.equal(opened, false)
})

test('exact GHO route measures each positive public Q on two origins and keeps an inconclusive Q', async () => {
  const primary = {
    url: 'https://one.example/rpc',
    provider: 'https://one.example',
    send: async () => null,
  }
  const secondary = { url: 'https://two.example/rpc', send: async () => null }
  const measured = []
  const bundle = await derivePublicSghoEvidence({
    rpcUrls: primary.url,
    secondaryUrl: secondary.url,
    now: () => new Date('2026-09-30T01:12:00.000Z'),
    transport: () => secondary,
    prepare: async ({ route: selected }) => {
      assert.deepEqual(selected, route)
      return { primary, baseline, candidate }
    },
    measure: async (input) => {
      measured.push(input.assetsRaw)
      assert.equal(input.holder, candidate.holder)
      assert.equal(input.asset, route.asset)
      assert.equal(input.target, baseline)
      assert.equal(input.primary.url, primary.url)
      assert.equal(input.secondary.url, secondary.url)
      return { status: 'verified', callEvidenceDoc: { schema: 'public_call' } }
    },
    decode: ({ assetsRaw }) => ({
      routeKind: 'sgho',
      holderCoverageRaw: '100',
      requiredCoverageRaw: assetsRaw === '5' ? '10' : '120',
      actualConsumedRaw: assetsRaw === '5' ? '10' : null,
      simulationStatus: assetsRaw === '5' ? 'success' : 'evm_revert',
    }),
  })
  assert.deepEqual(measured, ['5', '50'])
  assert.deepEqual(
    bundle.cases.map((item) => item.baselineStatus),
    ['success', 'inconclusive'],
  )
  assert.equal(bundle.cases[1].simulationStatus, 'evm_revert')
})
