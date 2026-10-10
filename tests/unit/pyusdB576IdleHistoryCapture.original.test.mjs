/** Original physical controller tests. All responses are local fixtures; no RPC is acquired. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, lstatSync, rmSync, symlinkSync } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeFunctionData, encodeFunctionResult, encodeFunctionData } from 'viem'
import {
  PYUSD_B576_ABI, PYUSD_B576_POLICY, PYUSD_B576_FLAGS, preparePyusdB576IdleHistory,
  pyusdB576PointReadPlan, pyusdB576StorageBudgetProof, capturePyusdB576IdleHistory,
  derivePyusdB576Point, pyusdB576EncodedOriginals, reconstructPyusdB576OriginalControl,
  assertPyusdB576DiskCapacity, pyusdB576FixedArtifacts, createPyusdB576Writer,
  pyusdB576Report, inspectPyusdB576RetainedHistory, runPyusdB576IdleHistory,
} from '../../scripts/research/pyusd-b576-idle-history-capture.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url)), ZERO = '0x' + '0'.repeat(40)
const sha = (x) => createHash('sha256').update(x).digest('hex')
const seal = (body) => ({ ...body, sha256: sha(JSON.stringify(body)) })
const hosts = ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com']
const origins = hosts.map((host) => ({ host, url: 'https://' + host + '/local-pyusd-test-fixture' }))
const FRESH_S = '352805058661206444'
const nativeReply = (name, value) => encodeFunctionResult({ abi: PYUSD_B576_ABI, functionName: name, result: value })

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
        const { functionName, args } = decodeFunctionData({ abi: PYUSD_B576_ABI, data: r.params[0].data })
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
  const prepared = preparePyusdB576IdleHistory(), before = globalThis.fetch
  globalThis.fetch = () => { throw Error('zero_RPC_control') }
  try {
    const value = await runPyusdB576IdleHistory(['--dry-plan'])
    assert.equal(value.status, 'closed_plan_no_RPC')
    assert.equal(value.proof.derivedWorstStarts, 98)
  } finally { globalThis.fetch = before }
  const proof = pyusdB576StorageBudgetProof(prepared)
  assert.ok(proof.fixedSerializedBytes <= 2 * 1024 * 1024)
  assert.ok(proof.maximumLogicalBytes <= 10 * 1024 * 1024)
  assert.ok(proof.maximumAllocationExtra <= 3 * 1024 * 1024)
  assert.ok(proof.maximumFiles <= 131)
  assert.equal(PYUSD_B576_POLICY.pre, 269 * 1024 * 1024)
  assert.equal(PYUSD_B576_POLICY.reserve, 256 * 1024 * 1024)
  assert.equal(PYUSD_B576_POLICY.deadline, 120000)
  assert.equal(PYUSD_B576_POLICY.stage, 12000)
  assert.equal(PYUSD_B576_POLICY.timeout, 8000)
  assert.equal(PYUSD_B576_POLICY.spacing, 250)
  assert.equal(PYUSD_B576_POLICY.workers, 1)
  assert.equal(PYUSD_B576_POLICY.retries, 0)
  assert.throws(() => assertPyusdB576DiskCapacity(BigInt(PYUSD_B576_POLICY.pre - 1), 0, false, true))
})

test('actual original controller joins S, full Ea and C with distinct units at all three points', async () => {
  const p = preparePyusdB576IdleHistory(), f = fixture(p)
  const capture = await capturePyusdB576IdleHistory(p, origins, f)
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
  const originals = pyusdB576EncodedOriginals(capture)
  const restored = reconstructPyusdB576OriginalControl(originals.summary, originals.rows.map((x) => x.value))
  assert.equal(JSON.stringify(restored.receipt), JSON.stringify(capture.receipt))
  assert.equal(JSON.stringify(restored.requests), JSON.stringify(capture.requests))
  assert.equal(JSON.stringify(restored.settlements), JSON.stringify(capture.settlements))
  const mutated = structuredClone(originals.rows.map((x) => x.value))
  mutated[0].row.observation.rawBodyBase64 = Buffer.from('{"error":"replaced"}').toString('base64')
  assert.throws(() => reconstructPyusdB576OriginalControl(originals.summary, mutated))
  const badSource = structuredClone(originals.summary); badSource.source.blockHash = '0x' + 'de'.repeat(32)
  assert.throws(() => reconstructPyusdB576OriginalControl(badSource, originals.rows.map((x) => x.value)))
  for (const flag of ['holderExecutableExit', 'executionAuthority', 'forecastAuthority', 'forecastEligibility',
    'sourceImplementationEquivalence', 'calibrated', 'calibratedProbability', 'coveragePromotion']) assert.equal(capture[flag], false)
  assert.equal(capture.competingMRaw, null)
})

test('a configuration difference retains paired native facts and declines qualification', async () => {
  const p = preparePyusdB576IdleHistory(), f = fixture(p, { drift: true })
  const capture = await capturePyusdB576IdleHistory(p, origins, f)
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
  const p = preparePyusdB576IdleHistory()
  for (const options of [{ zeroStock: true }, { incorrectHistoricalCash: true }]) {
    const capture = await capturePyusdB576IdleHistory(p, origins, fixture(p, options))
    assert.equal(capture.completeNativeAcquisition, true)
    assert.equal(capture.qualifiedNativeJoin, false)
    assert.ok(capture.points.some((x) => x.qualificationReasons.length > 0))
  }
})

test('native provider failure preserves bounded partial original control without qualification', async () => {
  const p = preparePyusdB576IdleHistory(), f = fixture(p, { failAt: 41 })
  const capture = await capturePyusdB576IdleHistory(p, origins, f)
  assert.equal(capture.completeNativeAcquisition, false)
  assert.equal(capture.qualifiedNativeJoin, false)
  assert.ok(capture.physicalStarts <= 41)
  assert.equal(capture.points.length, 1)
  const originals = pyusdB576EncodedOriginals(capture)
  const restored = reconstructPyusdB576OriginalControl(originals.summary, originals.rows.map((x) => x.value), false)
  assert.equal(JSON.stringify(restored.receipt), JSON.stringify(capture.receipt))
  assert.equal(JSON.stringify(restored.requests), JSON.stringify(capture.requests))
  assert.equal(JSON.stringify(restored.settlements), JSON.stringify(capture.settlements))
  assert.throws(() => reconstructPyusdB576OriginalControl(originals.summary, originals.rows.map((x) => x.value), true))
})

test('canonical source disagreement cannot qualify a native point', async () => {
  const p = preparePyusdB576IdleHistory(), f = fixture(p, { wrongHeader: true })
  const capture = await capturePyusdB576IdleHistory(p, origins, f)
  assert.equal(capture.completeNativeAcquisition, false)
  assert.equal(capture.qualifiedNativeJoin, false)
  assert.equal(capture.points.length, 0)
  assert.ok(capture.physicalStarts <= 34)
  const originals = pyusdB576EncodedOriginals(capture)
  assert.equal(originals.rows.length, capture.physicalStarts)
  assert.throws(() => reconstructPyusdB576OriginalControl(originals.summary, originals.rows.map((x) => x.value), true))
})

test('historical preview request cannot silently substitute actual historical stock', async () => {
  const p = preparePyusdB576IdleHistory(), f = fixture(p)
  const capture = await capturePyusdB576IdleHistory(p, origins, f)
  const traces = structuredClone(capture.traces)
  for (const trace of traces.filter((x) => x.key === 'anchor_0:fixed_stock_preview'))
    trace.request.params[0].data = encodeFunctionData({ abi: PYUSD_B576_ABI, functionName: 'previewRedeem', args: [0n] })
  assert.throws(() => derivePyusdB576Point(traces, 'anchor_0', p.plan.anchors[0].source,
    FRESH_S, p.expectedRuntimes, p.plan.anchors[0].expectedCashRaw))
  const specs = pyusdB576PointReadPlan('anchor_0', p.plan.anchors[0].source, FRESH_S)
  assert.equal(specs.length, 16)
  assert.equal(specs.filter((x) => x.method === 'eth_getBlockByNumber').length, 2)
  assert.equal(specs.filter((x) => x.method === 'eth_getCode').length, 3)
  assert.equal(specs.filter((x) => x.method === 'eth_getLogs').length, 0)
})

test('private immutable writer roundtrips all original rows and refuses overwrite and symlink', async () => {
  const p = preparePyusdB576IdleHistory(), capture = await capturePyusdB576IdleHistory(p, origins, fixture(p))
  const directory = resolve(ROOT, 'data/research/venue-signals/pyusd-b576-idle-history-unit-' + randomUUID())
  const writer = createPyusdB576Writer(directory, ['local-secret-never-in-fixtures-' + randomUUID()])
  try {
    for (const artifact of pyusdB576FixedArtifacts(p)) writer.write(artifact.name, artifact.value)
    const originals = pyusdB576EncodedOriginals(capture)
    for (const row of originals.rows) writer.write(row.name, row.value)
    writer.write('control-summary.json', originals.summary)
    const report = pyusdB576Report(capture, p); writer.write('report.json', report)
    writer.verifyRetained()
    const terminal = seal({ schema: 'pyusd_b576_idle_history_terminal_v1', reportSha256: report.sha256,
      completeNativeAcquisition: true, qualifiedNativeJoin: true, failure: null, currentSource: capture.currentSource,
      physicalStarts: capture.physicalStarts, pendingSettlements: 0, retainedRows: originals.rows.length,
      postRetentionAvailableAtUtc: '2026-10-10T05:10:30.000Z', elapsedMs: 30000,
      files: writer.refs.map(({ dev, ino, ...ref }) => ref), ...PYUSD_B576_FLAGS })
    writer.write('terminal.json', terminal, true)
    const inspected = inspectPyusdB576RetainedHistory(directory)
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
