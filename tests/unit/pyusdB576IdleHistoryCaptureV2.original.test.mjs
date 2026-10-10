/** Original physical controller tests. All responses are local fixtures; no RPC is acquired. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, lstatSync, rmSync, symlinkSync } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeFunctionData, encodeFunctionResult, encodeFunctionData } from 'viem'
import {
  PYUSD_B576_V2_ABI, PYUSD_B576_V2_POLICY, PYUSD_B576_V2_FLAGS, preparePyusdB576V2IdleHistory,
  pyusdB576V2PointReadPlan, pyusdB576V2StorageBudgetProof, capturePyusdB576V2IdleHistory,
  derivePyusdB576V2Point, pyusdB576V2EncodedOriginals, reconstructPyusdB576V2OriginalControl,
  assertPyusdB576V2DiskCapacity, pyusdB576V2FixedArtifacts, createPyusdB576V2Writer,
  pyusdB576V2Report, inspectPyusdB576V2RetainedHistory, runPyusdB576V2IdleHistory,
} from '../../scripts/research/pyusd-b576-idle-history-capture-v2.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url)), ZERO = '0x' + '0'.repeat(40)
const sha = (x) => createHash('sha256').update(x).digest('hex')
const seal = (body) => ({ ...body, sha256: sha(JSON.stringify(body)) })
const hosts = ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com']
const origins = hosts.map((host) => ({ host, url: 'https://' + host + '/local-pyusd-test-fixture' }))
const FRESH_S = '352805058661206444'
const nativeReply = (name, value) => encodeFunctionResult({ abi: PYUSD_B576_V2_ABI, functionName: name, result: value })

/** Test-only deterministic timers; the real CLI uses performance.now and native timers. */
function timerHarness(initial = 0, throwOnTimer = null) {
  let elapsed = initial, id = 0
  const active = new Map(), armed = [], cleared = []
  const setTimer = (callback, ms) => {
    const next = ++id
    if (next === throwOnTimer) throw Error('local_timer_arm_failure')
    const row = { id: next, callback, at: elapsed + ms, delay: ms, name: callback.name }
    active.set(next, row); armed.push(row); return next
  }
  const clearTimer = (timer) => { cleared.push(timer); active.delete(timer) }
  const advance = (ms) => {
    const target = elapsed + ms
    while (true) {
      const next = [...active.values()].filter((x) => x.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0]
      if (!next) break
      elapsed = next.at; active.delete(next.id); next.callback()
    }
    elapsed = target
  }
  return { active, armed, cleared, advance, setTimer, clearTimer, monotonic: () => elapsed,
    now: () => Date.parse('2026-10-10T05:10:00.000Z') + elapsed,
    pace: async (ms) => advance(ms) }
}
const timed = (f, timers) => ({ ...f, ...timers, started: 0 })
function assertCutoffTimerCleared(timers) {
  const cutoffs = timers.armed.filter((x) => x.name === 'stopAtPyusdB576V2AcquisitionDeadline')
  assert.equal(cutoffs.length, 1)
  assert.ok(timers.cleared.includes(cutoffs[0].id))
  assert.equal(timers.active.size, 0)
  return cutoffs[0]
}

