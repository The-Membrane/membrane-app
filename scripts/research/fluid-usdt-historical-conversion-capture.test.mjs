import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeFunctionData, encodeFunctionResult } from 'viem'
import {
  ABI,
  CONTRACTS,
  HOSTS,
  POLICY,
  prepareFluidUsdtConversionPlan,
  validateFluidUsdtPlan,
  captureFluidUsdtConversionHistory,
  replayFluidUsdtConversionHistory,
  writeFluidUsdtCapture,
} from './fluid-usdt-historical-conversion-capture.mjs'
const hash = (s) => createHash('sha256').update(s).digest('hex'),
  reseal = (r) => {
    const { sha256, ...b } = r
    return { ...b, sha256: hash(JSON.stringify(b)) }
  },
  clone = (v) => structuredClone(v)
const POOL = '0x3416cf6c708da44db2624d63ea0aaef7113527c6' // fixture identity only, always discovered from factory response
const origins = HOSTS.map((host, i) => ({ host, url: 'https://' + host + '/private-key-' + i }))
function fixture() {
  const plan = prepareFluidUsdtConversionPlan(),
    headers = plan.anchors.slice(0, 2).map((a) => a.source),
    final = {
      chainId: 1,
      blockNumber: '26140000',
      blockHash: '0x' + '4'.repeat(64),
      blockTime: '2026-10-07T10:00:00.000Z',
    },
    all = [...headers, final],
    byHash = new Map(all.map((h) => [h.blockHash, h]))
  let count = 0
  const fetcher = async (url, options) => {
    count++
    assert.equal(options.redirect, 'error')
    const q = JSON.parse(options.body)
    let result
    if (q.method === 'eth_chainId') result = '0x1'
    else if (q.method === 'eth_getBlockByNumber') {
      const h =
        q.params[0] === 'finalized'
          ? final
          : all.find((h) => '0x' + BigInt(h.blockNumber).toString(16) === q.params[0])
      assert.ok(h)
      result = {
        number: '0x' + BigInt(h.blockNumber).toString(16),
        hash: h.blockHash,
        timestamp: '0x' + BigInt(Date.parse(h.blockTime) / 1000).toString(16),
      }
    } else {
      assert.deepEqual(Object.keys(q.params[1]), ['blockHash', 'requireCanonical'])
      assert.equal(q.params[1].requireCanonical, true)
      assert.ok(byHash.has(q.params[1].blockHash))
      if (q.method === 'eth_getCode') result = '0x60006000'
      else {
        const { functionName, args } = decodeFunctionData({ abi: ABI, data: q.params[0].data })
        const values = {
          getPool: POOL,
          factory: CONTRACTS.factory,
          token0: CONTRACTS.usdc,
          token1: CONTRACTS.usdt,
          fee: 100,
          liquidity: 1000000000n,
          decimals: 6,
        }
        let value = values[functionName]
        if (functionName === 'quoteExactInputSingle') {
          assert.equal(args[0].tokenIn.toLowerCase(), CONTRACTS.usdc)
          assert.equal(args[0].tokenOut.toLowerCase(), CONTRACTS.usdt)
          assert.ok([10145n, 10000000000n].includes(args[0].amountIn))
          assert.equal(args[0].fee, 100)
          assert.equal(args[0].sqrtPriceLimitX96, 0n)
          value = [
            (args[0].amountIn === 10145n ? 10144n : 9999000000n) +
              BigInt(all.findIndex((h) => h.blockHash === q.params[1].blockHash)),
            0n,
            0,
            50000n,
          ]
        }
        result = encodeFunctionResult({ abi: ABI, functionName, result: value })
      }
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: q.id, result }))
  }
  return { plan, fetcher, count: () => count }
}
let receipt, plan
await test('saved SHA-linked issues give common exact USDC simulation and fixed bounded plan', () => {
  plan = prepareFluidUsdtConversionPlan()
  assert.equal(validateFluidUsdtPlan(plan).expectedStarts, 94)
  assert.equal(
    validateFluidUsdtPlan(prepareFluidUsdtConversionPlan({ includeCurrent: false })).expectedStarts,
    64,
  )
  assert.equal(plan.usdcInputRaw, '10145')
  assert.equal(plan.originalUsdtRequestedRaw, null)
  assert.ok(Object.isFrozen(plan.anchors[0].source))
  const bad = clone(plan)
  bad.usdcInputRaw = '10146'
  assert.throws(() => validateFluidUsdtPlan(bad), /fixed_plan/)
  assert.throws(
    () => prepareFluidUsdtConversionPlan({ includeCurrent: ['true'] }),
    /current_option/,
  )
})
await test('actual mocked transport captures94 canonical pinned calls and replays exact-size conditional quotes', async () => {
  const f = fixture()
  receipt = await captureFluidUsdtConversionHistory(f.plan, origins, { fetcher: f.fetcher })
  assert.equal(f.count(), 94)
  const out = replayFluidUsdtConversionHistory(receipt, plan)
  assert.equal(out.history.points.length, 2)
  assert.deepEqual(out.history.elapsedSeconds, [0, 3072])
  assert.equal(out.history.points[0].usdtQuotedRaw, '10144')
  assert.equal(out.history.points[1].usdtQuotedRaw, '10145')
  assert.equal(out.current.usdtQuotedRaw, '10146')
  assert.equal(out.current.protocolQuote.usdtQuotedRaw, '9999000002')
  assert.equal(out.protocolInput.holderBound, false)
  assert.equal(out.holderCapacity, false)
  assert.equal(out.minedPayout, false)
  assert.equal(out.originalUsdtRequestedRaw, null)
  assert.ok(!JSON.stringify(receipt).includes('private-key'))
  assert.ok(Object.isFrozen(out.history.points[0]))
  assert.ok(receipt.traces.every((t) => t.workSettled))
})
await test('request owner, amount, pool, pin and trace order forgery cannot replay', () => {
  for (const mutate of [
    (r) => (r.plan.usdcInputRaw = '20290'),
    (r) => (r.traces.find((t) => t.key === 'usdtQuotedRaw').request.params[0].data = '0x'),
    (r) => (r.traces.find((t) => t.key === 'token0').request.params[1].requireCanonical = false),
    (r) => (r.traces.find((t) => t.key === 'code_pool').request.params[0] = CONTRACTS.quoter),
    (r) => (r.traces[3].request.id = 1),
    (r) => (r.policy.maxRequests = 160),
  ]) {
    const r = clone(receipt)
    mutate(r)
    assert.throws(() => replayFluidUsdtConversionHistory(reseal(r), plan))
  }
})
await test('pool native identity mismatch remains unavailable rather than paid evidence', () => {
  const r = clone(receipt)
  for (const t of r.traces.filter((t) => t.key === 'usdtDecimals'))
    t.response.result = encodeFunctionResult({ abi: ABI, functionName: 'decimals', result: 18 })
  const out = replayFluidUsdtConversionHistory(reseal(r), plan)
  assert.ok(out.history.points.every((p) => p.status === 'incomplete'))
  assert.equal(out.current.usdtQuotedRaw, null)
})
await test('equal-height finalized header conflict cannot establish current or historical quote agreement', () => {
  const r = clone(receipt)
  r.traces.find((t) => t.origin === HOSTS[0] && t.key === 'finalized').response.result.hash =
    '0x' + '7'.repeat(64)
  assert.throws(() => replayFluidUsdtConversionHistory(reseal(r), plan), /derived_sources/)
  const historical = clone(receipt)
  for (const t of historical.traces.filter((t) => t.key === 'finalized')) {
    const first = plan.anchors[0].source
    t.response.result = {
      number: '0x' + BigInt(first.blockNumber).toString(16),
      hash: '0x' + '6'.repeat(64),
      timestamp: '0x' + BigInt(Date.parse(first.blockTime) / 1000).toString(16),
    }
  }
  assert.throws(() => replayFluidUsdtConversionHistory(reseal(historical), plan))
})
await test('replay enforces individual response, spacing, RPC and overall clock budgets', () => {
  for (const mutate of [
    (r) =>
      (r.traces[0].completedAt = new Date(Date.parse(r.traces[0].startedAt) + 8251).toISOString()),
    (r) => (r.capturedAt = new Date(Date.parse(r.startedAt) + 60251).toISOString()),
    (r) =>
      (r.traces.find((t) => t.key === 'code_factory').response.result = '0x' + '00'.repeat(131073)),
    (r) => (r.traces.find((t) => t.key === 'header_before').startedAt = r.startedAt),
    (r) => (r.physicalStarts = 95),
    (r) => (r.traces[2].startedAt = r.traces[0].startedAt),
  ]) {
    const r = clone(receipt)
    mutate(r)
    assert.throws(() => replayFluidUsdtConversionHistory(reseal(r), plan))
  }
})
await test('failure receipts remain sanitized and missing quote does not turn into zero or payout', () => {
  const r = clone(receipt),
    t = r.traces.find((t) => t.key === 'usdtQuotedRaw')
  t.response = { error: { code: -32000 } }
  const out = replayFluidUsdtConversionHistory(reseal(r), plan)
  assert.equal(out.history.points[0].usdtQuotedRaw, null)
  assert.equal(out.history.points[0].status, 'incomplete')
  assert.equal(out.history.points[0].protocolQuote.usdtQuotedRaw, '9999000000')
  const other = clone(receipt)
  other.traces.find((t) => t.key === 'protocolUsdtQuotedRaw').response = { error: { code: -32000 } }
  const independently = replayFluidUsdtConversionHistory(reseal(other), plan)
  assert.equal(independently.history.points[0].usdtQuotedRaw, '10144')
  assert.equal(independently.history.points[0].protocolQuote.usdtQuotedRaw, null)
})
await test('exclusive bounded writer keeps1GiB reserve and preserves existing files; foreign URLs reject', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fluid-usdt-writer-'))
  try {
    const file = join(dir, 'proof.json'),
      statfs = () => ({ bavail: 2 * POLICY.reserveBytes, bsize: 1 })
    writeFluidUsdtCapture(file, receipt, { statfs })
    assert.equal(JSON.parse(readFileSync(file)).sha256, receipt.sha256)
    const before = readFileSync(file)
    assert.throws(() => writeFluidUsdtCapture(file, receipt, { statfs }), /EEXIST/)
    assert.deepEqual(readFileSync(file), before)
    assert.throws(
      () =>
        writeFluidUsdtCapture(join(dir, 'low.json'), receipt, {
          statfs: () => ({ bavail: POLICY.reserveBytes, bsize: 1 }),
        }),
      /disk_reserve/,
    )
    assert.throws(
      () =>
        writeFluidUsdtCapture(
          join(dir, 'url.json'),
          { rpc: 'https://private.example/key' },
          { statfs },
        ),
      /artifact_url/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
await test('unsettled aborted transport closes capture before further physical starts', async () => {
  let starts = 0
  const timed = await captureFluidUsdtConversionHistory(plan, origins, {
    rpcTimeoutMs: 1,
    fetcher: async () => {
      starts++
      return new Promise(() => {})
    },
  })
  assert.equal(starts, 2)
  assert.equal(timed.captureClosedReason, 'rpc_abort_unsettled')
  assert.ok(timed.traces.every((t) => t.transport === 'timeout' && !t.workSettled))
  const replay = replayFluidUsdtConversionHistory(timed, plan)
  assert.ok(replay.history.points.every((p) => p.status === 'incomplete'))
  assert.equal(replay.current.status, 'incomplete')
})
