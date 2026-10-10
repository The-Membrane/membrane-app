import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { loadConfig } from '../lib/venue-reads.mjs'
import {
  createSharedBudget,
  buildRoster,
  dailyUtcAnchors,
  dryRun,
  estimateWorstCase,
  makeRpcProvider as pacedRpcProvider,
  parseProviderUrls,
  parseProviderPool,
  resolveProviderPolicy,
  configuredProviders,
  enrollHistoricalQuoteProviderPolicy,
  findOrCreateRoster,
  chooseNextSlot,
  codeEvidenceMatches,
  codeAddresses,
  captureProvider,
  replayProviderCapture,
  verifyArchive,
  EIP1967_IMPLEMENTATION_SLOT,
  EIP1967_BEACON_SLOT,
  resolveUtcAnchor,
  runTick as pacedRunTick,
} from './carry-depth-quote-archive.mjs'
import { keccak256, toFunctionSelector } from 'viem'
import { COST_LEVELS_PCT } from '../lib/depthCurve.mjs'
import {
  appendHistoricalQuoteAttempt,
  writeHistoricalQuoteRoster,
  writeHistoricalQuoteAnchor,
  appendHistoricalQuoteAnchorFailure,
  acquireHistoricalQuoteWriterLock,
  isValidSuccessfulHistoricalQuoteTrace,
  MIN_HISTORICAL_QUOTE_FREE_BYTES,
  readHistoricalQuoteAttempts,
  readHistoricalQuoteAnchor,
  resolveHistoricalQuoteCaptures,
  historicalQuoteCaptureSha256,
  encodeHistoricalQuoteCapture,
  decodeHistoricalQuoteCapture,
} from '../lib/historicalDepthQuoteStore.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sha = (value) => createHash('sha256').update(value).digest('hex')
const makeRpcProvider = (provider, budget, options = {}) =>
  pacedRpcProvider(provider, budget, { requestIntervalMs: 0, ...options })
const runTick = (options = {}) => pacedRunTick({ requestIntervalMs: 0, ...options })
const providerA = {
  url: 'https://one.archive.example/secret-a',
  host: 'one.archive.example',
  uriSha256: sha('one'),
}
const providerB = {
  url: 'https://two.archive.example/secret-b',
  host: 'two.archive.example',
  uriSha256: sha('two'),
}

test('provider start pacing serializes physical ids and checks deadline/ownership after waiting', async () => {
  let clock = 0
  const starts = []
  const waits = []
  let owned = true
  const budget = createSharedBudget({ now: () => clock, ownership: {
    assertHeld: () => { if (!owned) throw new Error('writer_lost') },
  } })
  const provider = pacedRpcProvider(providerA, budget, { now: () => clock,
    waitImpl: async (ms) => { waits.push(ms); clock += ms },
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body); starts.push({ at: clock, id: request.id })
      return { ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: request.id, result: '0x1' }) }
    },
  })
  await Promise.all(['0x01', '0x02'].map((slot) => provider.client.getStorageAt({ address: `0x${'1'.repeat(40)}`, slot })))
  assert.deepEqual(starts, [{ at: 0, id: 1 }, { at: 250, id: 2 }])
  assert.deepEqual(waits, [250])
  owned = false
  await assert.rejects(provider.client.getChainId(), /writer_lost/)
  assert.equal(budget.starts, 2)
  let deadlineClock = 0
  const deadlineBudget = createSharedBudget({ now: () => deadlineClock, deadlineMs: 200 })
  const deadline = pacedRpcProvider(providerA, deadlineBudget, {
    now: () => deadlineClock, waitImpl: async () => assert.fail('cannot wait beyond deadline'),
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body)
      return { ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: request.id, result: '0x1' }) }
    },
  })
  await deadline.client.getChainId()
  await assert.rejects(deadline.client.getChainId(), /deadline_elapsed/)
  assert.equal(deadlineBudget.starts, 1)
  let lateClock = 0
  const lateBudget = createSharedBudget({ now: () => lateClock, deadlineMs: 1000 })
  const late = pacedRpcProvider(providerA, lateBudget, {
    now: () => lateClock, waitImpl: async () => { lateClock = 1001 },
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body)
      return { ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: request.id, result: '0x1' }) }
    },
  })
  await late.client.getChainId()
  await assert.rejects(late.client.getChainId(), /deadline_elapsed/)
  assert.equal(lateBudget.starts, 1)
  let afterWaitOwned = true
  const lostBudget = createSharedBudget({ now: () => clock, ownership: {
    assertHeld: () => { if (!afterWaitOwned) throw new Error('writer_lost_after_wait') },
  } })
  const lost = pacedRpcProvider(providerA, lostBudget, { now: () => clock,
    waitImpl: async (ms) => { clock += ms; afterWaitOwned = false },
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body)
      return { ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: request.id, result: '0x1' }) }
    },
  })
  await lost.client.getChainId()
  await assert.rejects(lost.client.getChainId(), /writer_lost_after_wait/)
  assert.equal(lostBudget.starts, 1)
})

test('first HTTP429 blocks queued physical starts on that host while the other host continues', async () => {
  const budget = createSharedBudget({})
  let failingFetches = 0
  const one = makeRpcProvider(providerA, budget, { fetchImpl: async () => {
    failingFetches += 1; return { ok: false, status: 429 }
  } })
  const results = await Promise.allSettled(['0x01', '0x02', '0x03'].map((slot) =>
    one.client.getStorageAt({ address: `0x${'1'.repeat(40)}`, slot })))
  assert.ok(results.every((result) => result.status === 'rejected' && /http_429/.test(result.reason.message)))
  assert.equal(failingFetches, 1)
  assert.equal(one.trace.length, 1)
  assert.equal(one.trace[0].request.id, 1)
  assert.equal(one.terminalReason, 'http_429')
  const two = makeRpcProvider(providerB, budget, { fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body)
    return { ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: request.id, result: '0x1' }) }
  } })
  assert.equal(await two.client.getChainId(), 1)
  assert.equal(budget.starts, 2)
  assert.equal(isValidSuccessfulHistoricalQuoteTrace(one.trace), false)
  assert.equal(isValidSuccessfulHistoricalQuoteTrace(two.trace), true)
})

test('HTTP200 internal RPC errors retain envelopes and stop queued storage requests on only that host', async () => {
  const budget = createSharedBudget({})
  let fetches = 0
  const one = makeRpcProvider(providerA, budget, { fetchImpl: async (_url, options) => {
    fetches += 1
    const request = JSON.parse(options.body)
    return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: request.id,
      error: { code: -32603, message: 'Internal error' } }) }
  } })
  const results = await Promise.allSettled(['0x01', '0x02', '0x03'].map((slot) =>
    one.client.getStorageAt({ address: `0x${'1'.repeat(40)}`, slot })))
  assert.ok(results.every((result) => result.status === 'rejected' && /provider_rpc_internal_error/.test(result.reason.message)))
  assert.equal(fetches, 1)
  assert.equal(budget.starts, 1)
  assert.equal(one.trace.length, 1)
  assert.deepEqual(one.trace[0].response, { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'Internal error' } })
  assert.equal(one.terminalReason, 'provider_rpc_internal_error')
  const two = makeRpcProvider(providerB, budget, { fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body)
    return { ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: request.id, result: '0x1' }) }
  } })
  assert.equal(await two.client.getChainId(), 1)
  assert.equal(budget.starts, 2)
  assert.equal(isValidSuccessfulHistoricalQuoteTrace(one.trace), false)
  assert.equal(isValidSuccessfulHistoricalQuoteTrace(two.trace), true)
  const anchorBudget = createSharedBudget({})
  const anchor = makeRpcProvider(providerA, anchorBudget, { projectBlockHeaders: true,
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body)
      return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: request.id,
        error: { code: -32603, message: 'Internal error' } }) }
    },
  })
  await assert.rejects(anchor.client.getBlock({ blockTag: 'finalized' }), /provider_rpc_internal_error/)
  assert.deepEqual(anchor.trace[0].response, { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'Internal error' } })
  assert.equal(anchor.trace[0].evidenceType, 'rpc_error_envelope_v1')
  assert.equal(anchorBudget.starts, 1)
})