function fixture(prepared, { drift = false, zeroStock = false, incorrectHistoricalCash = false,
  wrongHeader = false, failAt = null } = {}) {
  const discovery = JSON.parse(prepared.inputs.find((x) => x.pin.path === prepared.plan.discoveryPath).bytes)
  const codeOf = (address) => {
    const row = discovery.control.ledger.find((r) => r.request.method === 'eth_getCode' && r.request.params[0] === address)
    assert.ok(row?.rawBodyBase64)
    return JSON.parse(Buffer.from(row.rawBodyBase64, 'base64')).result
  }
  const codes = { [prepared.plan.subject.vault]: codeOf(prepared.plan.subject.vault),
    [prepared.plan.subject.asset]: codeOf(prepared.plan.subject.asset), [prepared.plan.subject.owner]: '0x' }
  const freshSource = { chainId: 1, blockNumber: '26160000', blockHash: '0x' + 'ab'.repeat(32),
    blockTime: '2026-10-10T05:00:00.000Z', finalized: true }
  const sources = [freshSource, ...prepared.plan.anchors.map((x) => x.source)]
  let elapsed = 0, calls = 0
  const requests = []
  const headerOf = (source) => ({ number: '0x' + BigInt(source.blockNumber).toString(16),
    hash: wrongHeader && calls === 6 ? '0x' + 'cd'.repeat(32) : source.blockHash,
    timestamp: '0x' + BigInt(Date.parse(source.blockTime) / 1000).toString(16) })
  const fetcher = async (_url, options) => {
    const r = JSON.parse(options.body); requests.push(structuredClone(r)); calls++
    if (calls === failAt) throw Error('local_fixture_failure')
    let result
    if (r.method === 'eth_chainId') result = '0x1'
    else if (r.method === 'eth_getBlockByNumber') {
      const source = r.params[0] === 'finalized' ? freshSource : sources.find((s) => BigInt(r.params[0]) === BigInt(s.blockNumber))
      assert.ok(source); result = headerOf(source)
    } else {
      const pin = r.params.at(-1)
      assert.equal(pin.requireCanonical, true)
      const index = sources.findIndex((s) => s.blockHash === pin.blockHash)
      assert.ok(index >= 0)
      if (r.method === 'eth_getCode') result = codes[r.params[0]]
      else {
        assert.equal(r.method, 'eth_call')
        const { functionName, args } = decodeFunctionData({ abi: PYUSD_B576_V2_ABI, data: r.params[0].data })
        let value
        if (functionName === 'asset') value = prepared.plan.subject.asset
        else if (functionName === 'decimals') value = r.params[0].to === prepared.plan.subject.asset ? 6 : 18
        else if (functionName === 'liquidityAdapter') value = drift && index === 1 ? '0x' + '11'.repeat(20) : ZERO
        else if (functionName === 'liquidityData') value = drift && index === 1 ? '0x01' : '0x'
        else if (functionName === 'totalAssets') value = 100000000000000n
        else if (functionName === 'totalSupply') value = 100000000000000000000000000n
        else if (functionName === 'balanceOf') {
          if (r.params[0].to === prepared.plan.subject.asset) {
            assert.equal(args[0].toLowerCase(), prepared.plan.subject.vault)
            value = index === 0 ? 40000000000000n : BigInt(prepared.plan.anchors[index - 1].expectedCashRaw)
            if (incorrectHistoricalCash && index === 1) value++
          } else {
            assert.equal(r.params[0].to, prepared.plan.subject.vault)
            assert.equal(args[0].toLowerCase(), prepared.plan.subject.owner)
            value = zeroStock && index === 0 ? 0n : index === 0 ? BigInt(FRESH_S) : index === 1 ? 0n : 100n
          }
        } else {
          assert.equal(functionName, 'previewRedeem')
          assert.equal(String(args[0]), zeroStock ? '0' : FRESH_S)
          value = zeroStock ? 0n : index === 0 ? 713973n : index === 1 ? 711000n : 711500n
        }
        result = nativeReply(functionName, value)
      }
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: r.id, result }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }
  return { requests, freshSource, fetcher, monotonic: () => elapsed,
    now: () => Date.parse('2026-10-10T05:10:00.000Z') + elapsed,
    pace: async (ms) => { elapsed += ms }, calls: () => calls }
}

