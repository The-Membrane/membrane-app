import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from './apply-carry-morpho-exit-ddl.mjs'
import { loadMorphoFlowSubjects } from './record-carry-morpho-v2-flows.mjs'
import {
  audit,
  issue,
  issueVaults,
  loadSeedOwners,
  score,
  scoreDecision,
  seedCandidateSlice,
} from './record-carry-morpho-exit-outcomes.mjs'

const SLOT_MS = 15 * 60_000

test('deterministic rotation visits all 49 vaults in 25 ticks with at most two per tick', () => {
  const subjects = Array.from({ length: 49 }, (_, i) => ({ vault: `vault-${i}` }))
  const start = 2_000_000 * SLOT_MS
  const visits = Array.from({ length: 25 }, (_, tick) =>
    issueVaults(subjects, start + tick * SLOT_MS),
  )
  assert.ok(visits.every((batch) => batch.length <= 2))
  assert.equal(new Set(visits.flat().map(({ vault }) => vault)).size, 49)
  assert.deepEqual(issueVaults(subjects, start), issueVaults(subjects, start + SLOT_MS - 1))
  assert.throws(() => issueVaults(subjects.slice(1), start), /exit_subject_count_changed/)
})

test('score probes only a physically timed finalized block within the H1 window', () => {
  const target = Date.parse('2026-09-29T12:00:00.000Z')
  const issue = { target_at: new Date(target).toISOString() }
  assert.equal(scoreDecision(issue, target, target - 15 * 60_000 - 1), 'wait')
  assert.equal(scoreDecision(issue, target - 15 * 60_000 - 1, target), 'wait')
  assert.equal(scoreDecision(issue, target - 15 * 60_000, target), 'probe')
  assert.equal(scoreDecision(issue, target + 15 * 60_000, target), 'probe')
  assert.equal(
    scoreDecision(issue, target + 15 * 60_000 + 1, target),
    'target_block_outside_window',
  )
  assert.equal(scoreDecision(issue, target, target + 15 * 60_000 + 1), 'target_window_missed')
})

test('no observed candidate creates explicit unavailable attempts without RPC calls', async () => {
  const subjects = Array.from({ length: 49 }, (_, i) => ({ vault: `vault-${i}` }))
  const payloads = []
  const sql = async (strings, ...values) => {
    const query = strings.join('?')
    if (query.includes('carry_morpho_exit_issue(')) {
      payloads.push(JSON.parse(values[0]))
      return [{ carry_morpho_exit_issue: payloads.length }]
    }
    return []
  }
  const client = {
    getBlock: () => {
      throw new Error('unexpected RPC')
    },
  }
  const result = await issue(sql, client, subjects, Date.now(), undefined, new Map())
  assert.deepEqual(result, { issued: 0, unavailable: 2, replayed: 0 })
  assert.equal(payloads.length, 2)
  for (const payload of payloads) {
    assert.equal(payload.status, 'unavailable')
    assert.equal(payload.unavailableReason, 'no_recent_event_candidate')
    assert.equal(payload.holder, null)
    assert.equal(payload.assetsRaw, null)
    assert.match(payload.callerChecksumSha256, /^[0-9a-f]{64}$/)
  }
})

test('late target becomes missing, never a success or retroactive quote', async () => {
  const now = Date.now()
  const row = {
    id: '9',
    route_key: 'route',
    vault: 'vault',
    holder: 'holder',
    assets_raw: '123',
    source_block: '100',
    target_at: new Date(now - 16 * 60_000).toISOString(),
  }
  const payloads = []
  const sql = async (strings, ...values) => {
    const query = strings.join('?')
    if (query.includes('SELECT i.id')) return [row]
    if (query.includes('carry_morpho_exit_score(')) {
      payloads.push(JSON.parse(values[0]))
      return [{ carry_morpho_exit_score: true }]
    }
    throw new Error('unexpected SQL')
  }
  const client = { getBlock: async () => ({ timestamp: BigInt(Math.floor(now / 1000)) }) }
  const result = await score(sql, client, now)
  assert.deepEqual(result, {
    success: 0,
    evm_revert: 0,
    position_insufficient: 0,
    missing: 1,
    waiting: 0,
  })
  assert.equal(payloads[0].status, 'missing')
  assert.equal(payloads[0].missingReason, 'target_window_missed')
  assert.equal(payloads[0].sourceBlock, null)
})

