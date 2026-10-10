import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CARRY_EXIT_V2_FROZEN_ROUTES } from './lib/carry-exit-v2-rpc-proof.mjs'
import {
  appendDurableAttempt,
  attemptRecord,
  caseFromMeasurement,
  configuredRpcUrls,
  findIssuedSlotBatchPlan,
  findOutstandingIssuedBatchRefs,
  finalizeRecoveredCurrentLocalMirror,
  issueMorphoV2Route,
  issuePlan,
  readCurrentAttempt,
  recordLocalMirrorCheckpoint,
  reconcilePriorLocalIssueMirrors,
  recoverMorphoLocalIssueMirror,
  rpcTransport,
  selectedMorphoRoute,
  selectHealthyOrigin,
} from './record-carry-morpho-exit-v2-issues.mjs'

const routes = CARRY_EXIT_V2_FROZEN_ROUTES.filter((route) => route.kind === 'morpho')
const route = routes[0]
const subjects = [...Map.groupBy(routes, (item) => item.destination)].map(([vault, entries]) => ({
  vault,
  asset: entries[0].asset,
  routeKeys: entries.map((entry) => entry.routeKey),
}))
const at = () => new Date('2026-09-30T01:25:01.000Z')
const slot = Math.floor((at().getTime() - 10 * 60_000) / (15 * 60_000))
const baseline = {
  routeKey: route.routeKey,
  destination: route.destination,
  asset: route.asset,
  assetDecimals: 6,
  targetBlock: '100',
  targetHash: `0x${'a'.repeat(64)}`,
  targetBlockAt: '2026-09-30T01:24:00.000Z',
  targetObservedAt: '2026-09-30T01:25:00.000Z',
}
const ladder = (size = 6) =>
  Array.from({ length: size }, (_, i) => ({
    label: `q${i}`,
    assetsRaw: String(i + 1),
    reason: null,
  }))
const candidate = (holder = `0x${'1'.repeat(40)}`, labels = ladder()) => {
  const evidenceDoc = {
    ladder: { labels },
    unavailableReason: holder ? null : 'no_pre_baseline_eoa_with_positive_claim',
  }
  return {
    holder,
    digest: createHash('sha256').update(JSON.stringify(evidenceDoc)).digest('hex'),
    evidenceDoc,
  }
}

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
    slotAt: new Date(slot * 15 * 60_000 + 10 * 60_000).toISOString(),
    destination: route.destination,
    asset: route.asset,
    assetDecimals: 6,
    holder,
    baselineBlock: '100',
    baselineHash,
    baselineBlockAt: '2026-09-30T01:24:00.000Z',
    baselineObservedAt: '2026-09-30T01:25:00.000Z',
    candidateProvenance: 'receipt_verified_transfer',
    candidateEvidenceSha256: 'a'.repeat(64),
    candidateEvidenceDoc: {
      schema: 'carry_exit_v2_morpho_candidate_v1',
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
const storedBatch = (plan, batchId = '43') => ({
  batchId,
  plan,
  planSha256: 'f'.repeat(64),
  digestIntegrity: { plan: true, candidate: true, cases: true },
  childRowsValid: true,
})

test('route rotation covers every exact tracked Morpho route on native quarter slots', () => {
  assert.equal(subjects.length, 49)
  const first = Date.parse('2026-09-30T01:10:00.000Z')
  const seen = new Set()
  for (let i = 0; i < routes.length; i++) {
    const selected = selectedMorphoRoute(subjects, first + i * 15 * 60_000)
    assert.equal(selected.routeCount, routes.length)
    seen.add(`${selected.route.routeKey}:${selected.route.destination}`)
  }
  assert.equal(seen.size, routes.length)
  assert.equal(
    selectedMorphoRoute(subjects, first).slot,
    selectedMorphoRoute(subjects, first + 14 * 60_000).slot,
  )
})

test('configured endpoints are split before RPC and health checks include logs', async () => {
  assert.deepEqual(configuredRpcUrls('https://a.example/x, https://b.example/y'), [
    'https://a.example/x',
    'https://b.example/y',
  ])
  assert.throws(() => configuredRpcUrls('https://a.example,https://a.example'), /invalid_rpc_urls/)
  const methods = []
  const client = await selectHealthyOrigin(
    ['https://a.example', 'https://b.example'],
    route,
    (url) => ({
      url,
      provider: url,
      request: async (method) => {
        methods.push([url, method])
        if (url.includes('a.example') && method === 'eth_getLogs') throw Error('rpc_http_400')
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_getBlockByNumber') return { number: '0x64' }
        return []
      },
    }),
  )
  assert.equal(client.url, 'https://b.example')
  assert.deepEqual(
    methods.map((x) => x[1]),
    [
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getLogs',
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getLogs',
    ],
  )
})

test('transport returns raw envelopes but hides provider error text from scalar calls', async () => {
  const sent = []
  const optionsSeen = []
  const transport = rpcTransport('https://rpc.example/secret-key', async (_url, options) => {
    const body = JSON.parse(options.body)
    optionsSeen.push(options)
    sent.push(body)
    return {
      ok: true,
      text: async () =>
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          ...(body.method === 'eth_call'
            ? { error: { code: -32000, message: 'execution reverted' } }
            : { result: '0x1' }),
        }),
    }
  })
  assert.equal(transport.provider, 'https://rpc.example')
  assert.equal(await transport.request('eth_chainId', []), '0x1')
  const response = await transport.send({ jsonrpc: '2.0', id: 7, method: 'eth_call', params: [] })
  assert.equal(response.error.code, -32000)
  await assert.rejects(() => transport.request('eth_call', []), /rpc_response_invalid/)
  assert.equal(sent.length, 3)
  assert.ok(optionsSeen.every((options) => options.redirect === 'error'))
})