test('closed dry plan performs no fetch and derives 98 starts under all original limits', async () => {
  const prepared = preparePyusdB576V2IdleHistory(), before = globalThis.fetch
  globalThis.fetch = () => { throw Error('zero_RPC_control') }
  try {
    const value = await runPyusdB576V2IdleHistory(['--dry-plan'])
    assert.equal(value.status, 'closed_plan_no_RPC')
    assert.equal(value.proof.derivedWorstStarts, 98)
  } finally { globalThis.fetch = before }
  const proof = pyusdB576V2StorageBudgetProof(prepared)
  assert.ok(proof.fixedSerializedBytes <= 2 * 1024 * 1024)
  assert.ok(proof.maximumLogicalBytes <= 10 * 1024 * 1024)
  assert.ok(proof.maximumAllocationExtra <= 3 * 1024 * 1024)
  assert.ok(proof.maximumFiles <= 131)
  assert.equal(PYUSD_B576_V2_POLICY.pre, 269 * 1024 * 1024)
  assert.equal(PYUSD_B576_V2_POLICY.reserve, 256 * 1024 * 1024)
  assert.equal(PYUSD_B576_V2_POLICY.deadline, 120000)
  assert.equal(PYUSD_B576_V2_POLICY.acquisitionDeadline, 115000)
  assert.equal(PYUSD_B576_V2_POLICY.retentionReserve, 5000)
  assert.equal(PYUSD_B576_V2_POLICY.stage, 12000)
  assert.equal(PYUSD_B576_V2_POLICY.timeout, 8000)
  assert.equal(PYUSD_B576_V2_POLICY.spacing, 250)
  assert.equal(PYUSD_B576_V2_POLICY.workers, 1)
  assert.equal(PYUSD_B576_V2_POLICY.retries, 0)
  assert.throws(() => assertPyusdB576V2DiskCapacity(BigInt(PYUSD_B576_V2_POLICY.pre - 1), 0, false, true))
})

test('actual original controller joins S, full Ea and C with distinct units at all three points', async () => {
  const p = preparePyusdB576V2IdleHistory(), f = fixture(p)
  const capture = await capturePyusdB576V2IdleHistory(p, origins, f)
  assert.equal(capture.completeNativeAcquisition, true)
  assert.equal(capture.qualifiedNativeJoin, true)
  assert.equal(capture.physicalStarts, 98)
  assert.equal(f.calls(), 98)
  assert.equal(capture.receipt.pendingSettlements, 0)
  assert.equal(capture.freshCurrentSharesRaw, FRESH_S)
  const [current, first, second] = capture.points
  assert.equal(current.freshCurrentFullEaAssetRaw, '713973')
  assert.equal(current.actualOwnerSharesRaw, FRESH_S)
  assert.equal(current.probeShareDecimals, 18)
  assert.equal(current.probeEaAssetDecimals, 6)
  assert.equal(current.cashAssetDecimals, 6)
  assert.equal(first.CAssetRaw, '20919825104652')
  assert.equal(second.CAssetRaw, '24375516077801')
  assert.equal(first.totalAssetsRaw, '100000000000000')
  assert.notEqual(first.totalAssetsRaw, first.CAssetRaw)
  assert.equal(first.actualHistoricalOwnerSharesRaw, '0')
  assert.equal(second.actualHistoricalOwnerSharesRaw, '100')
  for (const point of [first, second]) {
    assert.equal(point.probeSharesRaw, FRESH_S)
    assert.equal(point.conversionBasis, 'hypothetical_fixed_current_stock_conversion')
    assert.equal(point.historicalOwnedEntitlementAssetRaw, null)
    assert.equal(point.historicalOwnedEntitlementMeasured, false)
    assert.equal(point.historicalOwnerStockEqualsProbeStock, false)
    assert.equal(point.freshCurrentFullEaAssetRaw, null)
    assert.equal(point.LLTV, null)
    assert.equal(point.LLTVStatus, 'inapplicable_idle_no_adapter')
    assert.equal(point.allocation, null)
  }
  const originals = pyusdB576V2EncodedOriginals(capture)
  const restored = reconstructPyusdB576V2OriginalControl(originals.summary, originals.rows.map((x) => x.value))
  assert.equal(JSON.stringify(restored.receipt), JSON.stringify(capture.receipt))
  assert.equal(JSON.stringify(restored.requests), JSON.stringify(capture.requests))
  assert.equal(JSON.stringify(restored.settlements), JSON.stringify(capture.settlements))
  const mutated = structuredClone(originals.rows.map((x) => x.value))
  mutated[0].row.observation.rawBodyBase64 = Buffer.from('{"error":"replaced"}').toString('base64')
  assert.throws(() => reconstructPyusdB576V2OriginalControl(originals.summary, mutated))
  const badSource = structuredClone(originals.summary); badSource.source.blockHash = '0x' + 'de'.repeat(32)
  assert.throws(() => reconstructPyusdB576V2OriginalControl(badSource, originals.rows.map((x) => x.value)))
  for (const flag of ['holderExecutableExit', 'executionAuthority', 'forecastAuthority', 'forecastEligibility',
    'sourceImplementationEquivalence', 'calibrated', 'calibratedProbability', 'coveragePromotion']) assert.equal(capture[flag], false)
  assert.equal(capture.competingMRaw, null)
})