test('sampled candidate with quote claim below frozen Q is unavailable, not issued', async () => {
  const now = Date.now()
  const holder = `0x${'1'.repeat(40)}`
  const subjects = Array.from({ length: 49 }, (_, i) => ({
    vault: `0x${i.toString(16).padStart(40, '0')}`,
    routeKeys: ['route'],
  }))
  const payloads = []
  let candidateSql = ''
  const sql = async (strings, ...values) => {
    const query = strings.join('?')
    if (query.includes('SELECT owner, assets_raw')) {
      candidateSql = query
      return [{ owner: holder, assets_raw: '100' }]
    }
    if (query.includes('carry_morpho_exit_issue(')) {
      payloads.push(JSON.parse(values[0]))
      return [{ carry_morpho_exit_issue: payloads.length }]
    }
    return []
  }
  const client = {
    getBlock: async () => ({ hash: `0x${'a'.repeat(64)}`, number: 100n }),
    getCode: async () => '0x',
    readContract: async () => 100n,
  }
  const quoteReader = async (_client, request) => ({
    routeKey: request.routeKey,
    vault: { address: request.destinationAddress, identity: 'factory_receipt_verified' },
    request: { assetsRaw: request.assetsRaw },
    source: {
      chainId: 1,
      blockNumber: 100,
      blockHash: `0x${'a'.repeat(64)}`,
      blockTime: new Date(now).toISOString(),
      observedAt: new Date(now).toISOString(),
    },
    position: { sharesRaw: '100', previewRedeemAssetsRaw: '99' },
    simulation: { status: 'evm_revert' },
  })
  const result = await issue(sql, client, subjects, now, quoteReader, new Map())
  assert.equal(result.issued, 0)
  assert.equal(result.unavailable, 2)
  assert.ok(payloads.every((p) => p.unavailableReason === 'sampled_candidate_exhausted'))
  assert.match(candidateSql, /event_kind = 'deposit'/)
  assert.match(candidateSql, /LIMIT \?/)
})

test('seed-owner window rotates through all 42 owners across repeated sweeps', () => {
  const owners = Array.from({ length: 42 }, (_, i) => `owner-${i}`)
  const seen = new Set()
  for (let sweep = 0; sweep < 11; sweep++) {
    const sample = seedCandidateSlice(owners, sweep * 25)
    assert.equal(sample.length, 4)
    sample.forEach((owner) => seen.add(owner))
  }
  assert.equal(seen.size, 42)
  assert.notDeepEqual(seedCandidateSlice(owners, 0), seedCandidateSlice(owners, 25))
})

test('pinned August seed yields 391 exact pairs across all 49 Morpho vaults', async () => {
  const subjects = await loadMorphoFlowSubjects()
  const owners = await loadSeedOwners(subjects)
  assert.equal(owners.size, 49)
  assert.equal(
    [...owners.values()].reduce((sum, entries) => sum + entries.length, 0),
    391,
  )
  assert.equal(Math.max(...[...owners.values()].map((entries) => entries.length)), 42)
})

test('August seed owner is revalidated at finalized state and frozen with 10% current claim', async () => {
  const now = Date.now()
  const owner = `0x${'4'.repeat(40)}`
  const subjects = Array.from({ length: 49 }, (_, i) => ({
    vault: `0x${i.toString(16).padStart(40, '0')}`,
    routeKeys: ['route'],
  }))
  const sampled = issueVaults(subjects, now)
  const seedOwners = new Map(sampled.map(({ vault }) => [vault, [owner]]))
  const payloads = []
  const calls = []
  const sql = async (strings, ...values) => {
    const query = strings.join('?')
    if (query.includes('SELECT owner, assets_raw')) return []
    if (query.includes('carry_morpho_exit_issue(')) {
      payloads.push(JSON.parse(values[0]))
      return [{ carry_morpho_exit_issue: payloads.length }]
    }
    return []
  }
  const client = {
    getBlock: async () => ({ hash: `0x${'a'.repeat(64)}`, number: 100n }),
    getCode: async (request) => {
      calls.push(['code', request])
      return '0x'
    },
    readContract: async (request) => {
      calls.push([request.functionName, request])
      return request.functionName === 'balanceOf' ? 500n : 1000n
    },
  }
  const quoteReader = async (_client, request) => {
    calls.push(['quote', request])
    return {
      routeKey: request.routeKey,
      vault: { address: request.destinationAddress, identity: 'factory_receipt_verified' },
      request: { assetsRaw: request.assetsRaw },
      source: {
        chainId: 1,
        blockNumber: 100,
        blockHash: `0x${'a'.repeat(64)}`,
        blockTime: new Date(now).toISOString(),
        observedAt: new Date(now).toISOString(),
      },
      position: { sharesRaw: '500', previewRedeemAssetsRaw: '1000' },
      simulation: { status: 'success' },
    }
  }
  const result = await issue(sql, client, subjects, now, quoteReader, seedOwners)
  assert.equal(result.issued, 2)
  assert.equal(payloads.length, 2)
  assert.ok(payloads.every((p) => p.candidateProvenance === 'august_seed_revalidated'))
  assert.ok(payloads.every((p) => p.holder === owner && p.assetsRaw === '100'))
  assert.equal(calls.filter(([kind]) => kind === 'code').length, 2)
  assert.equal(calls.filter(([kind]) => kind === 'balanceOf').length, 2)
  assert.equal(calls.filter(([kind]) => kind === 'previewRedeem').length, 2)
  assert.ok(
    calls
      .filter(([kind]) => kind === 'quote')
      .every(([, request]) => request.owner === owner && request.assetsRaw === '100'),
  )
})