test('contract reverts and malformed internal-error envelopes do not trip the internal backend circuit', async () => {
  for (const malformed of [false, true]) {
    const budget = createSharedBudget({})
    let calls = 0
    const provider = makeRpcProvider(providerA, budget, { fetchImpl: async (_url, options) => {
      calls += 1
      const request = JSON.parse(options.body)
      const payload = calls === 1 ? { jsonrpc: '2.0', id: request.id + (malformed ? 1 : 0),
        error: malformed ? { code: -32603, message: 'Internal error' } :
          { code: -32000, message: 'execution reverted', data: '0xdeadbeef' } } :
        { jsonrpc: '2.0', id: request.id, result: '0x1' }
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) }
    } })
    await assert.rejects(provider.client.getChainId(), malformed ? /rpc_envelope_invalid/ : /provider_rpc_error/)
    assert.equal(provider.terminalReason, null)
    assert.equal(await provider.client.getChainId(), 1)
    assert.equal(calls, 2)
    assert.equal(budget.starts, 2)
    if (!malformed) assert.equal(provider.trace[0].response.error.data, '0xdeadbeef')
  }
})

test('minus32603 with declared revert data or a different message remains nonsticky', async () => {
  for (const error of [
    { code: -32603, message: 'execution reverted', data: '0xdeadbeef' },
    { code: -32603, message: 'Internal error', data: '0xdeadbeef' },
    { code: -32603, message: 'Internal error', data: null },
    { code: -32603, message: 'execution reverted' },
  ]) {
    const budget = createSharedBudget({})
    let calls = 0
    const provider = makeRpcProvider(providerA, budget, { fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body)
      calls += 1
      return { ok: true, status: 200, text: async () => JSON.stringify(calls === 1 ?
        { jsonrpc: '2.0', id: request.id, error } : { jsonrpc: '2.0', id: request.id, result: '0x1' }) }
    } })
    await assert.rejects(provider.client.call({ to: `0x${'1'.repeat(40)}`, data: '0x', blockNumber: 1n }), /provider_rpc_error/)
    assert.deepEqual(provider.trace[0].response.error, error)
    assert.equal(provider.terminalReason, null)
    assert.equal(await provider.client.getChainId(), 1)
    assert.equal(calls, 2)
    assert.equal(budget.starts, 2)
  }
})