test('a configuration difference retains paired native facts and declines qualification', async () => {
  const p = preparePyusdB576V2IdleHistory(), f = fixture(p, { drift: true })
  const capture = await capturePyusdB576V2IdleHistory(p, origins, f)
  assert.equal(capture.completeNativeAcquisition, true)
  assert.equal(capture.physicalStarts, 98)
  assert.equal(capture.qualifiedNativeJoin, false)
  assert.ok(capture.points[1].qualificationReasons.includes('idle_regime_differed'))
  assert.equal(capture.points[1].liquidityData, '0x01')
  assert.equal(capture.points[1].LLTVStatus, 'unmeasured')
  assert.equal(capture.points[1].probeEaAssetRaw, '711000')
  assert.equal(capture.points[2].qualifiedNativeJoin, true)
})

test('zero fresh stock and changed historical cash cannot qualify the historical hint', async () => {
  const p = preparePyusdB576V2IdleHistory()
  for (const options of [{ zeroStock: true }, { incorrectHistoricalCash: true }]) {
    const capture = await capturePyusdB576V2IdleHistory(p, origins, fixture(p, options))
    assert.equal(capture.completeNativeAcquisition, true)
    assert.equal(capture.qualifiedNativeJoin, false)
    assert.ok(capture.points.some((x) => x.qualificationReasons.length > 0))
  }
})

test('native provider failure preserves bounded partial original control without qualification', async () => {
  const p = preparePyusdB576V2IdleHistory(), f = fixture(p, { failAt: 41 })
  const capture = await capturePyusdB576V2IdleHistory(p, origins, f)
  assert.equal(capture.completeNativeAcquisition, false)
  assert.equal(capture.qualifiedNativeJoin, false)
  assert.ok(capture.physicalStarts <= 41)
  assert.equal(capture.points.length, 1)
  const originals = pyusdB576V2EncodedOriginals(capture)
  const restored = reconstructPyusdB576V2OriginalControl(originals.summary, originals.rows.map((x) => x.value), false)
  assert.equal(JSON.stringify(restored.receipt), JSON.stringify(capture.receipt))
  assert.equal(JSON.stringify(restored.requests), JSON.stringify(capture.requests))
  assert.equal(JSON.stringify(restored.settlements), JSON.stringify(capture.settlements))
  assert.throws(() => reconstructPyusdB576V2OriginalControl(originals.summary, originals.rows.map((x) => x.value), true))
})

test('canonical source disagreement cannot qualify a native point', async () => {
  const p = preparePyusdB576V2IdleHistory(), f = fixture(p, { wrongHeader: true })
  const capture = await capturePyusdB576V2IdleHistory(p, origins, f)
  assert.equal(capture.completeNativeAcquisition, false)
  assert.equal(capture.qualifiedNativeJoin, false)
  assert.equal(capture.points.length, 0)
  assert.ok(capture.physicalStarts <= 34)
  const originals = pyusdB576V2EncodedOriginals(capture)
  assert.equal(originals.rows.length, capture.physicalStarts)
  assert.throws(() => reconstructPyusdB576V2OriginalControl(originals.summary, originals.rows.map((x) => x.value), true))
})