test('no eligible holder and zero ladder are durable terminal denominators', async () => {
  for (const [name, found, expected] of [
    ['holder', candidate(null), 'no_eligible_holder'],
    [
      'ladder',
      candidate(
        undefined,
        Array.from({ length: 6 }, (_, i) => ({
          label: `tiny${i}`,
          assetsRaw: null,
          reason: 'zero_sized',
        })),
      ),
      'zero_or_duplicate_q',
    ],
  ]) {
    const attempts = [],
      db = []
    const result = await issueMorphoV2Route({
      sql: {},
      slot,
      route,
      primary: { provider: 'https://primary.example', request: async () => null },
      secondary: null,
      now: at,
      captureBaseline: async () => baseline,
      discoverCandidate: async () => found,
      appendAttempt: async (value) => attempts.push(value),
      recordDbAttempt: async (_sql, _route, _slot, status, reason) => db.push({ status, reason }),
      persist: async () => {
        throw Error('must_not_issue')
      },
    })
    assert.equal(result.status, 'unavailable', name)
    assert.equal(db[0].reason, expected)
    assert.equal(attempts[0].candidateEvidenceSha256, found.digest)
    assert.equal(
      attempts[0].candidateEvidenceDoc.ladder.labels.length,
      found.evidenceDoc.ladder.labels.length,
    )
  }
})

test('persistent candidate throttling keeps its reason in the local attempt', async () => {
  const attempts = []
  const db = []
  const result = await issueMorphoV2Route({
    sql: {},
    slot,
    route,
    primary: { provider: 'https://primary.example', request: async () => null },
    secondary: null,
    now: at,
    captureBaseline: async () => baseline,
    discoverCandidate: async () => {
      throw Error('candidate_log_throttle_exhausted')
    },
    appendAttempt: async (value) => attempts.push(value),
    recordDbAttempt: async (_sql, _route, _slot, status, reason) => db.push({ status, reason }),
  })
  assert.deepEqual(result, { status: 'unavailable', reason: 'candidate_log_throttle_exhausted' })
  assert.equal(attempts[0].reason, 'candidate_log_throttle_exhausted')
  assert.deepEqual(db, [{ status: 'unavailable', reason: 'candidate_unavailable' }])
})

