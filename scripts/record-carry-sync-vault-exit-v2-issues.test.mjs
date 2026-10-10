import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { CARRY_EXIT_V2_FROZEN_ROUTES } from './lib/carry-exit-v2-rpc-proof.mjs'
import {
  issueSyncVaultV2Route,
  prepareSyncVaultOrigin,
  recoverSyncVaultLocalIssueMirror,
  selectSyncVaultOrigin,
  selectedSyncVaultRoute,
  syncVaultCaseFromMeasurement,
  syncVaultRouteSupport,
} from './record-carry-sync-vault-exit-v2-issues.mjs'

const vaultRoutes = CARRY_EXIT_V2_FROZEN_ROUTES.filter((route) =>
  ['susds', 'usd3', 'stusds', 'fluid', 'sgho'].includes(route.kind),
)
const fluid = vaultRoutes.find((route) => route.kind === 'fluid')
const supported = vaultRoutes.find((route) => route.kind === 'stusds')
const now = () => new Date('2026-09-30T01:25:01.000Z')
const slot = Math.floor((now().getTime() - 10 * 60_000) / (15 * 60_000))
const assembled = { schema: 'carry_exit_v2_call_evidence_v1', proof: true }
const decoded = (overrides) => ({
  routeKind: 'stusds',
  holderCoverageRaw: '100',
  requiredCoverageRaw: '80',
  actualConsumedRaw: null,
  simulationStatus: 'evm_revert',
  coveredRevert: true,
  ...overrides,
})

const storedRecoveryPlan = (overrides = {}) => {
  const holder = `0x${'4'.repeat(40)}`
  const baselineHash = `0x${'3'.repeat(64)}`
  const holderCommitment = createHash('sha256')
    .update(`${supported.destination}:${holder}`)
    .digest('hex')
  return {
    version: 'carry_exit_v2',
    clock: 'db_issued_at',
    endpointSelection: 'first_finalized_at_or_after_target',
    captureDeadlineHours: 2,
    horizons: [1, 4, 24, 48, 168],
    routeKey: supported.routeKey,
    slotAt: new Date(slot * 15 * 60_000 + 10 * 60_000).toISOString(),
    destination: supported.destination,
    asset: supported.asset,
    assetDecimals: 18,
    holder,
    baselineBlock: '100',
    baselineHash,
    baselineBlockAt: '2026-09-30T01:24:00.000Z',
    baselineObservedAt: '2026-09-30T01:25:00.000Z',
    candidateProvenance: 'receipt_verified_transfer',
    candidateEvidenceSha256: 'a'.repeat(64),
    candidateEvidenceDoc: {
      schema: 'carry_exit_v2_sync_vault_candidate_v1',
      routeKey: supported.routeKey,
      destination: supported.destination,
      asset: supported.asset,
      baselineBlock: '100',
      baselineHash,
      selectedHolderCommitment: holderCommitment,
      screenedCandidates: [{ holderCommitment, status: 'eligible_holder' }],
      ladder: {
        labels: [
          { label: 'q1', assetsRaw: '1', reason: null },
          ...Array.from({ length: 5 }, (_, index) => ({
            label: `omitted_${index}`,
            assetsRaw: null,
            reason: 'zero_sized',
          })),
        ],
      },
    },
    canonicalityEvidenceDoc: { schema: 'carry_exit_v2_headers_v1' },
    omittedLadder: Array.from({ length: 5 }, (_, index) => ({
      label: `omitted_${index}`,
      reason: 'zero_sized',
      duplicateOf: null,
    })),
    cases: [
      {
        assetsRaw: '1',
        baselineStatus: 'unavailable',
        coverageKind: null,
        holderCoverageRaw: null,
        requiredCoverageRaw: null,
        actualConsumedRaw: null,
        simulationStatus: null,
        callEvidenceDoc: null,
        callEvidenceSha256: null,
        entitlementMethod: null,
        entitlementEvidenceDoc: null,
        entitlementEvidenceSha256: null,
        inconclusiveReason: null,
        unavailableReason: 'quote_unavailable',
      },
    ],
    ...overrides,
  }
}
const storedBatch = (plan, batchId = '61') => ({
  batchId,
  plan,
  planSha256: 'f'.repeat(64),
  digestIntegrity: { plan: true, candidate: true, cases: true },
  childRowsValid: true,
})