test('historical preview request cannot silently substitute actual historical stock', async () => {
  const p = preparePyusdB576V2IdleHistory(), f = fixture(p)
  const capture = await capturePyusdB576V2IdleHistory(p, origins, f)
  const traces = structuredClone(capture.traces)
  for (const trace of traces.filter((x) => x.key === 'anchor_0:fixed_stock_preview'))
    trace.request.params[0].data = encodeFunctionData({ abi: PYUSD_B576_V2_ABI, functionName: 'previewRedeem', args: [0n] })
  assert.throws(() => derivePyusdB576V2Point(traces, 'anchor_0', p.plan.anchors[0].source,
    FRESH_S, p.expectedRuntimes, p.plan.anchors[0].expectedCashRaw))
  const specs = pyusdB576V2PointReadPlan('anchor_0', p.plan.anchors[0].source, FRESH_S)
  assert.equal(specs.length, 16)
  assert.equal(specs.filter((x) => x.method === 'eth_getBlockByNumber').length, 2)
  assert.equal(specs.filter((x) => x.method === 'eth_getCode').length, 3)
  assert.equal(specs.filter((x) => x.method === 'eth_getLogs').length, 0)
})

test('private immutable writer roundtrips all original rows and refuses overwrite and symlink', async () => {
  const p = preparePyusdB576V2IdleHistory(), capture = await capturePyusdB576V2IdleHistory(p, origins, fixture(p))
  const directory = resolve(ROOT, 'data/research/venue-signals/pyusd-b576-idle-history-v2-unit-' + randomUUID())
  const writer = createPyusdB576V2Writer(directory, ['local-secret-never-in-fixtures-' + randomUUID()])
  try {
    for (const artifact of pyusdB576V2FixedArtifacts(p)) writer.write(artifact.name, artifact.value)
    const originals = pyusdB576V2EncodedOriginals(capture)
    for (const row of originals.rows) writer.write(row.name, row.value)
    writer.write('control-summary.json', originals.summary)
    const report = pyusdB576V2Report(capture, p); writer.write('report.json', report)
    writer.verifyRetained()
    const terminal = seal({ schema: 'pyusd_b576_idle_history_terminal_v2', reportSha256: report.sha256,
      completeNativeAcquisition: true, qualifiedNativeJoin: true, failure: null, currentSource: capture.currentSource,
      physicalStarts: capture.physicalStarts, pendingSettlements: 0, retainedRows: originals.rows.length,
      postRetentionAvailableAtUtc: '2026-10-10T05:10:30.000Z', elapsedMs: 30000,
      acquisitionDeadlineElapsedMs: 115000, retentionReserveMs: 5000,
      files: writer.refs.map(({ dev, ino, ...ref }) => ref), ...PYUSD_B576_V2_FLAGS })
    writer.write('terminal.json', terminal, true)
    const inspected = inspectPyusdB576V2RetainedHistory(directory)
    assert.equal(inspected.originalControlVerified, true)
    assert.equal(inspected.qualifiedNativeJoin, true)
    assert.equal(inspected.physicalStarts, 98)
    assert.equal(lstatSync(directory).mode & 0o777, 0o700)
    assert.equal(lstatSync(resolve(directory, 'report.json')).mode & 0o777, 0o600)
    assert.throws(() => writer.write('report.json', report))
    symlinkSync(resolve(directory, 'report.json'), resolve(directory, 'symlink.json'))
    assert.throws(() => writer.write('symlink.json', report))
  } finally {
    // This directory was created by this test's UUID above; existing captures are never selected.
    rmSync(directory, { recursive: true })
  }
})