test('explicit retry selects only an existing failed immutable slot and rejects invalid overrides before RPC', async () => {
  const root = mkdtempSync(join(tmpdir(), 'depth-targeted-retry-'))
  const now = () => Date.parse('2026-10-07T12:00:00Z')
  const plan = buildRoster({ venues: loadConfig(), providers: [providerA, providerB], now: new Date(now()) })
  const day = plan.record.anchors[0]
  const block = '25283318', blockTag = `0x${BigInt(block).toString(16)}`, hash = `0x${'a'.repeat(64)}`
  const time = `${day}T00:00:00.000Z`
  let fetches = 0
  const fetchImpl = async (_url, options) => {
    fetches += 1
    const request = JSON.parse(options.body)
    const result = request.method === 'eth_getBlockByNumber' ?
      { number: blockTag, hash, timestamp: `0x${BigInt(Date.parse(time) / 1000).toString(16)}` } : '0x'
    return { ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) }
  }
  const retrySlot = { rosterId: plan.record.rosterId, venue: 'sUSDS', day }
  const options = { root, now, providers: [providerA, providerB], fetchImpl, retrySlot }
  const appendFailure = () => appendHistoricalQuoteAttempt(plan.record.rosterId, 'sUSDS', day, {
    rosterId: plan.record.rosterId, venue: 'sUSDS', anchorDay: day, status: 'failed', reason: 'predeployment_code_absent',
    source: { block, hash, time, offsetSeconds: 0 },
    configIdentity: plan.record.venues.find((venue) => venue.name === 'sUSDS').configIdentity,
    marketIdentities: plan.record.venues.find((venue) => venue.name === 'sUSDS').marketIdentities,
    implementationIdentity: null, levels: COST_LEVELS_PCT, captures: [], rpcStarts: 0,
  }, { root })
  try {
    writeHistoricalQuoteRoster(plan.record, { root })
    writeHistoricalQuoteAnchor(plan.record.rosterId, { day, targetAtUtc: time,
      selectedProviderId: providerA.host, block, blockHash: hash, blockTimeUtc: time, offsetSeconds: 0,
      headerEvidence: [{ request: { jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: [blockTag, false] },
        response: { jsonrpc: '2.0', id: 1, result: { number: blockTag, hash, timestamp: `0x${BigInt(Date.parse(time) / 1000).toString(16)}` } } }],
    }, { root })
    await assert.rejects(runTick(options), /retry_slot_not_failed/)
    appendFailure()
    const original = readFileSync(join(root, `roster-${plan.record.rosterId}`, 'records', 'sUSDS', day, 'attempt-01.json'), 'utf8')
    for (const patch of [
      { retrySlot: { ...retrySlot, venue: 'unknown' } },
      { retrySlot: { ...retrySlot, day: '2026-06-11' } }, // unsealed anchor
      { retrySlot: { ...retrySlot, extra: true } },
      { retrySlot: { ...retrySlot, rosterId: '0'.repeat(64) } },
      { providers: [providerA, { ...providerB, uriSha256: sha('changed') }] },
      { retrySlot: { ...retrySlot, day: '2026-10-07' }, now: () => Date.parse('2026-10-06T12:00:00Z') },
    ]) await assert.rejects(runTick({ ...options, ...patch }))
    assert.equal(fetches, 0)
    assert.equal(chooseNextSlot(plan.record, [], root).venue, 'sUSDe')
    const result = await runTick(options)
    assert.equal(result.venue, 'sUSDS')
    assert.equal(result.anchorDay, day)
    assert.equal(result.sequence, 2)
    assert.equal(result.reason, 'predeployment_code_absent')
    assert.equal(fetches, 4)
    assert.equal(readFileSync(join(root, `roster-${plan.record.rosterId}`, 'records', 'sUSDS', day, 'attempt-01.json'), 'utf8'), original)
    for (let index = 2; index < 8; index += 1) appendFailure()
    await assert.rejects(runTick(options), /retry_slot_not_failed/)
    assert.equal(fetches, 4)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('realistic full block anchor responses seal bounded explicit header projections and verify search', async () => {
  const root = mkdtempSync(join(tmpdir(), 'depth-large-anchor-'))
  const day = '2026-06-10'
  const target = BigInt(Date.parse(`${day}T00:00:00Z`) / 1000)
  const selected = 25_000_000n
  let rawBytes = 0
  let maxResponseBytes = 0
  const rawTrace = []
  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body)
    const number = request.params[0] === 'finalized' ? selected + 500_000n : BigInt(request.params[0])
    const payload = { jsonrpc: '2.0', id: request.id, result: {
      number: `0x${number.toString(16)}`,
      hash: `0x${number.toString(16).padStart(64, '0')}`,
      parentHash: `0x${(number - 1n).toString(16).padStart(64, '0')}`,
      timestamp: `0x${(target + (number - selected) * 12n).toString(16)}`,
      transactions: Array.from({ length: 500 }, (_, index) => `0x${index.toString(16).padStart(64, '0')}`),
      withdrawals: [], logsBloom: `0x${'0'.repeat(512)}`,
    } }
    const wire = JSON.stringify(payload)
    rawTrace.push({ request, response: payload })
    rawBytes += Buffer.byteLength(wire)
    maxResponseBytes = Math.max(maxResponseBytes, Buffer.byteLength(wire))
    return { ok: true, text: async () => wire }
  }
  try {
    const budget = createSharedBudget({})
    const provider = makeRpcProvider(providerA, budget, { fetchImpl, projectBlockHeaders: true })
    const anchor = await resolveUtcAnchor(provider, day, budget)
    assert.ok(rawBytes > 512 * 1024)
    assert.ok(maxResponseBytes < 1024 * 1024)
    assert.ok(Buffer.byteLength(JSON.stringify(anchor)) < 32 * 1024)
    assert.equal(anchor.block, selected.toString())
    assert.ok(anchor.headerEvidence.every((entry) => entry.evidenceType === 'block_header_projection_v1'))
    assert.ok(anchor.headerEvidence.every((entry) => !Object.hasOwn(entry.response.result, 'transactions')))
    const plan = buildRoster({ venues: loadConfig(), providers: [providerA, providerB], now: new Date('2026-10-07T12:00:00Z') })
    writeHistoricalQuoteRoster(plan.record, { root, stat: () => ({ bavail: 2_000_000, bsize: 4096 }) })
    assert.throws(() => writeHistoricalQuoteAnchor(plan.record.rosterId,
      { ...anchor, headerEvidenceType: undefined, headerEvidence: rawTrace },
      { root, stat: () => ({ bavail: 2_000_000, bsize: 4096 }) }), /record_size/)
    assert.throws(() => appendHistoricalQuoteAnchorFailure(plan.record.rosterId, day,
      { reason: 'collector_failure', evidence: { rawRpcTrace: rawTrace } },
      { root, stat: () => ({ bavail: 2_000_000, bsize: 4096 }) }), /record_size/)
    const stored = writeHistoricalQuoteAnchor(plan.record.rosterId, anchor, { root, stat: () => ({ bavail: 2_000_000, bsize: 4096 }) })
    assert.ok(Buffer.byteLength(JSON.stringify(stored)) < 64 * 1024)
    assert.equal((await verifyArchive({ root })).rosters, 1)
    assert.throws(() => writeHistoricalQuoteAnchor(plan.record.rosterId, {
      ...anchor, headerEvidence: anchor.headerEvidence.map((entry, index) => index ? entry : { ...entry, evidenceType: 'raw' }),
    }, { root }), /anchor_header_evidence_invalid/)
    const path = join(root, `roster-${plan.record.rosterId}`, 'anchors', `${day}.json`)
    const { sha256: _seal, ...tampered } = structuredClone(stored)
    // Re-seal a structurally valid reordered trace: verification must check the
    // actual bisection sequence, independently of the file checksum.
    ;[tampered.headerEvidence[2], tampered.headerEvidence[3]] =
      [tampered.headerEvidence[3], tampered.headerEvidence[2]]
    writeFileSync(path, JSON.stringify({ ...tampered, sha256: sha(JSON.stringify(tampered)) }))
    await assert.rejects(verifyArchive({ root }), /anchor_raw_header_mismatch/)
    console.log(JSON.stringify({ diagnostic: 'full_block_anchor_regression', rpcStarts: budget.starts, rawBytes, maxResponseBytes, storedBytes: Buffer.byteLength(JSON.stringify(stored)) }))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('anchor failure preserves bounded header evidence and original typed reason', async () => {
  const root = mkdtempSync(join(tmpdir(), 'depth-anchor-failure-'))
  let calls = 0
  try {
    const result = await runTick({ root, providers: [providerA, providerB],
      now: () => Date.parse('2026-10-07T12:00:00Z'),
      fetchImpl: async (_url, options) => {
        const request = JSON.parse(options.body)
        calls += 1
        return { ok: true, text: async () => JSON.stringify({
          jsonrpc: '2.0', id: request.id, result: {
            number: request.params[0] === 'finalized' ? '0x100' : request.params[0], hash: `0x${'1'.repeat(64)}`, parentHash: `0x${'2'.repeat(64)}`,
            timestamp: calls === 4 ? `0x${'1'.repeat(1000)}` : calls === 1 ? `0x${(BigInt(Date.parse('2026-06-10T00:00:00Z') / 1000) + 3600n).toString(16)}` : '0x1', transactions: Array.from({ length: 500 }, () => `0x${'3'.repeat(64)}`),
          },
        }) }
      },
    })
    assert.equal(result.reason, 'anchor_header_projection_invalid')
    assert.equal(result.evidence.evidenceType, 'anchor_header_trace_v1')
    assert.ok(result.evidence.headerEvidence.length > 2)
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 64 * 1024)
    assert.ok(result.evidence.headerEvidence.slice(0, -1).every((entry) => entry.evidenceType === 'block_header_projection_v1'))
    assert.equal(result.evidence.headerEvidence.at(-1).evidenceType, 'response_commitment_only')
    assert.equal(result.evidence.headerEvidence.at(-1).response, null)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('finalized head at or before midnight cannot publish an immutable anchor', async () => {
  const day = '2026-06-10'
  const target = BigInt(Date.parse(`${day}T00:00:00Z`) / 1000)
  for (const offset of [0n, -60n]) {
    const root = mkdtempSync(join(tmpdir(), 'depth-head-boundary-'))
    try {
      const result = await runTick({ root, providers: [providerA, providerB],
        now: () => Date.parse('2026-10-07T12:00:00Z'),
        fetchImpl: async (_url, options) => {
          const request = JSON.parse(options.body)
          const number = request.params[0] === 'finalized' ? 100n : BigInt(request.params[0])
          return { ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: request.id,
            result: { number: `0x${number.toString(16)}`, hash: `0x${'a'.repeat(64)}`,
              parentHash: `0x${'b'.repeat(64)}`, timestamp: `0x${(target + offset - (100n - number) * 12n).toString(16)}` },
          }) }
        },
      })
      assert.equal(result.reason, 'archive_anchor_not_yet_available')
      assert.equal(result.evidence.headerEvidence.length, 1)
      assert.equal(existsSync(join(root, `roster-${result.rosterId}`, 'anchors', `${day}.json`)), false)
      assert.equal((await verifyArchive({ root })).anchorFailures, 1)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
})

test('new raw anchor resolution rejects response block numbers differing from their requests', async () => {
  const day = '2026-06-10'
  const target = BigInt(Date.parse(`${day}T00:00:00Z`) / 1000)
  for (const mismatch of [false, true]) {
    const budget = createSharedBudget({})
    const provider = makeRpcProvider(providerA, budget, {
      fetchImpl: async (_url, options) => {
        const request = JSON.parse(options.body)
        const number = request.params[0] === 'finalized' ? 100n : BigInt(request.params[0])
        return { ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: request.id,
          result: { number: `0x${(number + (mismatch ? 1n : 0n)).toString(16)}`,
            hash: `0x${number.toString(16).padStart(64, '0')}`,
            parentHash: `0x${(number - 1n).toString(16).padStart(64, '0')}`,
            timestamp: `0x${(target + (number - 50n) * 12n).toString(16)}`, transactions: [],
          },
        }) }
      },
    })
    if (mismatch) await assert.rejects(resolveUtcAnchor(provider, day, budget), /anchor_header_search_invalid/)
    else assert.equal((await resolveUtcAnchor(provider, day, budget)).block, '50')
  }
})

test('daily UTC roster uses 120 ordered midnight targets independent of local timezone', () => {
  const anchors = dailyUtcAnchors(new Date('2026-10-07T19:22:00.000-04:00'))
  assert.equal(anchors.length, 120)
  assert.equal(anchors[0], '2026-06-10')
  assert.equal(anchors.at(-1), '2026-10-07')
  assert.ok(
    anchors.every(
      (day, index) =>
        !index ||
        Date.parse(`${day}T00:00:00Z`) - Date.parse(`${anchors[index - 1]}T00:00:00Z`) ===
          86_400_000,
    ),
  )
})

test('provider selection requires distinct hosts and retains only non-secret identity', () => {
  assert.throws(
    () => parseProviderUrls('https://same.example/keyA,https://same.example/keyB'),
    /hosts_not_distinct/,
  )
  assert.throws(() => parseProviderUrls('https://one.example/key'), /two_archive_hosts_required/)
  const providers = parseProviderUrls('https://one.example/secret,https://two.example/secret')
  assert.deepEqual(
    providers.map(({ host }) => host),
    ['one.example', 'two.example'],
  )
  assert.equal(
    parseProviderUrls('https://one.example./secret,https://two.example/secret')[0].host,
    'one.example',
  )
  assert.throws(
    () => parseProviderUrls('https://one.example./a,https://one.example/b'),
    /hosts_not_distinct/,
  )
  assert.ok(providers.every(({ uriSha256 }) => /^[0-9a-f]{64}$/.test(uriSha256)))
  const frozen = buildRoster({
    venues: loadConfig(),
    providers,
    now: new Date('2026-10-07T12:00:00.000Z'),
  })
  assert.ok(!JSON.stringify(frozen.record).includes('secret'))
})

test('shared physical-start cap is enforced across individually wrapped hosts', async () => {
  let fetchStarts = 0
  const fetchImpl = async (_url, options) => {
    fetchStarts += 1
    const request = JSON.parse(options.body)
    return {
      ok: true,
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: request.id, result: '0x1' }),
    }
  }
  const budget = createSharedBudget({ maxStarts: 1 })
  const one = makeRpcProvider(providerA, budget, { fetchImpl })
  const two = makeRpcProvider(providerB, budget, { fetchImpl })
  assert.equal(await one.client.getChainId(), 1)
  await assert.rejects(two.client.getChainId(), /rpc_start_cap/)
  assert.equal(fetchStarts, 1)
  assert.equal(budget.starts, 1)
  assert.deepEqual(one.trace[0].request, {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_chainId',
    params: [],
  })
  assert.deepEqual(one.trace[0].response, { jsonrpc: '2.0', id: 1, result: '0x1' })
})

test('parallel RPC starts receive unique ids and produce a replayable raw trace', async () => {
  const budget = createSharedBudget({})
  const provider = makeRpcProvider(providerA, budget, {
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body)
      await new Promise((resolve) => setTimeout(resolve, request.params[1] === '0x01' ? 5 : 0))
      return {
        ok: true,
        text: async () =>
          JSON.stringify({ jsonrpc: '2.0', id: request.id, result: '0x' + '0'.repeat(64) }),
      }
    },
  })
  await Promise.all([
    provider.client.getStorageAt({ address: '0x' + '1'.repeat(40), slot: '0x01' }),
    provider.client.getStorageAt({ address: '0x' + '1'.repeat(40), slot: '0x02' }),
  ])
  assert.deepEqual(
    provider.trace.map((entry) => entry.request.id).sort((a, b) => a - b),
    [1, 2],
  )
  assert.equal(isValidSuccessfulHistoricalQuoteTrace(provider.trace), true)
  assert.equal(budget.starts, 2)
})