test('all positive Q remain in one preregistered plan even when replay is unavailable', async () => {
  const attempts = [],
    db = [],
    plans = []
  const result = await issueMorphoV2Route({
    sql: {},
    slot,
    route,
    primary: {
      url: 'https://primary.example',
      provider: 'https://primary.example',
      request: async () => null,
      send: async () => null,
    },
    secondary: { url: 'https://secondary.example', send: async () => null },
    now: at,
    captureBaseline: async () => baseline,
    discoverCandidate: async () =>
      candidate(`0x${'1'.repeat(40)}`, [
        { label: 'zero', assetsRaw: null, reason: 'zero_sized' },
        ...ladder(5),
      ]),
    collect: async () => ({ proof: {} }),
    verify: async () => ({ status: 'unavailable' }),
    hashEvidence: async (_sql, doc) =>
      createHash('sha256').update(JSON.stringify(doc)).digest('hex'),
    persist: async (_sql, plan) => {
      plans.push(plan)
      return '42'
    },
    appendAttempt: async (value) => attempts.push(value),
    recordDbAttempt: async (_sql, _route, _slot, status, reason, batchId) =>
      db.push({ status, reason, batchId }),
    recordLocalIssues: async (value) => plans.push({ local: value }),
  })
  assert.equal(result.status, 'issued')
  assert.equal(result.cases, 5)
  assert.equal(result.unavailableCases, 5)
  assert.equal(result.omittedCases, 1)
  assert.deepEqual(
    plans[0].cases.map((x) => x.assetsRaw),
    ['1', '2', '3', '4', '5'],
  )
  assert.ok(plans[0].cases.every((x) => x.baselineStatus === 'unavailable'))
  assert.equal(
    plans[0].candidateEvidenceSha256,
    createHash('sha256').update(JSON.stringify(plans[0].candidateEvidenceDoc)).digest('hex'),
  )
  assert.equal(db[0].status, 'issued')
  assert.equal(db[0].batchId, '42')
  assert.equal(attempts[0].omittedLadder[0].reason, 'zero_sized')
  assert.equal(plans[1].local.batchId, '42')
  assert.equal(plans[1].local.plan, plans[0])
  assert.equal(JSON.stringify(result).includes('0x111'), false)
})

test('an uncertain issue recovers the already committed slot batch instead of issuing again', async () => {
  const local = []
  const db = []
  let recoveredPlan
  const result = await issueMorphoV2Route({
    sql: {},
    slot,
    route,
    primary: { provider: 'https://primary.example', request: async () => null },
    secondary: null,
    now: at,
    captureBaseline: async () => baseline,
    discoverCandidate: async () => candidate(),
    hashEvidence: async () => 'a'.repeat(64),
    persist: async () => {
      throw Error('response_lost')
    },
    recoverIssuedBatch: async () => null,
    recoverIssuedSlotBatch: async (_sql, _route, _slot, plan) => {
      recoveredPlan = plan
      return '43'
    },
    appendAttempt: async (item) => local.push(item),
    recordDbAttempt: async (_sql, _route, observedSlot, status, reason, batchId) =>
      db.push({ observedSlot, status, reason, batchId }),
    recordLocalIssues: async (value) => local.push({ localIssue: value }),
  })
  assert.equal(result.status, 'issued_recovered')
  assert.equal(local[0].localIssue.batchId, '43')
  assert.equal(local[0].localIssue.plan, recoveredPlan)
  assert.equal(recoveredPlan.cases.length, 6)
  assert.equal(local[1].status, 'issued_recovered')
  assert.equal(db[0].observedSlot, slot)
  assert.equal(db[0].batchId, '43')
})

test('verified measurement classification never turns an uncovered revert into loss', () => {
  const evidence = { schema: 'fixture' }
  const base = {
    routeKind: 'morpho',
    holderCoverageRaw: '20',
    requiredCoverageRaw: '12',
    actualConsumedRaw: null,
    simulationStatus: 'evm_revert',
  }
  assert.equal(
    caseFromMeasurement('10', evidence, { ...base, coveredRevert: true }).baselineStatus,
    'covered_revert',
  )
  assert.equal(
    caseFromMeasurement('10', evidence, { ...base, coveredRevert: false }).baselineStatus,
    'unavailable',
  )
  const insufficient = caseFromMeasurement('30', evidence, {
    ...base,
    coveredRevert: false,
  })
  assert.equal(insufficient.baselineStatus, 'ineligible')
  assert.equal(insufficient.entitlementMethod, 'morpho_claim_below_q')
  assert.equal(insufficient.entitlementEvidenceDoc.withdrawRpc, null)
  assert.equal(
    caseFromMeasurement('10', evidence, {
      ...base,
      actualConsumedRaw: '7',
      simulationStatus: 'success',
      coveredRevert: false,
    }).baselineStatus,
    'success',
  )
})