test('absolute cutoff consumes construction delay and never receives a fresh 115-second budget', async () => {
  const p = preparePyusdB576V2IdleHistory(), f = fixture(p), timers = timerHarness(114999)
  const capture = await capturePyusdB576V2IdleHistory(p, origins, timed(f, timers))
  const cutoff = assertCutoffTimerCleared(timers)
  assert.equal(cutoff.delay, 1)
  assert.equal(cutoff.at, 115000)
  assert.equal(capture.completeNativeAcquisition, false)
  assert.equal(capture.qualifiedNativeJoin, false)
  assert.equal(capture.failure, 'pyusd_b576_v2_acquisition_deadline')
  assert.equal(capture.acquisitionExpired, true)
  assert.equal(capture.cutoffTimerCleared, true)
  assert.ok(capture.physicalStarts <= 2)
  assert.ok(capture.elapsedMs < 120000)
  const originals = pyusdB576V2EncodedOriginals(capture)
  const restored = reconstructPyusdB576V2OriginalControl(originals.summary, originals.rows.map((x) => x.value), false)
  assert.equal(JSON.stringify(restored.receipt), JSON.stringify(capture.receipt))
  assert.equal(JSON.stringify(restored.requests), JSON.stringify(capture.requests))
  assert.equal(JSON.stringify(restored.settlements), JSON.stringify(capture.settlements))
})

test('no remaining acquisition time creates zero physical starts and clears both timers', async () => {
  const p = preparePyusdB576V2IdleHistory(), timers = timerHarness(115000)
  let starts = 0
  const capture = await capturePyusdB576V2IdleHistory(p, origins, timed({
    fetcher: async () => { starts++; throw Error('late_native_start') },
  }, timers))
  assert.equal(assertCutoffTimerCleared(timers).delay, 0)
  assert.equal(starts, 0)
  assert.equal(capture.physicalStarts, 0)
  assert.equal(capture.scheduledReads, 0)
  assert.equal(capture.completeNativeAcquisition, false)
  assert.equal(capture.qualifiedNativeJoin, false)
  assert.equal(capture.failure, 'pyusd_b576_v2_acquisition_deadline')
  assert.equal(capture.receipt.pendingSettlements, 0)
  const originals = pyusdB576V2EncodedOriginals(capture)
  assert.equal(originals.rows.length, 0)
  assert.equal(reconstructPyusdB576V2OriginalControl(originals.summary, [], false).receipt.physicalStarts, 0)
})

test('pending original body is aborted at the absolute cutoff and cannot become accepted', async () => {
  const p = preparePyusdB576V2IdleHistory(), timers = timerHarness(114997)
  let bodyEntered, bodyAborted = false, bodyCancelled = false
  const entered = new Promise((resolve) => { bodyEntered = resolve })
  const stream = new ReadableStream({
    pull() { return new Promise(() => {}) },
    cancel() { bodyCancelled = true },
  })
  const originalGetReader = stream.getReader.bind(stream)
  stream.getReader = () => { const reader = originalGetReader(); bodyEntered(); return reader }
  const capturePromise = capturePyusdB576V2IdleHistory(p, origins, timed({ fetcher: async (_url, options) => {
    options.signal.addEventListener('abort', () => { bodyAborted = true }, { once: true })
    return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } })
  } }, timers))
  await entered
  timers.advance(3)
  const capture = await capturePromise
  assertCutoffTimerCleared(timers)
  assert.equal(bodyAborted, true)
  assert.equal(bodyCancelled, true)
  assert.equal(capture.physicalStarts, 1)
  assert.equal(capture.completeNativeAcquisition, false)
  assert.equal(capture.qualifiedNativeJoin, false)
  assert.equal(capture.failure, 'pyusd_b576_v2_acquisition_deadline')
  assert.equal(capture.receipt.pendingSettlements, 0)
  assert.ok(capture.receipt.ledger.every((row) => row.accepted === false && row.status === 'failed'))
  assert.ok(capture.elapsedMs < 120000)
  const originals = pyusdB576V2EncodedOriginals(capture)
  const restored = reconstructPyusdB576V2OriginalControl(originals.summary, originals.rows.map((x) => x.value), false)
  assert.equal(JSON.stringify(restored.receipt), JSON.stringify(capture.receipt))
  assert.equal(JSON.stringify(restored.settlements), JSON.stringify(capture.settlements))
})