test('sUSDS EOA pocket capture preserves pinned identity/balance proof and rejects missing callable code', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'historical-depth-full-capture-test-'))
  const venues = loadConfig()
  const plan = buildRoster({
    venues,
    providers: [providerA, providerB],
    now: new Date('2026-10-07T12:00:00.000Z'),
  })
  const roster = writeHistoricalQuoteRoster(plan.record, { root })
  const route = venues.find((venue) => venue.name === 'sUSDS')
  const frozen = roster.venues.find((venue) => venue.name === 'sUSDS')
  const market = route.depthMarkets.find((entry) => entry.enabled)
  const block = 22_000_000n
  const blockHash = `0x${'a'.repeat(64)}`
  const blockTimeUtc = '2026-10-06T00:00:00.000Z'
  const blockTag = `0x${block.toString(16)}`
  const timestamp = `0x${Math.floor(Date.parse(blockTimeUtc) / 1000).toString(16)}`
  const word = (value) => BigInt(value).toString(16).padStart(64, '0')
  const addr = (value) => value.toLowerCase().slice(2).padStart(64, '0')
  const selectorSignatures = [
    'asset()',
    'decimals()',
    'convertToAssets(uint256)',
    'previewRedeem(uint256)',
    'psm()',
    'pocket()',
    'usds()',
    'tout()',
    'gem()',
    'balanceOf(address)',
  ]
  const selectors = new Map(
    selectorSignatures.map((signature) => [toFunctionSelector(signature), signature]),
  )
  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body)
    let result
    if (request.method === 'eth_getBlockByNumber')
      result = { number: blockTag, hash: blockHash, timestamp }
    else if (request.method === 'eth_getCode')
      result = request.params[0].toLowerCase() === market.buffer.toLowerCase() ? '0x' : '0x60006000'
    else if (request.method === 'eth_getStorageAt') result = `0x${'0'.repeat(64)}`
    else if (request.method === 'eth_call') {
      const target = request.params[0].to.toLowerCase()
      const signature = selectors.get(request.params[0].data.slice(0, 10))
      let output
      if (signature === 'asset()') output = addr(route.underlying)
      else if (signature === 'decimals()')
        output = word(target === market.bufferToken.toLowerCase() ? 6 : 18)
      else if (signature === 'convertToAssets(uint256)' || signature === 'previewRedeem(uint256)')
        output = word(10n ** 18n)
      else if (signature === 'psm()') output = addr(market.address)
      else if (signature === 'usds()') output = addr(route.underlying)
      else if (signature === 'pocket()') output = addr(market.buffer)
      else if (signature === 'tout()') output = word(0)
      else if (signature === 'gem()') output = addr(market.bufferToken)
      else if (signature === 'balanceOf(address)') output = word(1_000_000_000)
      else throw new Error(`unhandled_call_${signature ?? 'unknown'}`)
      result = `0x${output}`
    } else throw new Error(`unhandled_method_${request.method}`)
    return {
      ok: true,
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: request.id, result }),
    }
  }
  try {
    const captures = await Promise.all(
      [providerA, providerB].map(async (provider) => {
        const budget = createSharedBudget({})
        const client = makeRpcProvider(provider, budget, { fetchImpl })
        return captureProvider(
          client,
          route,
          frozen,
          { block: block.toString(), blockHash, blockTimeUtc },
          budget,
        )
      }),
    )
    assert.ok(captures.every((capture) => capture.reason === null))
    assert.ok(!codeAddresses(route).includes(market.buffer.toLowerCase()))
    assert.ok(codeAddresses({ ...route, depthMarkets: [{ ...market, wrapper: market.buffer }] })
      .includes(market.buffer.toLowerCase())) // a separate callable role still requires code
    for (const capture of captures) {
      assert.ok(!Object.hasOwn(capture.code, market.buffer.toLowerCase()))
      const calls = capture.rawRpcTrace.filter((entry) => entry.request.method === 'eth_call')
      const pockets = calls.filter((entry) => entry.request.params[0].data.startsWith(toFunctionSelector('pocket()')))
      assert.equal(pockets.length, 2)
      assert.ok(pockets.every((entry) => entry.response.result === `0x${addr(market.buffer)}` && entry.request.params[1] === blockTag))
      const balance = calls.find((entry) => entry.request.params[0].data.startsWith(toFunctionSelector('balanceOf(address)')))
      assert.equal(balance.request.params[0].to.toLowerCase(), market.bufferToken.toLowerCase())
      assert.equal(balance.request.params[0].data.slice(10), addr(market.buffer))
      assert.equal(balance.request.params[1], blockTag)
    }
    assert.ok(
      captures.every((capture) => isValidSuccessfulHistoricalQuoteTrace(capture.rawRpcTrace)),
    )
    const venue = { ...frozen, depthMarkets: frozen.markets }
    assert.ok(captures.every((capture) => codeEvidenceMatches(capture, block.toString(), venue)))
    const replayed = await Promise.all(
      captures.map((capture) => replayProviderCapture(capture, venue, block)),
    )
    assert.deepEqual(replayed[0], captures[0].output)
    assert.deepEqual(replayed[1], captures[1].output)
    const missingCodeBudget = createSharedBudget({})
    const missingCodeProvider = makeRpcProvider(providerA, missingCodeBudget, {
      fetchImpl: async (url, options) => {
        const request = JSON.parse(options.body)
        if (request.method === 'eth_getCode' && request.params[0].toLowerCase() === market.wrapper.toLowerCase())
          return { ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: request.id, result: '0x' }) }
        return fetchImpl(url, options)
      },
    })
    const missingCode = await captureProvider(missingCodeProvider, route, frozen,
      { block: block.toString(), blockHash, blockTimeUtc }, missingCodeBudget)
    assert.equal(missingCode.reason, 'predeployment_code_absent')
    const wrongPocket = structuredClone(captures[0])
    wrongPocket.rawRpcTrace.find((entry) => entry.request.method === 'eth_call' &&
      entry.request.params[0].data.startsWith(toFunctionSelector('pocket()'))).response.result = `0x${addr(route.address)}`
    await assert.rejects(replayProviderCapture(wrongPocket, venue, block), /replay_quote_unavailable/)
    const wrongBalance = structuredClone(captures[0])
    wrongBalance.rawRpcTrace.find((entry) => entry.request.method === 'eth_call' &&
      entry.request.params[0].data.startsWith(toFunctionSelector('balanceOf(address)')))
      .request.params[0].data = `${toFunctionSelector('balanceOf(address)')}${addr(route.address)}`
    await assert.rejects(replayProviderCapture(wrongBalance, venue, block), /replay_quote_unavailable/)
    const throttledBudget = createSharedBudget({})
    let throttles = 0
    const throttled = makeRpcProvider(providerB, throttledBudget, {
      fetchImpl: async (url, options) => {
        const request = JSON.parse(options.body)
        if (request.method === 'eth_call' && request.params[0].data.startsWith(toFunctionSelector('balanceOf(address)'))) {
          throttles += 1
          return { ok: false, status: 429 }
        }
        return fetchImpl(url, options)
      },
    })
    const throttledCapture = await captureProvider(throttled, route, frozen,
      { block: block.toString(), blockHash, blockTimeUtc }, throttledBudget)
    assert.equal(throttledCapture.reason, 'http_429')
    assert.equal(throttles, 1)
    assert.equal(isValidSuccessfulHistoricalQuoteTrace(throttledCapture.rawRpcTrace), false)
    for (const failureStage of ['storage', 'nav']) {
      const internalBudget = createSharedBudget({})
      let internalFailures = 0
      const internalProvider = makeRpcProvider(providerB, internalBudget, {
        fetchImpl: async (url, options) => {
          const request = JSON.parse(options.body)
          if (failureStage === 'storage' && request.method === 'eth_getStorageAt' ||
            failureStage === 'nav' && request.method === 'eth_call' && request.params[0].data.startsWith(toFunctionSelector('decimals()'))) {
            internalFailures += 1
            return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: request.id,
              error: { code: -32603, message: 'Internal error' } }) }
          }
          return fetchImpl(url, options)
        },
      })
      const failed = await captureProvider(internalProvider, route, frozen,
        { block: block.toString(), blockHash, blockTimeUtc }, internalBudget)
      assert.equal(failed.reason, 'provider_rpc_internal_error') // survives the NAV read helper's catch
      assert.equal(internalFailures, 1)
      assert.equal(failed.output, null)
      assert.equal(failed.rawRpcTrace.filter((entry) => entry.response?.error?.code === -32603).length, 1)
      assert.equal(failed.rawRpcTrace.length, internalBudget.starts)
    }
    const day = '2026-10-06'
    const anchorBudget = createSharedBudget({})
    const anchorProvider = makeRpcProvider(providerA, anchorBudget, { projectBlockHeaders: true,
      fetchImpl: async (_url, options) => {
        const request = JSON.parse(options.body)
        const n = request.params[0] === 'finalized' ? block + 1n : BigInt(request.params[0])
        const time = BigInt(Math.floor(Date.parse(blockTimeUtc) / 1000)) + (n - block) * 12n
        return { ok: true, text: async () => JSON.stringify({ jsonrpc:'2.0', id:request.id,
          result:{ number:`0x${n.toString(16)}`, hash:blockHash, parentHash:`0x${'b'.repeat(64)}`, timestamp:`0x${time.toString(16)}` } }) }
      } })
    const checkedSearch = await resolveUtcAnchor(anchorProvider, day, anchorBudget)
    const headerRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getBlockByNumber',
      params: [blockTag, false],
    }
    writeHistoricalQuoteAnchor(
      roster.rosterId,
      {
        day,
        targetAtUtc: `${day}T00:00:00.000Z`,
        selectedProviderId: providerA.host,
        block: block.toString(),
        blockHash,
        blockTimeUtc,
        offsetSeconds: 0,
        headerEvidence: checkedSearch.headerEvidence,
        headerEvidenceType: checkedSearch.headerEvidenceType,
      },
      { root },
    )
    const baseAttempt = {
      rosterId: roster.rosterId, anchorDay: day, venue: 'sUSDS', status: 'failed', reason: 'http_429',
      source: { block: block.toString(), hash: blockHash, time: blockTimeUtc, offsetSeconds: 0 },
      configIdentity: frozen.configIdentity, marketIdentities: frozen.marketIdentities,
      implementationIdentity: null, levels: COST_LEVELS_PCT, rpcStarts: 0,
    }
    const padCapture = (capture, incompressible = false) => {
      const copy = structuredClone(capture)
      const headers = copy.rawRpcTrace.filter((entry) => entry.request.method === 'eth_getBlockByNumber')
      const count = Math.ceil(((incompressible ? 390000 : 245825) - Buffer.byteLength(JSON.stringify(copy))) / 138)
      for (const entry of headers) entry.response.result.transactions = Array.from({ length: count }, (_, i) =>
        `0x${incompressible ? sha(String(i)) : 'b'.repeat(64)}`)
      return copy
    }
    async function withResume(run, { padded = false, incompressible = false, compressedSource = false, mutateSource } = {}) {
      const retryRoot = mkdtempSync(join(tmpdir(), 'depth-capture-resume-'))
      try {
        writeHistoricalQuoteRoster(plan.record, { root: retryRoot })
        writeHistoricalQuoteAnchor(roster.rosterId, readHistoricalQuoteAnchor(roster.rosterId, day, { root }), { root: retryRoot })
        const good = padded ? padCapture(captures[0], incompressible) : structuredClone(captures[0])
        if (mutateSource) mutateSource(good)
        const original = appendHistoricalQuoteAttempt(roster.rosterId, 'sUSDS', day,
          { ...baseAttempt, captures: [compressedSource ? encodeHistoricalQuoteCapture(good) : good, throttledCapture] }, { root: retryRoot })
        const originalPath = join(retryRoot, `roster-${roster.rosterId}`, 'records', 'sUSDS', day, 'attempt-01.json')
        const before = readFileSync(originalPath, 'utf8')
        const counts = new Map()
        const retryFetch = async (url, options) => {
          counts.set(url, (counts.get(url) ?? 0) + 1)
          const response = await fetchImpl(url, options)
          if (!padded) return response
          const request = JSON.parse(options.body)
          const envelope = JSON.parse(await response.text())
          if (request.method === 'eth_getBlockByNumber') envelope.result.transactions = good.rawRpcTrace[0].response.result.transactions
          return { ok: true, text: async () => JSON.stringify(envelope) }
        }
        const options = { root: retryRoot, now: () => Date.parse('2026-10-07T12:00:00Z'),
          providers: [providerA, providerB], retrySlot: { rosterId: roster.rosterId, venue: 'sUSDS', day },
          fetchImpl: retryFetch }
        await run({ retryRoot, original, originalPath, before, counts, options })
      } finally { rmSync(retryRoot, { recursive: true, force: true }) }
    }
    await t.test('failed primary source resumes only missing origin with exact physical accounting and immutable evidence', async () => {
      await withResume(async ({ retryRoot, original, originalPath, before, counts, options }) => {
        const resumed = await runTick(options)
        assert.equal(resumed.status, 'verified')
        assert.equal(resumed.study, 'historical-depth-quote-attempt-v3')
        assert.equal(resumed.reusedCaptures, 1)
        assert.equal(counts.get(providerA.url) ?? 0, 0)
        assert.equal(resumed.rpcStarts, counts.get(providerB.url))
        assert.equal(resumed.rpcStarts, decodeHistoricalQuoteCapture(resumed.captures[1]).rawRpcTrace.length)
        assert.equal(resumed.captures[0].sourceAttemptSha256, original.sha256)
        assert.equal(resumed.captures[0].captureSha256, historicalQuoteCaptureSha256(original.captures[0]))
        assert.equal(readFileSync(originalPath, 'utf8'), before)
        assert.deepEqual(resolveHistoricalQuoteCaptures(resumed, { root: retryRoot })[0], original.captures[0])
        const summary = await verifyArchive({ root: retryRoot })
        assert.equal(summary.failed, 1); assert.equal(summary.verified, 1); assert.equal(summary.replayed, 1)
      })
    })
    await t.test('large encoded pairs retain the three-record fallback with two direct complete sources', async () => {
      await withResume(async ({ retryRoot, options, counts }) => {
        const result = await runTick(options)
        assert.equal(result.status, 'verified')
        assert.equal(result.sequence, 4)
        assert.equal(result.study, 'historical-depth-quote-attempt-v2')
        assert.ok(result.captures.every((capture) => capture.evidenceType === 'capture_reference_v1'))
        const rows = readHistoricalQuoteAttempts(result.rosterId, 'sUSDS', day, { root: retryRoot })
        assert.equal(rows.filter((row) => row.reason === 'pair_pending').length, 2)
        assert.ok(rows.slice(1, 3).every((row) => row.study === 'historical-depth-quote-attempt-v3'))
        const decoded = resolveHistoricalQuoteCaptures(result, { root: retryRoot })
        assert.ok(decoded.every((capture) => Buffer.byteLength(JSON.stringify(capture)) <= 400 * 1024))
        assert.equal(result.rpcStarts, [...counts.values()].reduce((n, value) => n + value, 0))
        assert.equal((await verifyArchive({ root: retryRoot })).replayed, 1)
      }, { padded: true, incompressible: true, mutateSource: (capture) => { capture.reason = 'provider_unavailable' } })
    })
    await t.test('compressed failed primary source resumes only the missing origin and references the original decoded proof', async () => {
      await withResume(async ({ retryRoot, original, originalPath, before, counts, options }) => {
        const originalCapture = decodeHistoricalQuoteCapture(original.captures[0])
        assert.equal(original.study, 'historical-depth-quote-attempt-v3')
        const resumed = await runTick(options)
        assert.equal(resumed.status, 'verified')
        assert.equal(resumed.reusedCaptures, 1)
        assert.equal(counts.get(providerA.url) ?? 0, 0)
        assert.equal(resumed.rpcStarts, counts.get(providerB.url))
        assert.equal(resumed.captures[0].captureSha256, historicalQuoteCaptureSha256(originalCapture))
        assert.equal(readFileSync(originalPath, 'utf8'), before)
        assert.deepEqual(resolveHistoricalQuoteCaptures(resumed, { root: retryRoot })[0], originalCapture)
        assert.equal((await verifyArchive({ root: retryRoot })).replayed, 1)
      }, { compressedSource: true })
    })
    await t.test('compressed source commitment cannot hide changed header, code or output from complete replay', async () => {
      for (const mutateSource of [
        (capture) => { capture.rawRpcTrace[0].response.result.hash = `0x${'f'.repeat(64)}` },
        (capture) => { capture.code[Object.keys(capture.code)[0]].keccak256 = `0x${'f'.repeat(64)}` },
        (capture) => { for (const point of capture.output.markets[0].points) point.capacityUsd += 1 },
      ]) await withResume(async ({ retryRoot, original, options, counts }) => {
        const result = await runTick(options)
        assert.equal(result.status, 'failed')
        assert.equal(result.rpcStarts, 0)
        assert.equal(counts.size, 0)
        await assert.rejects(verifyArchive({ root: retryRoot }))
      }, { compressedSource: true, mutateSource })
    })
    await t.test('realistic 491k-byte embedded pair verifies with fresh capture and one bounded reference', async () => {
      await withResume(async ({ retryRoot, original, counts, options }) => {
        assert.ok(Buffer.byteLength(JSON.stringify(original.captures[0])) >= 245825)
        const resumed = await runTick(options)
        assert.equal(resumed.status, 'verified')
        assert.ok(Buffer.byteLength(JSON.stringify(resumed)) < 400 * 1024)
        const resolved = resolveHistoricalQuoteCaptures(resumed, { root: retryRoot })
        assert.ok(Buffer.byteLength(JSON.stringify(resolved)) > 491000)
        assert.ok(resolved.every((capture) => capture.rawRpcTrace.length > 0))
        assert.equal(counts.get(providerA.url) ?? 0, 0)
        assert.equal((await verifyArchive({ root: retryRoot })).replayed, 1)
      }, { padded: true })
    })
    await t.test('fresh disagreement remains failed and retries still point directly to original embedded source', async () => {
      await withResume(async ({ retryRoot, original, options }) => {
        const disagree = async (url, opts) => {
          const request = JSON.parse(opts.body)
          if (request.method === 'eth_getCode') return { ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: request.id, result: '0x60016000' }) }
          return options.fetchImpl(url, opts)
        }
        const failed = await runTick({ ...options, fetchImpl: disagree })
        assert.equal(failed.status, 'failed'); assert.equal(failed.reason, 'provider_code_identity_mismatch')
        assert.equal(failed.captures[0].sourceAttemptSequence, 1)
        assert.equal((await verifyArchive({ root: retryRoot })).failed, 2)
        const final = await runTick(options)
        // The fresh second capture from attempt two is itself complete: disagreement
        // must remain explicit rather than replacing it with another acquisition.
        assert.equal(final.status, 'failed'); assert.equal(final.reason, 'provider_code_identity_mismatch')
        assert.equal(final.captures[0].sourceAttemptSha256, original.sha256)
        assert.equal(final.rpcStarts, 0)
      })
    })
    await t.test('tampered candidate code, header, output, extra call, clock and foreign identity fail before physical dispatch', async () => {
      for (const mutateSource of [
        (capture) => { capture.code[Object.keys(capture.code)[0]].keccak256 = `0x${'f'.repeat(64)}` },
        (capture) => { capture.rawRpcTrace[0].response.result.hash = `0x${'f'.repeat(64)}` },
        (capture) => { capture.rawRpcTrace[0].response.result.number = [blockTag] },
        (capture) => { capture.output.markets[0].points[0].capacityUsd += 1 },
        (capture) => { const call = structuredClone(capture.rawRpcTrace.find((entry) => entry.request.method === 'eth_call')); call.request.id = 1000; call.response.id = 1000; capture.rawRpcTrace.push(call) },
        (capture) => { capture.completedAtUtc = '2099-01-01T00:00:00.000Z' },
        (capture) => { capture.uriSha256 = 'f'.repeat(64) },
      ]) await withResume(async ({ options, counts }) => {
        const failed = await runTick(options)
        assert.equal(failed.status, 'failed'); assert.equal(failed.rpcStarts, 0); assert.equal(counts.size, 0)
      }, { mutateSource })
    })
    await t.test('omitted sources are reacquired and oversize fresh pairs retain both complete bounded captures', async () => {
      await withResume(async ({ retryRoot, options, counts }) => {
        const resumed = await runTick(options)
        assert.equal(resumed.status, 'verified'); assert.equal(resumed.study, 'historical-depth-quote-attempt-v3')
        assert.ok(counts.get(providerA.url) > 0); assert.ok(counts.get(providerB.url) > 0)
        assert.equal(resumed.rpcStarts, [...counts.values()].reduce((sum, n) => sum + n, 0))
        assert.equal((await verifyArchive({ root: retryRoot })).verified, 1)
      }, { mutateSource: (capture) => { capture.rawEvidenceStatus = 'omitted_over_limit'; capture.rawRpcTrace = [] } })
      await withResume(async ({ retryRoot, options }) => {
        const fresh = await runTick(options)
        assert.equal(fresh.status, 'verified')
        assert.equal(fresh.sequence, 2)
        assert.equal(fresh.study, 'historical-depth-quote-attempt-v3')
        assert.ok(fresh.captures.every((c) => c.evidenceType === 'complete_capture_deflate_raw_v1'))
        assert.ok(Buffer.byteLength(JSON.stringify(fresh.captures)) < 400 * 1024)
        const resolved = resolveHistoricalQuoteCaptures(fresh, { root: retryRoot })
        assert.ok(resolved.every((c) => c.rawRpcTrace.length > 0 && c.rawEvidenceStatus === undefined))
        assert.ok(Buffer.byteLength(JSON.stringify(resolved)) > 491000)
        const rows = readHistoricalQuoteAttempts(fresh.rosterId, 'sUSDS', day, { root: retryRoot })
        assert.equal(rows.length, 2)
        assert.equal(rows.filter((r) => r.reason === 'pair_pending').length, 0)
        assert.equal(rows.reduce((n, r) => n + r.rpcStarts, 0), fresh.rpcStarts)
        assert.equal((await verifyArchive({ root: retryRoot })).verified, 1)
        await assert.rejects(runTick(options), /retry_slot_not_failed/)
      }, { padded: true, mutateSource: (capture) => { capture.reason = 'provider_unavailable' } })
    })
    await t.test('new provider roster copies checked anchors and captures an unattempted exact target without cross-roster reuse', async () => {
      await withResume(async ({ retryRoot, original, options }) => {
        const c = { ...providerB, host: 'third.archive.example', url: 'https://third.archive.example/secret', uriSha256: sha('third') }
        const before = readHistoricalQuoteAttempts(roster.rosterId, 'sUSDS', day, { root: retryRoot })
        await assert.rejects(enrollHistoricalQuoteProviderPolicy({ sourceRosterId: roster.rosterId, root: retryRoot,
          providers: [c, providerA], now: options.now }), /provider_enrollment_identity_invalid/)
        const enrolled = await enrollHistoricalQuoteProviderPolicy({ sourceRosterId: roster.rosterId, root: retryRoot,
          providers: [providerA, c], now: options.now })
        assert.notEqual(enrolled.rosterId, roster.rosterId)
        assert.equal(enrolled.copiedAnchors, 1)
        assert.equal(readHistoricalQuoteAnchor(enrolled.rosterId, day, { root: retryRoot }).blockHash, blockHash)
        let starts = 0
        const target = { rosterId: enrolled.rosterId, venue: 'sUSDS', day }
        const settings = { ...options, retrySlot: undefined, providers: [providerA, c], targetSlot: target,
          fetchImpl: (...args) => { starts++; return options.fetchImpl(...args) } }
        for (const invalid of [{ ...target, venue: 'unknown' }, { ...target, extra: true }, { ...target, day: '2026-06-11' }])
          await assert.rejects(runTick({ ...settings, targetSlot: invalid }))
        assert.equal(starts, 0)
        const result = await runTick(settings)
        assert.equal(result.status, 'verified')
        assert.equal(result.reusedCaptures, 0)
        assert.equal(result.rpcStarts, starts)
        assert.equal(result.study, 'historical-depth-quote-attempt-v3')
        assert.deepEqual(readHistoricalQuoteAttempts(roster.rosterId, 'sUSDS', day, { root: retryRoot }), before)
        assert.equal(original.captures[0].host, providerA.host)
      })
    })
    await t.test('reserves three sequence positions before any physical dispatch', async () => {
      await withResume(async ({ retryRoot, options, counts }) => {
        for (let i = 1; i < 6; i++) appendHistoricalQuoteAttempt(roster.rosterId, 'sUSDS', day,
          { ...baseAttempt, captures: [] }, { root: retryRoot })
        const before = readHistoricalQuoteAttempts(roster.rosterId, 'sUSDS', day, { root: retryRoot })
        for (const kind of ['retrySlot', 'targetSlot'])
          await assert.rejects(runTick({ ...options, retrySlot: undefined,
            [kind]: { rosterId: roster.rosterId, venue: 'sUSDS', day } }), /retry_slot_not_failed/)
        assert.equal(counts.size, 0)
        assert.deepEqual(readHistoricalQuoteAttempts(roster.rosterId, 'sUSDS', day, { root: retryRoot }), before)
        for (let i = 0; i < 7; i++) appendHistoricalQuoteAttempt(roster.rosterId, 'sUSDe', day,
          { ...baseAttempt, venue: 'sUSDe', captures: [] }, { root: retryRoot })
        appendHistoricalQuoteAttempt(roster.rosterId, 'scrvUSD', day,
          { ...baseAttempt, venue: 'scrvUSD', captures: [] }, { root: retryRoot })
        const selected = chooseNextSlot({ ...roster, anchors: [day] },
          [...readHistoricalQuoteAttempts(roster.rosterId, 'sUSDS', day, { root: retryRoot }),
            ...readHistoricalQuoteAttempts(roster.rosterId, 'sUSDe', day, { root: retryRoot }),
            ...readHistoricalQuoteAttempts(roster.rosterId, 'scrvUSD', day, { root: retryRoot })], retryRoot)
        assert.deepEqual(selected, { type: 'venue', venue: 'scrvUSD', day })
        for (const kind of ['retrySlot', 'targetSlot'])
          await assert.rejects(runTick({ ...options, retrySlot: undefined,
            [kind]: { rosterId: roster.rosterId, venue: 'sUSDe', day } }), /retry_slot_not_failed/)
        assert.equal(counts.size, 0)
        assert.equal(readHistoricalQuoteAttempts(roster.rosterId, 'sUSDe', day, { root: retryRoot }).length, 7)
      })
    })
    await t.test('an individual oversized response capture fails closed without partial source publication', async () => {
      await withResume(async ({ retryRoot, options }) => {
        const largeFetch = async (url, opts) => {
          const response = await options.fetchImpl(url, opts)
          const envelope = JSON.parse(await response.text())
          if (JSON.parse(opts.body).method === 'eth_getBlockByNumber')
            envelope.result.transactions = [...envelope.result.transactions, ...envelope.result.transactions, ...envelope.result.transactions]
          return { ok: true, text: async () => JSON.stringify(envelope) }
        }
        const result = await runTick({ ...options, fetchImpl: largeFetch })
        assert.equal(result.status, 'failed')
        assert.equal(result.reason, 'evidence_over_limit_individual_capture')
        assert.equal(result.sequence, 2)
        assert.equal(result.captures.length, 0)
        assert.ok(result.rpcStarts > 0)
        assert.equal(readHistoricalQuoteAttempts(roster.rosterId, 'sUSDS', day, { root: retryRoot }).length, 2)
      }, { padded: true, mutateSource: (capture) => { capture.reason = 'provider_unavailable' } })
    })
    await t.test('missing or corrupted immutable reference sources fail offline verification', async () => {
      for (const corruption of ['missing', 'bytes', 'resealed-proof']) await withResume(async ({ options, retryRoot, originalPath }) => {
        const resumed = await runTick(options)
        assert.equal(resumed.status, 'verified')
        if (corruption === 'missing') rmSync(originalPath)
        else if (corruption === 'bytes') writeFileSync(originalPath, '{corrupt')
        else {
          const body = JSON.parse(readFileSync(originalPath, 'utf8')); delete body.sha256
          body.captures[0].rawRpcTrace[0].response.result.hash = `0x${'f'.repeat(64)}`
          writeFileSync(originalPath, JSON.stringify({ ...body, sha256: sha(JSON.stringify(body)) }))
        }
        await assert.rejects(verifyArchive({ root: retryRoot }))
      })
    })
    appendHistoricalQuoteAttempt(
      roster.rosterId,
      'sUSDS',
      day,
      {
        rosterId: roster.rosterId,
        anchorDay: day,
        venue: 'sUSDS',
        status: 'verified',
        reason: null,
        source: { block: block.toString(), hash: blockHash, time: blockTimeUtc, offsetSeconds: 0 },
        configIdentity: frozen.configIdentity,
        marketIdentities: frozen.marketIdentities,
        implementationIdentity: sha(JSON.stringify(captures[0].code)),
        levels: COST_LEVELS_PCT,
        captures,
        rpcStarts: captures.reduce((total, capture) => total + capture.rawRpcTrace.length, 0),
      },
      { root },
    )
    const verified = await verifyArchive({ root })
    assert.equal(verified.verified, 1)
    assert.equal(verified.replayed, 1)
    await assert.rejects(runTick({ root, providers: [providerA, providerB],
      now: () => Date.parse('2026-10-07T12:00:00Z'),
      retrySlot: { rosterId: roster.rosterId, venue: 'sUSDS', day },
      fetchImpl: async () => assert.fail('verified slots cannot dispatch a retry'),
    }), /retry_slot_not_failed/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a successful late HTTP response is rejected and remains in raw trace', async () => {
  let clock = 1_000
  const budget = createSharedBudget({ now: () => clock, deadlineMs: 50 })
  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body)
    clock = 1_051
    return {
      ok: true,
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: request.id, result: '0x1' }),
    }
  }
  const provider = makeRpcProvider(providerA, budget, { fetchImpl, now: () => clock })
  await assert.rejects(provider.client.getChainId(), /deadline_elapsed/)
  assert.equal(budget.starts, 1)
  assert.equal(provider.trace[0].response.result, '0x1')
})