test('holder claim below Q is a censored position outcome with exact source', async () => {
  const now = Date.now()
  const row = {
    id: '9',
    route_key: 'route',
    vault: `0x${'2'.repeat(40)}`,
    holder: `0x${'3'.repeat(40)}`,
    assets_raw: '100',
    source_block: '100',
    target_at: new Date(now).toISOString(),
  }
  const payloads = []
  let scoreSql = ''
  const sql = async (strings, ...values) => {
    const query = strings.join('?')
    if (query.includes('WITH actionable')) {
      scoreSql = query
      return [row]
    }
    if (query.includes('carry_morpho_exit_score(')) {
      payloads.push(JSON.parse(values[0]))
      return [{ carry_morpho_exit_score: true }]
    }
    throw new Error('unexpected SQL')
  }
  const client = { getBlock: async () => ({ timestamp: BigInt(Math.floor(now / 1000)) }) }
  const quoteReader = async (_client, request) => ({
    routeKey: request.routeKey,
    vault: { address: request.destinationAddress, identity: 'factory_receipt_verified' },
    request: { assetsRaw: request.assetsRaw },
    source: {
      chainId: 1,
      blockNumber: 101,
      blockHash: `0x${'a'.repeat(64)}`,
      blockTime: new Date(now).toISOString(),
      observedAt: new Date(now).toISOString(),
    },
    position: { previewRedeemAssetsRaw: '99' },
    simulation: { status: 'evm_revert' },
  })
  const result = await score(sql, client, now, quoteReader)
  assert.equal(result.position_insufficient, 1)
  assert.equal(result.evm_revert, 0)
  assert.equal(payloads[0].status, 'position_insufficient')
  assert.equal(payloads[0].holderClaimRaw, '99')
  assert.equal(payloads[0].assetsRaw, '100')
  assert.equal(payloads[0].sourceBlock, '101')
  assert.match(scoreSql, /ORDER BY i\.target_at, i\.id LIMIT 2/)
  assert.match(scoreSql, /ORDER BY i\.target_at, i\.id LIMIT 1/)
})

test('a successful withdrawal is not overwritten by a lower share preview', async () => {
  const now = Date.now()
  const row = {
    id: '10',
    route_key: 'route',
    vault: `0x${'2'.repeat(40)}`,
    holder: `0x${'3'.repeat(40)}`,
    assets_raw: '100',
    source_block: '100',
    target_at: new Date(now).toISOString(),
  }
  let recorded
  const sql = async (strings, ...values) => {
    const query = strings.join('?')
    if (query.includes('WITH actionable')) return [row]
    if (query.includes('carry_morpho_exit_score(')) {
      recorded = JSON.parse(values[0])
      return [{ carry_morpho_exit_score: true }]
    }
    throw new Error('unexpected SQL')
  }
  const client = { getBlock: async () => ({ timestamp: BigInt(Math.floor(now / 1000)) }) }
  const quoteReader = async (_client, request) => ({
    routeKey: request.routeKey,
    vault: { address: request.destinationAddress, identity: 'factory_receipt_verified' },
    request: { assetsRaw: request.assetsRaw },
    source: {
      chainId: 1,
      blockNumber: 101,
      blockHash: `0x${'a'.repeat(64)}`,
      blockTime: new Date(now).toISOString(),
      observedAt: new Date(now).toISOString(),
    },
    position: { previewRedeemAssetsRaw: '99' },
    simulation: { status: 'success', sharesBurnedRaw: '98' },
  })
  const result = await score(sql, client, now, quoteReader)
  assert.equal(result.success, 1)
  assert.equal(result.position_insufficient, 0)
  assert.equal(recorded.status, 'success')
  assert.equal(recorded.holderClaimRaw, '99')
})

