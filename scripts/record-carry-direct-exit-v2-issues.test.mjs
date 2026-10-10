import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'

import { CARRY_EXIT_V2_FROZEN_ROUTES } from './lib/carry-exit-v2-rpc-proof.mjs'
import {
  selectedDirectRoute,
  selectDirectOrigin,
  prepareDirectOrigin,
  recoverDirectLocalIssueMirror,
  issuePreparedDirectV2Route,
  directCaseFromMeasurement,
  issueDirectV2Route,
} from './record-carry-direct-exit-v2-issues.mjs'

const route = CARRY_EXIT_V2_FROZEN_ROUTES.find((entry) => entry.kind === 'comet')
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const recoveryTick = Date.UTC(2026, 8, 30, 2, 11)
const recoverySlot = Math.floor((recoveryTick - 10 * 60_000) / (15 * 60_000))

const storedRecoveryPlan = (overrides = {}) => {
  const holder = `0x${'4'.repeat(40)}`
  const baselineHash = `0x${'3'.repeat(64)}`
  const holderCommitment = createHash('sha256')
    .update(`${route.destination}:${holder}`)
    .digest('hex')
  return {
    version: 'carry_exit_v2',
    clock: 'db_issued_at',
    endpointSelection: 'first_finalized_at_or_after_target',
    captureDeadlineHours: 2,
    horizons: [1, 4, 24, 48, 168],
    routeKey: route.routeKey,
    slotAt: new Date(recoverySlot * 15 * 60_000 + 10 * 60_000).toISOString(),
    destination: route.destination,
    asset: route.asset,
    assetDecimals: 6,
    holder,
    baselineBlock: '100',
    baselineHash,
    baselineBlockAt: '2026-09-30T02:10:00.000Z',
    baselineObservedAt: '2026-09-30T02:10:30.000Z',
    candidateProvenance: 'receipt_verified_supply',
    candidateEvidenceSha256: 'a'.repeat(64),
    candidateEvidenceDoc: {
      schema: 'carry_exit_v2_direct_candidate_v1',
      routeKey: route.routeKey,
      destination: route.destination,
      asset: route.asset,
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
const storedBatch = (plan, batchId = '51') => ({
  batchId,
  plan,
  planSha256: 'f'.repeat(64),
  digestIntegrity: { plan: true, candidate: true, cases: true },
  childRowsValid: true,
})

test('direct roster derives every supported placement, including Aave V3 USDe', () => {
  const base = Date.UTC(2026, 8, 30, 2, 10)
  const routes = [0, 1, 2, 3].map((offset) => selectedDirectRoute(base + offset * 900_000))
  assert.deepEqual(
    new Set(routes.map((row) => row.route.kind)),
    new Set(['aave', 'spark', 'comet']),
  )
  assert.ok(routes.every((row) => row.routeCount === 4))
  const usde = routes.find((row) => row.route.routeKey === 'USDe → supply on Aave V3')
  assert.equal(usde.route.kind, 'aave')
  assert.equal(usde.route.asset, '0x4c9edd5852cd905f086c759e8383e09bff1e68b3')
  assert.equal(
    directCaseFromMeasurement(
      '100',
      { schema: 'verified' },
      {
        routeKind: usde.route.kind,
        holderCoverageRaw: '120',
        requiredCoverageRaw: '100',
        simulationStatus: 'success',
        coveredRevert: false,
      },
    ).baselineStatus,
    'success',
  )
})

test('direct roster fails closed on unsupported kinds and invalid direct metadata', () => {
  const base = Date.UTC(2026, 8, 30, 2, 10)
  assert.throws(
    () =>
      selectedDirectRoute(base, [
        ...CARRY_EXIT_V2_FROZEN_ROUTES,
        {
          kind: 'unknown',
          routeKey: 'bad',
          destination: `0x${'1'.repeat(40)}`,
          asset: `0x${'2'.repeat(40)}`,
        },
      ]),
    /direct_route_registry_invalid/,
  )
  const broken = CARRY_EXIT_V2_FROZEN_ROUTES.map((entry) =>
    entry.routeKey === 'USDe → supply on Aave V3'
      ? { ...entry, holderCoverageTarget: entry.withdrawTarget }
      : entry,
  )
  assert.throws(() => selectedDirectRoute(base, broken), /direct_route_roster_changed/)
})

test('origin selection fails over when recent logs work but old lookback logs do not', async () => {
  const calls = []
  const transport = (url) => ({
    url,
    async request(method, params) {
      calls.push({ url, method, params })
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_getBlockByNumber') return { number: '0x2000' }
      if (method === 'eth_getLogs') {
        if (url === 'https://recent-only.example' && params[0].fromBlock === '0x1000')
          throw Error('rpc_http_400')
        return []
      }
      throw Error('unexpected_method')
    },
  })
  const selected = await selectDirectOrigin(
    ['https://recent-only.example', 'https://historical.example'],
    route,
    transport,
  )
  assert.equal(selected.url, 'https://historical.example')
  const old = calls.filter(
    (call) => call.method === 'eth_getLogs' && call.params[0].fromBlock === '0x1000',
  )
  assert.equal(old.length, 2)
  assert.ok(old.every((call) => call.params[0].toBlock === '0x101f'))
  assert.ok(old.every((call) => call.params[0].topics.length === 1))
})

test('preflight retries baseline and candidate stages and caches one positive candidate', async () => {
  const tick = Date.UTC(2026, 8, 30, 2, 11)
  const slot = Math.floor((tick - 600_000) / 900_000)
  const visited = []
  const result = await prepareDirectOrigin({
    urls: ['first', 'second', 'third'],
    route,
    slot,
    now: () => new Date(tick),
    chooseOrigin: async ([url]) => ({
      url,
      provider: url,
      request: async () => {
        throw Error('unexpected_rpc')
      },
    }),
    captureBaseline: async ({ provider }) => {
      visited.push(`baseline:${provider}`)
      if (provider === 'first') throw Error('intermittent_baseline')
      return { provider }
    },
    discoverCandidate: async ({ baseline }) => {
      visited.push(`candidate:${baseline.provider}`)
      if (baseline.provider === 'second') throw Error('intermittent_candidate')
      return { holder: `0x${'aa'.repeat(20)}`, evidenceDoc: { schema: 'test' } }
    },
  })
  assert.equal(result.primary.url, 'third')
  assert.equal(result.baseline.provider, 'third')
  assert.ok(result.candidate.holder)
  assert.deepEqual(visited, [
    'baseline:first',
    'baseline:second',
    'candidate:second',
    'baseline:third',
    'candidate:third',
  ])
})

test('preflight stage failure becomes an explicit unavailable attempt', async () => {
  const tick = Date.UTC(2026, 8, 30, 2, 11)
  const slot = Math.floor((tick - 600_000) / 900_000)
  const attempts = []
  const dbAttempts = []
  const result = await issuePreparedDirectV2Route({
    prepared: {
      primary: { provider: 'configured-origin' },
      baseline: { targetBlock: '10' },
      candidate: null,
    },
    sql: {},
    slot,
    route,
    secondary: null,
    now: () => new Date(tick),
    appendAttempt: async (row) => attempts.push(row),
    recordDbAttempt: async (...args) => dbAttempts.push(args),
  })
  assert.deepEqual(result, { status: 'unavailable', reason: 'candidate_unavailable' })
  assert.equal(attempts[0].reason, 'candidate_unavailable')
  assert.equal(dbAttempts[0][4], 'candidate_unavailable')
})

test('Comet borrow success with supplied balance below Q is ineligible', () => {
  const result = directCaseFromMeasurement(
    '100',
    { schema: 'test' },
    {
      routeKind: 'comet',
      holderCoverageRaw: '80',
      requiredCoverageRaw: '100',
      simulationStatus: 'success',
      coveredRevert: false,
    },
  )
  assert.equal(result.baselineStatus, 'ineligible')
  assert.equal(result.entitlementMethod, 'exact_asset_balance')
  assert.equal(result.callEvidenceDoc, null)
  assert.equal(result.entitlementEvidenceDoc.withdrawRpc, null)
  assert.equal(result.entitlementEvidenceDoc.simulationStatus, null)
})

test('covered direct revert and covered success retain exact asset coverage', () => {
  for (const [simulationStatus, coveredRevert, expected] of [
    ['success', false, 'success'],
    ['evm_revert', true, 'covered_revert'],
  ]) {
    const result = directCaseFromMeasurement(
      '100',
      { schema: 'test' },
      {
        routeKind: 'aave',
        holderCoverageRaw: '120',
        requiredCoverageRaw: '100',
        simulationStatus,
        coveredRevert,
      },
    )
    assert.equal(result.baselineStatus, expected)
    assert.equal(result.coverageKind, 'assets')
    assert.equal(result.actualConsumedRaw, null)
  }
})

test('failed independent quote creates explicit unavailable Q cases and all horizons', async () => {
  const tick = Date.UTC(2026, 8, 30, 2, 11)
  const slot = Math.floor((tick - 600_000) / 900_000)
  const baseline = {
    routeKey: route.routeKey,
    destination: route.destination,
    asset: route.asset,
    assetDecimals: 6,
    targetBlock: '100',
    targetHash: `0x${'11'.repeat(32)}`,
    targetBlockAt: new Date(tick - 20_000).toISOString(),
    targetObservedAt: new Date(tick - 10_000).toISOString(),
    canonicalityEvidenceDoc: { schema: 'carry_exit_v2_headers_v1' },
  }
  const evidenceDoc = {
    routeKey: route.routeKey,
    destination: route.destination,
    asset: route.asset,
    baselineHash: baseline.targetHash,
    ladder: {
      labels: [
        { label: 'q1', assetsRaw: '1', reason: null },
        { label: 'q2', assetsRaw: '2', reason: null },
        { label: 'q3', assetsRaw: '3', reason: null },
        { label: 'q4', assetsRaw: '4', reason: null },
        { label: 'q5', assetsRaw: '5', reason: null },
        { label: 'q6', assetsRaw: '6', reason: null },
      ],
    },
  }
  const candidate = { holder: `0x${'aa'.repeat(20)}`, evidenceDoc, digest: sha(evidenceDoc) }
  const recorded = []
  const localIssues = []
  const lifecycle = []
  let plan
  const result = await issueDirectV2Route({
    sql: {},
    slot,
    route,
    primary: { provider: 'https://one.example' },
    secondary: null,
    now: () => new Date(tick),
    captureBaseline: async () => baseline,
    discoverCandidate: async () => candidate,
    hashEvidence: async () => 'f'.repeat(64),
    persist: async (_sql, value) => {
      lifecycle.push('sql_persisted')
      plan = value
      return '42'
    },
    appendAttempt: async (record) => recorded.push(record),
    recordDbAttempt: async () => '1',
    recordLocalIssues: async (value) => {
      lifecycle.push('local_issued')
      localIssues.push(value)
    },
  })
  assert.equal(result.status, 'issued')
  assert.equal(result.unavailableCases, 6)
  assert.deepEqual(plan.horizons, [1, 4, 24, 48, 168])
  assert.equal(plan.candidateProvenance, 'receipt_verified_supply')
  assert.equal(plan.cases.length, 6)
  assert.ok(plan.cases.every((row) => row.baselineStatus === 'unavailable'))
  assert.equal(recorded[0].status, 'issued')
  assert.equal(localIssues[0].batchId, '42')
  assert.equal(localIssues[0].plan, plan)
  assert.deepEqual(lifecycle, ['sql_persisted', 'local_issued'])
})

test('direct orphan recovery mirrors the authoritative stored plan before returning', async () => {
  const plan = storedRecoveryPlan()
  const calls = []
  const recovered = await recoverDirectLocalIssueMirror({
    sql: null,
    route,
    slot: recoverySlot,
    loadStoredBatch: async (expectedBatchId) => {
      assert.equal(expectedBatchId, null)
      return storedBatch(plan)
    },
    recordLocalIssues: async (value) => calls.push(value),
    recordedAt: new Date(recoveryTick),
  })
  assert.equal(recovered.plan, plan)
  assert.equal(calls[0].plan, plan)
  assert.equal(calls[0].source, 'direct')
  assert.equal(calls[0].batchId, '51')
})

test('direct recovery fails closed when stored identity differs from the selected route', async () => {
  await assert.rejects(
    () =>
      recoverDirectLocalIssueMirror({
        sql: null,
        route,
        slot: recoverySlot,
        loadStoredBatch: async () =>
          storedBatch(storedRecoveryPlan({ routeKey: `${route.routeKey} altered` })),
        recordLocalIssues: async () => assert.fail('must not mirror'),
      }),
    /local_exit_v2_stored_plan_invalid/,
  )
})