test('RPC envelope rejects mismatched ids, versions and result/error ambiguity while retaining evidence', async () => {
  const payloads = [
    (request) => ({ jsonrpc: '2.0', id: request.id + 1, result: '0x1' }),
    (request) => ({ jsonrpc: '1.0', id: request.id, result: '0x1' }),
    (request) => ({
      jsonrpc: '2.0',
      id: request.id,
      result: '0x1',
      error: { code: 1, message: 'error' },
    }),
    (request) => ({ jsonrpc: '2.0', id: request.id }),
  ]
  for (const makePayload of payloads) {
    const provider = makeRpcProvider(providerA, createSharedBudget({}), {
      fetchImpl: async (_url, options) => {
        const request = JSON.parse(options.body)
        return { ok: true, text: async () => JSON.stringify(makePayload(request)) }
      },
    })
    await assert.rejects(provider.client.getChainId(), /rpc_envelope_invalid/)
    assert.equal(provider.trace.length, 1)
    assert.equal(provider.trace[0].request.jsonrpc, '2.0')
    assert.equal(provider.trace[0].response.id, makePayload(provider.trace[0].request).id)
  }
})

test('worst-case single venue anchors include quote, code, proxy-slot, header and anchor-resolution starts', () => {
  const rows = estimateWorstCase(loadConfig())
  assert.deepEqual(rows, {
    sUSDe: { callsPerHost: 183, twoHostStarts: 366, startsIncludingAnchorResolution: 389 },
    sUSDS: { callsPerHost: 50, twoHostStarts: 100, startsIncludingAnchorResolution: 123 },
    scrvUSD: { callsPerHost: 345, twoHostStarts: 690, startsIncludingAnchorResolution: 713 },
  })
  const plan = dryRun({
    providers: [providerA, providerB],
    now: new Date('2026-10-07T12:00:00.000Z'),
  })
  assert.equal(plan.anchorCount, 120)
  assert.equal(plan.venueCount, 3)
  assert.ok(
    Object.values(plan.perVenueWorstCase).every(
      (row) => row.startsIncludingAnchorResolution < plan.maxStartsPerTick,
    ),
  )
})