test('issue query computes PostgreSQL JSONB digest in same auto-commit statement', async () => {
  let query
  const sql = async (strings, ...values) => {
    query = { strings: strings.join('?'), values }
    return [{ batch_id: 91 }]
  }
  assert.equal(await issuePlan(sql, { version: 'carry_exit_v2' }), '91')
  assert.match(query.strings, /carry_exit_v2_issue\(jsonb_build_object/)
  assert.match(query.strings, /sha256\(convert_to/)
  assert.equal(query.values.length, 2)
})

test('stored Morpho slot recovery fetches plan_doc and repairs an issued attempt mirror', async () => {
  const plan = storedRecoveryPlan()
  let query
  const read = await findIssuedSlotBatchPlan(
    async (strings, ...values) => {
      query = { text: strings.join('?'), values }
      return [
        {
          id: '43',
          plan_doc: plan,
          plan_sha256: 'f'.repeat(64),
          plan_digest_valid: true,
          candidate_digest_valid: true,
          case_digests_valid: true,
          child_rows_valid: true,
        },
      ]
    },
    route,
    slot,
    '43',
  )
  assert.equal(read.plan, plan)
  assert.equal(read.batchId, '43')
  assert.match(query.text, /SELECT b\.id::text AS id, b\.plan_doc/)
  assert.match(query.text, /id = .*::bigint/)
  assert.match(query.text, /plan_sha256 = encode\(sha256/)
  assert.match(query.text, /candidateEvidenceSha256/)
  assert.match(query.text, /case_digests_valid/)
  assert.match(query.text, /carry_exit_v2_cases/)
  assert.match(query.text, /carry_exit_v2_plans/)
  assert.match(query.text, /child_rows_valid/)

  const mirrors = []
  const recovered = await recoverMorphoLocalIssueMirror({
    sql: null,
    route,
    slot,
    existingAttempt: { status: 'issued', batch_id: '43' },
    loadStoredBatch: async (expectedBatchId) => {
      assert.equal(expectedBatchId, '43')
      return read
    },
    recordLocalIssues: async (value) => mirrors.push(value),
    recordedAt: at(),
  })
  assert.equal(recovered.plan, plan)
  assert.equal(mirrors[0].plan, plan)
  assert.equal(mirrors[0].source, 'morpho')
})

test('later-slot restart checkpoints an old mirror even when an ordinary attempt exists', async () => {
  const priorSlot = slot - 2
  const priorRoute = { ...route }
  const plan = storedRecoveryPlan({
    slotAt: new Date(priorSlot * 15 * 60_000 + 10 * 60_000).toISOString(),
  })
  let checkpointed = false
  let outstandingQuery
  let checkpointQuery
  const events = []
  const sql = async (strings, ...values) => {
    const text = strings.join('?')
    if (text.includes('carry_exit_v2_record_local_mirror')) {
      checkpointQuery = { text, values }
      events.push('checkpoint')
      checkpointed = true
      return [{ mirrored_at: '2026-09-30T01:25:02.000Z' }]
    }
    outstandingQuery = { text, values }
    return checkpointed
      ? []
      : [
          {
            id: '41',
            route_key: priorRoute.routeKey,
            destination: priorRoute.destination,
            asset: priorRoute.asset,
            slot_ms: String(priorSlot * 15 * 60_000 + 10 * 60_000),
            ordinary_attempt_id: '17',
          },
        ]
  }
  const calls = []
  const recovered = await reconcilePriorLocalIssueMirrors({
    sql,
    source: 'morpho',
    beforeSlot: slot,
    loadStoredBatch: async (_sql, loadedRoute, loadedSlot, batchId) => {
      assert.deepEqual(
        [loadedRoute, loadedSlot, batchId],
        [
          {
            routeKey: priorRoute.routeKey,
            destination: priorRoute.destination,
            asset: priorRoute.asset,
          },
          priorSlot,
          '41',
        ],
      )
      return storedBatch(plan, '41')
    },
    recordLocalIssues: async (value) => {
      events.push('local_exact_q_fsync')
      calls.push({ local: value })
    },
    appendAttempt: async (value) => {
      events.push('local_attempt_fsync')
      calls.push({ attempt: value })
    },
    makeAttempt: (value) => value,
    now: at,
  })
  assert.deepEqual(recovered, [{ batchId: '41', slot: priorSlot, routeKey: route.routeKey }])
  assert.match(outstandingQuery.text, /LEFT JOIN carry_exit_v2_local_mirrors/)
  assert.match(outstandingQuery.text, /mirror\.batch_id IS NULL/)
  assert.doesNotMatch(outstandingQuery.text, /carry_exit_v2_attempts/)
  assert.match(outstandingQuery.text, /ORDER BY b\.slot_at ASC, b\.id ASC/)
  assert.match(outstandingQuery.text, /LIMIT/)
  assert.match(checkpointQuery.text, /carry_exit_v2_record_local_mirror/)
  assert.deepEqual(events, ['local_exact_q_fsync', 'local_attempt_fsync', 'checkpoint'])
  assert.equal(calls[0].local.plan, plan)
  assert.equal(calls[1].attempt.reason, 'prior_unmirrored_batch_reconciled')

  const currentIssuance = []
  const retry = await reconcilePriorLocalIssueMirrors({
    sql,
    source: 'morpho',
    beforeSlot: slot,
    loadStoredBatch: async () => assert.fail('checkpointed batch must be excluded'),
    recordLocalIssues: async () => assert.fail('checkpointed batch must not remirror'),
    appendAttempt: async () => assert.fail('checkpointed batch must not append'),
    makeAttempt: (value) => value,
    now: at,
  })
  currentIssuance.push('current_slot_issued')
  assert.deepEqual(retry, [])
  assert.deepEqual(currentIssuance, ['current_slot_issued'])
})

test('local mirror checkpoint binds the batch to exact route identity without a slot-age gate', async () => {
  let query
  const mirroredAt = await recordLocalMirrorCheckpoint(
    async (strings, ...values) => {
      query = { text: strings.join('?'), values }
      return [{ mirrored_at: '2026-10-07T12:00:00.000Z' }]
    },
    route,
    slot - 500,
    '41',
  )
  assert.equal(mirroredAt, '2026-10-07T12:00:00.000Z')
  assert.match(query.text, /carry_exit_v2_record_local_mirror/)
  assert.deepEqual(query.values.slice(0, 4), ['41', route.routeKey, route.destination, route.asset])
  assert.equal(query.values.length, 5)
  await assert.rejects(
    () => recordLocalMirrorCheckpoint(async () => [], route, slot, '0'),
    /local_mirror_batch_id_invalid/,
  )
})

test('current-slot recovery fsyncs its local attempt before checkpointing and preserves attempt windows', async () => {
  for (const existingAttempt of [null, { status: 'issued', batch_id: '41' }]) {
    const events = []
    const finalized = await finalizeRecoveredCurrentLocalMirror({
      sql: {},
      route,
      slot,
      recovered: { batchId: '41' },
      existingAttempt,
      appendAttempt: async (attempt) => events.push(['local_attempt', attempt.reason]),
      makeAttempt: (value) => value,
      recordCheckpoint: async () => events.push(['checkpoint']),
      recordDbAttempt: async (_sql, _route, _slot, status, reason, batchId) =>
        events.push(['database_attempt', status, reason, batchId]),
    })
    assert.equal(finalized, true)
    assert.deepEqual(
      events,
      existingAttempt
        ? [['local_attempt', 'issued_attempt_local_mirror_reconciled'], ['checkpoint']]
        : [
            ['local_attempt', 'orphan_batch_reconciled'],
            ['checkpoint'],
            ['database_attempt', 'issued', null, '41'],
          ],
    )
  }
})

test('current attempt read binds batch id to exact route identity and caller-selected slot', async () => {
  const expected = { id: '7', status: 'issued', reason: null, batch_id: '43' }
  let query
  const sql = async (strings, ...values) => {
    query = { text: strings.join('?'), values }
    return values[0] === route.routeKey &&
      values[1] === storedRecoveryPlan().slotAt &&
      values[2] === route.destination &&
      values[3] === route.asset
      ? [expected]
      : []
  }
  const found = await readCurrentAttempt(sql, route, slot)
  assert.equal(found, expected)
  assert.match(query.text, /batch_id::text AS batch_id/)
  assert.match(query.text, /destination =/)
  assert.match(query.text, /asset =/)
  assert.equal(
    await readCurrentAttempt(sql, { ...route, destination: `0x${'9'.repeat(40)}` }, slot),
    null,
  )
  assert.equal(await readCurrentAttempt(sql, route, slot + 1), null)
})

test('Morpho recovery rejects absent, malformed, and mismatched stored plans', async () => {
  await assert.rejects(
    () =>
      recoverMorphoLocalIssueMirror({
        sql: null,
        route,
        slot,
        existingAttempt: { status: 'issued', batch_id: '43' },
        loadStoredBatch: async () => null,
        recordLocalIssues: async () => assert.fail('must not mirror'),
      }),
    /local_exit_v2_issued_batch_missing/,
  )
  await assert.rejects(
    () =>
      recoverMorphoLocalIssueMirror({
        sql: null,
        route,
        slot,
        loadStoredBatch: async () => ({
          ...storedBatch(storedRecoveryPlan()),
          digestIntegrity: { plan: true, candidate: false, cases: true },
        }),
        recordLocalIssues: async () => assert.fail('must not mirror'),
      }),
    /local_exit_v2_stored_digest_invalid/,
  )
  await assert.rejects(
    () =>
      recoverMorphoLocalIssueMirror({
        sql: null,
        route,
        slot,
        loadStoredBatch: async () => ({
          ...storedBatch(storedRecoveryPlan()),
          childRowsValid: false,
        }),
        recordLocalIssues: async () => assert.fail('must not mirror'),
      }),
    /local_exit_v2_stored_children_invalid/,
  )
  const successWithoutProof = storedRecoveryPlan()
  successWithoutProof.cases[0] = {
    ...successWithoutProof.cases[0],
    baselineStatus: 'success',
    unavailableReason: null,
  }
  await assert.rejects(
    () =>
      recoverMorphoLocalIssueMirror({
        sql: null,
        route,
        slot,
        loadStoredBatch: async () => storedBatch(successWithoutProof),
        recordLocalIssues: async () => assert.fail('must not mirror'),
      }),
    /local_exit_v2_stored_case_evidence_invalid/,
  )
  for (const plan of [
    storedRecoveryPlan({ version: 'carry_exit_v1' }),
    storedRecoveryPlan({ destination: `0x${'9'.repeat(40)}` }),
  ]) {
    await assert.rejects(
      () =>
        recoverMorphoLocalIssueMirror({
          sql: null,
          route,
          slot,
          loadStoredBatch: async () => storedBatch(plan),
          recordLocalIssues: async () => assert.fail('must not mirror'),
        }),
      /local_exit_v2_(plan|stored_plan)_invalid/,
    )
  }
  await assert.rejects(
    () =>
      recoverMorphoLocalIssueMirror({
        sql: null,
        route,
        slot,
        existingAttempt: { status: 'unavailable', batch_id: null },
        loadStoredBatch: async () => storedBatch(storedRecoveryPlan()),
        recordLocalIssues: async () => assert.fail('must not mirror'),
      }),
    /local_exit_v2_attempt_batch_conflict/,
  )
  await assert.rejects(
    () =>
      recoverMorphoLocalIssueMirror({
        sql: null,
        route,
        slot,
        existingAttempt: { status: 'issued', batch_id: '43' },
        loadStoredBatch: async () => storedBatch(storedRecoveryPlan(), '44'),
        recordLocalIssues: async () => assert.fail('must not mirror'),
      }),
    /local_exit_v2_attempt_batch_conflict/,
  )
})

test('attempt record persists without holder or RPC URL in safe summary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'carry-v2-issuer-'))
  try {
    const item = attemptRecord({
      slot: 1,
      route,
      status: 'unavailable',
      reason: 'no_holder',
      candidate: candidate(null),
      at: at(),
    })
    const path = join(dir, 'attempts.jsonl')
    const mirrors = []
    await appendDurableAttempt(item, path, async (...args) => mirrors.push(args))
    const saved = JSON.parse((await readFile(path, 'utf8')).trim())
    assert.equal(saved.reason, 'no_holder')
    assert.equal(saved.candidateEvidenceSha256, item.candidateEvidenceSha256)
    assert.ok(!JSON.stringify(saved).includes('https://'))
    assert.equal(mirrors[0][0], 'morpho')
    assert.equal(mirrors[0][1], item)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