test('rotation covers exactly eight frozen route/destination/asset subjects', () => {
  assert.equal(vaultRoutes.length, 8)
  const seen = new Set()
  const start = Date.parse('2026-09-30T01:10:00.000Z')
  for (let n = 0; n < 8; n++) {
    const selected = selectedSyncVaultRoute(start + n * 15 * 60_000)
    seen.add(`${selected.route.routeKey}:${selected.route.destination}:${selected.route.asset}`)
    assert.equal(selected.routeCount, 8)
  }
  assert.equal(seen.size, 8)
  assert.equal(vaultRoutes.filter((r) => !syncVaultRouteSupport(r).supported).length, 4)
})

test('sGHO joins original-GHO issue lane while USDe conversion route remains unsupported', () => {
  const sgho = vaultRoutes.find((route) => route.kind === 'sgho')
  assert.equal(sgho.routeKey, 'GHO → sGho [GHO]')
  assert.equal(syncVaultRouteSupport(sgho).supported, true)
  assert.equal(
    vaultRoutes.some((route) => route.routeKey === 'USDe → sGho [GHO]'),
    false,
  )
  assert.equal(
    syncVaultCaseFromMeasurement('1', assembled, decoded({ routeKind: 'sgho' })).baselineStatus,
    'covered_revert',
  )
})

test('public-only preflight falls through head-only origins to oldest-log capable candidate', async () => {
  const route = vaultRoutes.find((item) => item.kind === 'sgho')
  const reads = []
  const urls = ['https://one.example', 'https://two.example', 'https://three.example']
  const transport = (url) => ({
    url,
    provider: url,
    request: async (method, params) => {
      reads.push({ url, method, params })
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_getBlockByNumber') return { number: '0x1388' }
      if (method === 'eth_getLogs' && url !== urls[2]) throw Error('old_logs_unavailable')
      if (method === 'eth_getLogs') return []
      throw Error('unexpected_request')
    },
  })
  const capable = await selectSyncVaultOrigin(urls, route, transport, Date.now() + 60_000)
  assert.equal(capable.url, urls[2])
  const preflight = await prepareSyncVaultOrigin({
    urls,
    route,
    slot,
    deadlineMs: Date.now() + 60_000,
    transport,
    captureBaseline: async ({ request, ...identity }) => {
      assert.equal(identity.provider, urls[2])
      await request('eth_chainId', [])
      return { ...route, targetBlock: '5000' }
    },
    discoverCandidate: async ({ baseline, request }) => {
      assert.equal(baseline.targetBlock, '5000')
      await request('eth_chainId', [])
      return { holder: `0x${'1'.repeat(40)}` }
    },
  })
  assert.equal(preflight.primary.url, urls[2])
  assert.equal(preflight.candidate.holder, `0x${'1'.repeat(40)}`)
  assert.equal(reads.filter(({ method }) => method === 'eth_getLogs').length, 8)
})

test('preflight with no candidate records unavailable without rescanning or private DB holder RPC', async () => {
  const route = vaultRoutes.find((item) => item.kind === 'sgho')
  const attempts = []
  const result = await issueSyncVaultV2Route({
    sql: null,
    slot,
    route,
    primary: { url: 'https://one.example', provider: 'https://one.example' },
    secondary: { url: 'https://two.example', provider: 'https://two.example' },
    preflight: { baseline: { ...route, targetBlock: '5000' }, candidate: null },
    now,
    appendAttempt: async (value) => attempts.push(value),
    recordDbAttempt: async () => '1',
    captureBaseline: async () => {
      throw Error('must_not_rescan')
    },
    discoverCandidate: async () => {
      throw Error('must_not_rescan')
    },
  })
  assert.deepEqual(result, { status: 'unavailable', reason: 'candidate_unavailable' })
  assert.equal(attempts[0].candidateEvidenceDoc, null)
})