const traceEntry = (id, method, params, result) => ({
  request: { jsonrpc: '2.0', id, method, params },
  response: { jsonrpc: '2.0', id, result },
})

test('offline code validation requires configured code and reconstructs proxy/beacon referents', () => {
  const proxy = `0x${'1'.repeat(40)}`
  const underlying = `0x${'2'.repeat(40)}`
  const implementation = `0x${'3'.repeat(40)}`
  const beacon = `0x${'4'.repeat(40)}`
  const beaconImplementation = `0x${'5'.repeat(40)}`
  const venue = { address: proxy, underlying, depthMarkets: [] }
  const zero = `0x${'0'.repeat(64)}`
  const word = (address) => `0x${address.slice(2).padStart(64, '0')}`
  const rawCode = new Map([
    [proxy, '0x6001'],
    [underlying, '0x6002'],
    [implementation, '0x6003'],
    [beacon, '0x6004'],
    [beaconImplementation, '0x6005'],
  ])
  const code = Object.fromEntries(
    [...rawCode].map(([address, bytes]) => [address, { keccak256: keccak256(bytes) }]),
  )
  code[proxy] = {
    ...code[proxy],
    eip1967Implementation: word(implementation),
    eip1967Beacon: word(beacon),
    beaconImplementation,
  }
  code[underlying] = {
    ...code[underlying],
    eip1967Implementation: zero,
    eip1967Beacon: zero,
  }
  const trace = []
  let id = 1
  for (const address of [proxy, underlying]) {
    trace.push(traceEntry(id++, 'eth_getCode', [address, '0x64'], rawCode.get(address)))
    trace.push(
      traceEntry(
        id++,
        'eth_getStorageAt',
        [address, EIP1967_IMPLEMENTATION_SLOT, '0x64'],
        address === proxy ? word(implementation) : zero,
      ),
    )
    trace.push(
      traceEntry(
        id++,
        'eth_getStorageAt',
        [address, EIP1967_BEACON_SLOT, '0x64'],
        address === proxy ? word(beacon) : zero,
      ),
    )
  }
  trace.push(traceEntry(id++, 'eth_getCode', [implementation, '0x64'], rawCode.get(implementation)))
  trace.push(traceEntry(id++, 'eth_getCode', [beacon, '0x64'], rawCode.get(beacon)))
  trace.push(
    traceEntry(
      id++,
      'eth_call',
      [{ to: beacon, data: '0x5c60da1b' }, '0x64'],
      word(beaconImplementation),
    ),
  )
  trace.push(
    traceEntry(
      id++,
      'eth_getCode',
      [beaconImplementation, '0x64'],
      rawCode.get(beaconImplementation),
    ),
  )
  const capture = { rawRpcTrace: trace, code }
  assert.equal(codeEvidenceMatches(capture, '100', venue), true)
  assert.equal(codeEvidenceMatches({ ...capture, code: {} }, '100', venue), false)
  const missingConfigured = structuredClone(capture)
  delete missingConfigured.code[underlying]
  assert.equal(codeEvidenceMatches(missingConfigured, '100', venue), false)
  const missingImplementation = structuredClone(capture)
  delete missingImplementation.code[implementation]
  assert.equal(codeEvidenceMatches(missingImplementation, '100', venue), false)
  const wrongBeacon = structuredClone(capture)
  wrongBeacon.code[proxy].beaconImplementation = implementation
  assert.equal(codeEvidenceMatches(wrongBeacon, '100', venue), false)
})