test('audit reports missing scheduled vault/slot pairs', async () => {
  const sql = async (strings) => {
    const query = strings.join('?')
    if (query.includes('count(*)::integer AS n FROM carry_morpho_v2_flow_subjects'))
      return [{ n: 49 }]
    if (query.includes('FROM carry_morpho_exit_attempts GROUP BY'))
      return [
        { status: 'issued', unavailable_reason: null, n: 2 },
        { status: 'unavailable', unavailable_reason: 'no_recent_event_candidate', n: 1 },
      ]
    if (query.includes('FROM carry_morpho_exit_outcomes GROUP BY'))
      return [{ status: 'missing', missing_reason: 'quote_unavailable', n: 1 }]
    if (query.includes('WITH routes AS'))
      return [
        { route_key: 'route A', status: 'missing', missing_reason: 'quote_unavailable', n: 1 },
        { route_key: 'route B', status: null, missing_reason: null, n: 0 },
      ]
    if (query.includes('CROSS JOIN LATERAL jsonb_array_elements_text'))
      return [
        { route_key: 'route A', status: 'issued', unavailable_reason: null, n: 2 },
        { route_key: 'route B', status: null, unavailable_reason: null, n: 0 },
      ]
    if (query.includes('count(*)::integer AS n FROM carry_morpho_exit_outcomes o'))
      return [{ n: 0 }]
    if (query.includes('WITH bounds AS'))
      return [
        {
          first_slot: '100',
          last_slot: '101',
          expected: '4',
          missing: '2',
          first_missing_slot: '100',
        },
      ]
    throw new Error('unexpected SQL')
  }
  const summary = await audit(sql)
  assert.deepEqual(summary.scheduled, {
    firstRecordedSlot: '100',
    lastCompletedSlot: '101',
    expectedAttempts: 4,
    missingAttempts: 2,
    firstMissingSlot: '100',
  })
  assert.deepEqual(summary.diagnostics.overall, {
    attempts: { issued: 2, unavailable: 1 },
    unavailableReasons: { no_recent_event_candidate: 1 },
    outcomes: { success: 0, evm_revert: 0, position_insufficient: 0, missing: 1 },
    missingReasons: { quote_unavailable: 1 },
  })
  assert.deepEqual(
    summary.diagnostics.byRoute.map(
      ({ routeKey, attempts, unavailableReasons, missingReasons }) => ({
        routeKey,
        attempts,
        unavailableReasons,
        missingReasons,
      }),
    ),
    [
      {
        routeKey: 'route A',
        attempts: { issued: 2, unavailable: 0 },
        unavailableReasons: {},
        missingReasons: { quote_unavailable: 1 },
      },
      {
        routeKey: 'route B',
        attempts: { issued: 0, unavailable: 0 },
        unavailableReasons: {},
        missingReasons: {},
      },
    ],
  )
  assert.equal(summary.diagnostics.unavailableRouteAttribution, 'unattributed_no_route_key')
  assert.ok(!JSON.stringify(summary).includes('holder'))
  assert.ok(!JSON.stringify(summary).includes('assets_raw'))
})

test('DDL installs direct-insert guards for timing, exact identity and shared quota', async () => {
  const statements = []
  const sql = Object.assign(
    async (strings) => {
      statements.push(strings.join('?'))
      return []
    },
    {
      query: async (statement) => {
        statements.push(statement)
        return []
      },
    },
  )
  await apply(sql)
  const guard = statements.find((statement) =>
    statement.includes('FUNCTION guard_carry_morpho_exit_insert'),
  )
  assert.ok(guard)
  assert.match(guard, /NEW\.route_key IS DISTINCT FROM issue\.route_key/)
  assert.match(guard, /NEW\.target_at <> NEW\.issued_at \+ interval '1 hour'/)
  assert.match(guard, /vault_index NOT IN/)
  assert.match(guard, /carry_morpho_exit_attempts WHERE tick_slot = slot/)
  assert.equal(
    statements.filter((statement) => statement.includes('_insert_guard BEFORE INSERT')).length,
    2,
  )
  assert.ok(
    statements.some((statement) =>
      statement.includes('ADD COLUMN IF NOT EXISTS candidate_provenance text'),
    ),
  )
  assert.ok(
    statements.some((statement) =>
      statement.includes("status = 'unavailable' AND candidate_provenance IS NULL"),
    ),
  )
})