test('complete 98-start path and native failure both clear every original and cutoff timer', async () => {
  const p = preparePyusdB576V2IdleHistory()
  for (const failAt of [null, 41]) {
    const f = fixture(p, { failAt }), timers = timerHarness()
    const capture = await capturePyusdB576V2IdleHistory(p, origins, timed(f, timers))
    assertCutoffTimerCleared(timers)
    assert.equal(capture.cutoffTimerCleared, true)
    assert.equal(capture.completeNativeAcquisition, failAt === null)
    assert.equal(capture.qualifiedNativeJoin, failAt === null)
    if (failAt === null) {
      assert.equal(capture.physicalStarts, 98)
      assert.equal(capture.points[1].probeSharesRaw, FRESH_S)
      assert.equal(capture.points[1].actualHistoricalOwnerSharesRaw, '0')
      assert.equal(capture.points[1].historicalOwnedEntitlementAssetRaw, null)
    }
  }
})

test('cutoff timer arm failure still finishes and clears the immutable controller timer', async () => {
  const p = preparePyusdB576V2IdleHistory(), timers = timerHarness(0, 2)
  const capture = await capturePyusdB576V2IdleHistory(p, origins, timed(fixture(p), timers))
  assert.equal(capture.physicalStarts, 0)
  assert.equal(capture.completeNativeAcquisition, false)
  assert.equal(capture.qualifiedNativeJoin, false)
  assert.equal(capture.cutoffTimerCleared, true)
  assert.equal(timers.armed.length, 1)
  assert.ok(timers.cleared.includes(timers.armed[0].id))
  assert.equal(timers.active.size, 0)
})

test('absolute-cutoff partial originals are retained and replayed inside the 120-second outer window', async () => {
  const p = preparePyusdB576V2IdleHistory(), timers = timerHarness(114999)
  const capture = await capturePyusdB576V2IdleHistory(p, origins, timed(fixture(p), timers))
  const directory = resolve(ROOT, 'data/research/venue-signals/pyusd-b576-idle-history-v2-unit-partial-' + randomUUID())
  const writer = createPyusdB576V2Writer(directory, ['local-never-retained-secret-' + randomUUID()], {
    clock: timers.monotonic, started: 0,
  })
  try {
    for (const artifact of pyusdB576V2FixedArtifacts(p)) writer.write(artifact.name, artifact.value)
    const originals = pyusdB576V2EncodedOriginals(capture)
    for (const row of originals.rows) writer.write(row.name, row.value)
    writer.write('control-summary.json', originals.summary)
    const report = pyusdB576V2Report(capture, p); writer.write('report.json', report)
    writer.verifyRetained()
    const terminal = seal({ schema: 'pyusd_b576_idle_history_terminal_v2', reportSha256: report.sha256,
      completeNativeAcquisition: false, qualifiedNativeJoin: false, failure: capture.failure,
      currentSource: capture.currentSource, physicalStarts: capture.physicalStarts, pendingSettlements: 0,
      retainedRows: originals.rows.length,
      postRetentionAvailableAtUtc: new Date(timers.now()).toISOString(), elapsedMs: timers.monotonic(),
      acquisitionDeadlineElapsedMs: 115000, retentionReserveMs: 5000,
      files: writer.refs.map(({ dev, ino, ...ref }) => ref), ...PYUSD_B576_V2_FLAGS })
    writer.write('terminal.json', terminal, true); writer.verifyRetained()
    const inspected = inspectPyusdB576V2RetainedHistory(directory)
    assert.equal(inspected.status, 'retained_partial_control_only')
    assert.equal(inspected.originalControlVerified, false)
    assert.equal(inspected.qualifiedNativeJoin, false)
    assert.equal(inspected.physicalStarts, capture.physicalStarts)
    assert.ok(inspected.physicalStarts > 0)
    assert.equal(inspected.report.cutoffTimerCleared, true)
    assert.ok(timers.monotonic() <= 120000)
    timers.advance(5001)
    assert.throws(() => writer.write('late.json', { noAuthority: true }))
  } finally { rmSync(directory, { recursive: true }) }
})