test('Fluid attempt is local and DB durable without any RPC or private holder/Q', async () => {
  const local = []
  const database = []
  const result = await issueSyncVaultV2Route({
    sql: null,
    slot,
    route: fluid,
    primary: null,
    secondary: null,
    now,
    appendAttempt: async (record) => local.push(record),
    recordDbAttempt: async (...args) => database.push(args),
    recordLocalIssues: async () => {
      throw Error('fluid_must_not_issue')
    },
    captureBaseline: () => {
      throw Error('must_not_call_rpc')
    },
  })
  assert.deepEqual(result, { status: 'unavailable', reason: 'fluid_delivery_unproven' })
  assert.equal(local.length, 1)
  assert.equal(local[0].candidateEvidenceDoc, null)
  assert.equal(local[0].baselineEvidenceDoc, null)
  assert.deepEqual(database[0].slice(2, 5), [slot, 'unavailable', 'identity_unavailable'])
})

test('successful simulation takes precedence over preview estimate above shares', () => {
  const value = syncVaultCaseFromMeasurement(
    '90',
    assembled,
    decoded({
      holderCoverageRaw: '99',
      requiredCoverageRaw: '100',
      actualConsumedRaw: '99',
      simulationStatus: 'success',
      coveredRevert: false,
    }),
  )
  assert.equal(value.baselineStatus, 'success')
  assert.equal(value.actualConsumedRaw, '99')
  assert.equal(value.coverageKind, 'shares')
})

test('covered revert and ambiguous preview gap remain distinct', () => {
  assert.equal(
    syncVaultCaseFromMeasurement('90', assembled, decoded()).baselineStatus,
    'covered_revert',
  )
  const gap = syncVaultCaseFromMeasurement(
    '90',
    assembled,
    decoded({
      holderCoverageRaw: '50',
      requiredCoverageRaw: '80',
      coveredRevert: false,
    }),
  )
  assert.equal(gap.baselineStatus, 'inconclusive')
  assert.equal(gap.inconclusiveReason, 'preview_gap')
  assert.equal(gap.simulationStatus, 'evm_revert')
  assert.equal(gap.callEvidenceDoc.inconclusiveReason, 'preview_gap')
  assert.equal(gap.entitlementEvidenceDoc.inconclusiveReason, 'preview_gap')
  assert.equal(gap.entitlementEvidenceDoc.simulationStatus, 'evm_revert')
})

test('zero preview requirement stays unavailable even after successful simulation', () => {
  const zero = syncVaultCaseFromMeasurement(
    '1',
    assembled,
    decoded({ requiredCoverageRaw: '0', simulationStatus: 'success', actualConsumedRaw: '1' }),
  )
  assert.equal(zero.baselineStatus, 'unavailable')
  assert.equal(zero.callEvidenceDoc, null)
})

test('zero shares are ineligible, while unverified proofs remain unavailable', () => {
  const zero = syncVaultCaseFromMeasurement(
    '1',
    assembled,
    decoded({
      holderCoverageRaw: '0',
      requiredCoverageRaw: '1',
      coveredRevert: false,
    }),
  )
  assert.equal(zero.baselineStatus, 'ineligible')
  assert.equal(zero.entitlementMethod, 'zero_shares')
  assert.equal(syncVaultCaseFromMeasurement('1', null, decoded()).baselineStatus, 'unavailable')
  assert.equal(
    syncVaultCaseFromMeasurement('1', assembled, decoded({ routeKind: 'fluid' })).baselineStatus,
    'unavailable',
  )
})

test('supported route without independent secondary records unavailable before holder discovery', async () => {
  const attempts = []
  const result = await issueSyncVaultV2Route({
    sql: null,
    slot,
    route: supported,
    primary: { url: 'https://one.example', provider: 'https://one.example' },
    secondary: { url: 'https://one.example' },
    now,
    appendAttempt: async (record) => attempts.push(record),
    recordDbAttempt: async () => '1',
    captureBaseline: () => {
      throw Error('unexpected_rpc')
    },
  })
  assert.equal(result.reason, 'independent_rpc_unavailable')
  assert.equal(attempts[0].candidateEvidenceDoc, null)
})