test('unfinished frozen roster resumes across UTC midnight and healthy anchored work outranks retries', () => {
  const root = mkdtempSync(join(tmpdir(), 'historical-depth-resume-test-'))
  const ampleDisk = () => ({ bavail: 2_000_000, bsize: 4096 })
  try {
    const venues = loadConfig()
    const firstPlan = buildRoster({
      venues,
      providers: [providerA, providerB],
      now: new Date('2026-10-07T23:59:00.000Z'),
    })
    const nextPlan = buildRoster({
      venues,
      providers: [providerA, providerB],
      now: new Date('2026-10-08T00:01:00.000Z'),
    })
    const frozen = writeHistoricalQuoteRoster(firstPlan.record, { root, stat: ampleDisk })
    assert.equal(findOrCreateRoster(nextPlan, root).rosterId, frozen.rosterId)
    const failedDay = frozen.anchors[0]
    appendHistoricalQuoteAnchorFailure(
      frozen.rosterId,
      failedDay,
      { reason: 'archive_window_pruned' },
      { root, stat: ampleDisk },
    )
    for (let index = 1; index < frozen.anchors.length; index += 1) {
      const day = frozen.anchors[index]
      const timestamp = `${day}T00:00:00.000Z`
      const block = index + 1
      const blockHash = `0x${block.toString(16).padStart(64, '0')}`
      writeHistoricalQuoteAnchor(
        frozen.rosterId,
        {
          day,
          targetAtUtc: timestamp,
          selectedProviderId: providerA.host,
          block: String(block),
          blockHash,
          blockTimeUtc: timestamp,
          offsetSeconds: 0,
          headerEvidence: [
            traceEntry(1, 'eth_getBlockByNumber', [`0x${block.toString(16)}`, false], {
              number: `0x${block.toString(16)}`,
              hash: blockHash,
              timestamp: `0x${Math.floor(Date.parse(timestamp) / 1000).toString(16)}`,
            }),
          ],
        },
        { root, stat: ampleDisk },
      )
    }
    const slot = chooseNextSlot(frozen, [], root)
    assert.deepEqual(slot, { type: 'venue', day: frozen.anchors[1], venue: frozen.venues[0].name })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('first sealed daily anchor serves venue quotes before creating the remaining 119 anchors', () => {
  const root = mkdtempSync(join(tmpdir(), 'historical-depth-first-quote-test-'))
  const ampleDisk = () => ({ bavail: 2_000_000, bsize: 4096 })
  try {
    const roster = buildRoster({
      venues: loadConfig(),
      providers: [providerA, providerB],
      now: new Date('2026-10-07T12:00:00.000Z'),
    })
    const frozen = writeHistoricalQuoteRoster(roster.record, { root, stat: ampleDisk })
    const day = frozen.anchors[0]
    const block = 1
    const timestamp = `${day}T00:00:00.000Z`
    const blockHash = `0x${'1'.padStart(64, '0')}`
    writeHistoricalQuoteAnchor(
      frozen.rosterId,
      {
        day,
        targetAtUtc: timestamp,
        selectedProviderId: providerA.host,
        block: String(block),
        blockHash,
        blockTimeUtc: timestamp,
        offsetSeconds: 0,
        headerEvidence: [
          traceEntry(1, 'eth_getBlockByNumber', [`0x${block.toString(16)}`, false], {
            number: `0x${block.toString(16)}`,
            hash: blockHash,
            timestamp: `0x${Math.floor(Date.parse(timestamp) / 1000).toString(16)}`,
          }),
        ],
      },
      { root, stat: ampleDisk },
    )
    assert.deepEqual(chooseNextSlot(frozen, [], root), {
      type: 'venue',
      day,
      venue: frozen.venues[0].name,
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('OS writer lock excludes concurrent ticks and safely recovers recognized unpublished temporary files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'historical-depth-lock-test-'))
  try {
    const release = await acquireHistoricalQuoteWriterLock(root)
    await assert.rejects(acquireHistoricalQuoteWriterLock(root), /writer_busy/)
    const orphanDir = join(root, 'roster-temp', 'records', 'sUSDe', '2026-10-01')
    mkdirSync(orphanDir, { recursive: true })
    const orphan = join(
      orphanDir,
      `attempt-01.json.${'a'.repeat(8)}-${'b'.repeat(4)}-${'c'.repeat(4)}-${'d'.repeat(4)}-${'e'.repeat(12)}.tmp`,
    )
    writeFileSync(orphan, '{partial')
    await release()
    const releaseRecovered = await acquireHistoricalQuoteWriterLock(root)
    assert.equal(existsSync(orphan), false)
    await releaseRecovered()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('archive reserve is the exact 1.25 GiB byte threshold', () => {
  assert.equal(MIN_HISTORICAL_QUOTE_FREE_BYTES, 1_342_177_280)
})


test('explicit provider policy selects unique configured HTTPS host/URI bindings without pool reorder or secret diagnostics', () => {
  const raw = 'https://one.example/private,https://two.example/private,https://three.example/private'
  const pool = parseProviderPool(raw)
  const policy = { schema:'historical_depth_quote_provider_policy_v1', policyId:'fixture-c1-c3', status:'pending',
    providers:[pool[0],pool[2]].map((p,i)=>({alias:i===0?'C1':'C3',hostSha256:sha(p.host),uriSha256:p.uriSha256})) }
  assert.deepEqual(resolveProviderPolicy(pool,policy).map((p)=>p.host),['one.example','three.example'])
  assert.deepEqual(parseProviderUrls(raw).map((p)=>p.host),['one.example','two.example'])
  const env = {get:k=>k==='RECORDER_RPC_URL'?raw:undefined}
  assert.deepEqual(configuredProviders(env,policy),[pool[0],pool[2]])
  // The active checked-in policy must reject an unrelated synthetic pool.
  assert.throws(()=>configuredProviders(env),/provider_policy_binding_missing/)
  assert.deepEqual(configuredProviders(env,{...policy,status:'active'}),[pool[0],pool[2]])
  for(const mutate of [p=>p.providers[1].uriSha256='0'.repeat(64),p=>p.providers[1].hostSha256='0'.repeat(64),
    p=>p.providers[1].uriSha256=[p.providers[1].uriSha256],p=>p.extra=true,p=>p.providers[1]=p.providers[0]]) {
    const p=structuredClone(policy);mutate(p);assert.throws(()=>resolveProviderPolicy(pool,p),/provider_policy_/)
  }
  assert.throws(()=>resolveProviderPolicy([...pool,pool[2]],policy),/provider_policy_binding_missing/)
  const http=parseProviderPool(raw.replace('https://three','http://three'))
  const p=structuredClone(policy);p.providers[1].uriSha256=http[2].uriSha256
  assert.throws(()=>resolveProviderPolicy(http,p),/provider_policy_binding_missing/)
  assert.deepEqual(pool.map(p=>p.host),['one.example','two.example','three.example'])
})