test('issue freezes holder and two Qs before replay; unverified calls stay unavailable', async () => {
  const calls = []
  const holder = `0x${'1'.repeat(40)}`
  const evidenceDoc = {
    ladder: {
      labels: [
        { label: 'holder', assetsRaw: '5', reason: null },
        { label: 'fraction', assetsRaw: '50', reason: null },
        { label: 'zero', assetsRaw: null, reason: 'zero_sized' },
        { label: 'duplicate', assetsRaw: null, reason: 'duplicate_q', duplicateOf: 'holder' },
        { label: 'other_zero', assetsRaw: null, reason: 'zero_sized' },
        {
          label: 'other_duplicate',
          assetsRaw: null,
          reason: 'duplicate_q',
          duplicateOf: 'fraction',
        },
      ],
    },
  }
  const candidate = {
    holder,
    evidenceDoc,
    digest: (await import('node:crypto'))
      .createHash('sha256')
      .update(JSON.stringify(evidenceDoc))
      .digest('hex'),
  }
  const primary = {
    url: 'https://one.example/x',
    provider: 'https://one.example',
    request: async () => {
      throw Error('unexpected_scalar_rpc')
    },
    send: async () => ({}),
  }
  const secondary = {
    url: 'https://two.example/x',
    provider: 'https://two.example',
    send: async () => ({}),
  }
  const result = await issueSyncVaultV2Route({
    sql: null,
    slot,
    route: supported,
    primary,
    secondary,
    now,
    captureBaseline: async () => ({
      routeKey: supported.routeKey,
      destination: supported.destination,
      asset: supported.asset,
      assetDecimals: 18,
      targetBlock: '100',
      targetHash: `0x${'a'.repeat(64)}`,
      targetBlockAt: '2026-09-30T01:24:00.000Z',
      targetObservedAt: '2026-09-30T01:25:00.000Z',
      canonicalityEvidenceDoc: {},
    }),
    discoverCandidate: async () => candidate,
    collect: async (args) => {
      calls.push([args.holder, args.assetsRaw])
      return { proof: {}, identityEvidence: {} }
    },
    verify: async () => ({ status: 'unavailable' }),
    hashEvidence: async () => 'a'.repeat(64),
    persist: async (_sql, plan) => {
      calls.push(plan)
      return '42'
    },
    appendAttempt: async () => {},
    recordDbAttempt: async () => '1',
    recordLocalIssues: async (value) => calls.push({ localIssue: value }),
  })
  assert.equal(result.status, 'issued')
  assert.deepEqual(calls.slice(0, 2), [
    [holder, '5'],
    [holder, '50'],
  ])
  const plan = calls[2]
  assert.equal(plan.cases.length, 2)
  assert.deepEqual(
    plan.cases.map((x) => x.baselineStatus),
    ['unavailable', 'unavailable'],
  )
  assert.equal(plan.omittedLadder.length, 4)
  assert.equal(plan.holder, holder)
  assert.equal(plan.candidateProvenance, 'receipt_verified_transfer')
  assert.equal(calls[3].localIssue.batchId, '42')
  assert.equal(calls[3].localIssue.plan, plan)
})

test('sync-vault issued-attempt recovery restores the exact stored local mirror', async () => {
  const plan = storedRecoveryPlan()
  const calls = []
  const recovered = await recoverSyncVaultLocalIssueMirror({
    sql: null,
    route: supported,
    slot,
    existingAttempt: { status: 'issued', batch_id: '61' },
    loadStoredBatch: async (expectedBatchId) => {
      assert.equal(expectedBatchId, '61')
      return storedBatch(plan)
    },
    recordLocalIssues: async (value) => calls.push(value),
    recordedAt: now(),
  })
  assert.equal(recovered.plan, plan)
  assert.equal(calls[0].plan, plan)
  assert.equal(calls[0].source, 'sync_vault')
})

test('sync-vault recovery rejects the wrong stored slot and candidate schema', async () => {
  for (const plan of [
    storedRecoveryPlan({ slotAt: '2026-09-30T01:10:00.000Z' }),
    storedRecoveryPlan({
      candidateEvidenceDoc: {
        ...storedRecoveryPlan().candidateEvidenceDoc,
        schema: 'carry_exit_v2_direct_candidate_v1',
      },
    }),
  ]) {
    await assert.rejects(
      () =>
        recoverSyncVaultLocalIssueMirror({
          sql: null,
          route: supported,
          slot,
          loadStoredBatch: async () => storedBatch(plan),
          recordLocalIssues: async () => assert.fail('must not mirror'),
        }),
      /local_exit_v2_stored_(plan|candidate)_invalid/,
    )
  }
})
