import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { decodeFunctionData, encodeFunctionResult } from 'viem'
import {
  ABI,
  HOSTS,
  POLICY,
  SUBJECT,
  CONFIGURED,
  ALLOCATION_IDS,
  prepareMorphoV2AdapterCapacityPlan,
  captureMorphoV2AdapterCapacity,
  replayMorphoV2AdapterCapacity,
  writeMorphoV2AdapterCapacityCapture,
  morphoConfiguredCapacityMath,
} from './morpho-v2-adapter-capacity-capture.mjs'
const plan = prepareMorphoV2AdapterCapacityPlan(),
  sha = (v) => createHash('sha256').update(v).digest('hex'),
  seal = (v) => {
    const { sha256, ...body } = v
    return { ...body, sha256: sha(JSON.stringify(body)) }
  },
  os = () => HOSTS.map((host) => ({ host, url: 'https://' + host + '/fixture-secret' })),
  W = 10n ** 18n
const pilot = JSON.parse(
    readFileSync('data/research/venue-signals/morpho-v2-adapter-pilot-2026-10-07.json'),
  ),
  codes = Object.fromEntries(
    pilot.traces
      .filter((t) => t.anchor === 0 && t.origin === HOSTS[0] && t.key.startsWith('code_'))
      .map((t) => [t.key, t.response.result]),
  ),
  data = pilot.traces.find((t) => t.key === 'liquidityData').response.result
const current = {
    chainId: 1,
    blockNumber: '26150000',
    blockHash: '0x' + 'a'.repeat(64),
    blockTime: new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z'),
  },
  header = (s) => ({
    number: '0x' + BigInt(s.blockNumber).toString(16),
    hash: s.blockHash,
    timestamp: '0x' + BigInt(Date.parse(s.blockTime) / 1000).toString(16),
  })
const market = [10000000n, 10000000000000n, 4000000n, 4000000000000n, 1n, 0n],
  internal = 5000000000000n
function fixture(onStart) {
  let count = 0
  const urls = []
  return {
    urls,
    count: () => count,
    fetcher: async (url, options) => {
      urls.push(url)
      count++
      onStart?.(count)
      assert.equal(options.redirect, 'error')
      const p = JSON.parse(options.body)
      let result
      if (p.method === 'eth_chainId') result = '0x1'
      else if (p.method === 'eth_getBlockByNumber') {
        const source =
          p.params[0] === 'finalized'
            ? current
            : [...plan.anchors.slice(0, 2).map((a) => a.source), current].find(
                (s) => BigInt(s.blockNumber) === BigInt(p.params[0]),
              )
        result = header(source)
      } else if (p.method === 'eth_getCode')
        result =
          p.params[0] === SUBJECT.destination
            ? codes.code_vault
            : p.params[0] === SUBJECT.asset
              ? codes.code_asset
              : p.params[0] === CONFIGURED.adapter
                ? codes.code_adapter
                : '0x6000'
      else {
        const d = decodeFunctionData({ abi: ABI, data: p.params[0].data })
        const fn = d.functionName
        let value
        if (fn === 'liquidityData') {
          result = data
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: p.id, result }))
        }
        if (fn === 'asset') value = SUBJECT.asset
        else if (fn === 'decimals') value = p.params[0].to === SUBJECT.asset ? 6 : 18
        else if (fn === 'balanceOf')
          value = d.args[0].toLowerCase() === SUBJECT.destination ? 0n : 6000000n
        else if (fn === 'liquidityAdapter') value = CONFIGURED.adapter
        else if (fn === 'isAdapter') value = true
        else if (fn === 'parentVault') value = SUBJECT.destination
        else if (fn === 'morpho') value = CONFIGURED.morpho
        else if (fn === 'adaptiveCurveIrm') value = CONFIGURED.irm
        else if (fn === 'supplyShares') value = internal
        else if (fn === 'expectedSupplyAssets') value = 5000000n
        else if (fn === 'idToMarketParams') value = CONFIGURED.params
        else if (fn === 'market') value = market
        else if (fn === 'position') value = [internal + 1000000n, 0n, 0n]
        else if (fn === 'feeRecipient') value = '0x' + '1'.repeat(40)
        else if (fn === 'rateAtTarget') value = 0n
        else if (fn === 'borrowRateView') value = 0n
        else if (fn === 'allocation') value = 1n
        else if (fn === 'allowance') value = 2n ** 256n - 1n
        else throw Error(fn)
        result = encodeFunctionResult({ abi: ABI, functionName: fn, result: value })
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: p.id, result }))
    },
  }
}
let saved
async function base() {
  if (!saved) {
    const f = fixture()
    saved = await captureMorphoV2AdapterCapacity(plan, os(), { fetcher: f.fetcher })
    assert.equal(f.count(), 190)
  }
  return structuredClone(saved)
}
test('single190/90s budget captures exact own headers+19 configured native prongs, not valuations', async () => {
  const r = await base(),
    x = replayMorphoV2AdapterCapacity(r, plan)
  assert.equal(POLICY.maxRequests, 190)
  assert.equal(POLICY.deadlineMs, 90000)
  assert.equal(POLICY.maxInFlightPerHost, 1)
  assert.deepEqual(x.history.elapsedSeconds, [0, 86400])
  for (const p of [...x.history.points, x.current]) {
    assert.equal(p.status, 'two_origin_conditional_configured_adapter_prongs')
    assert.equal(p.facts.internalPositionAssetsRaw, '5000000')
    assert.equal(p.facts.configuredAdapterPullableRaw, '5000000')
    assert.equal(p.facts.conditionalProtocolCapacityRaw, '5000000')
    assert.equal(p.facts.holderGateEligibility, 'unknown_owner_and_receiver')
    assert.equal(p.facts.tokenRestrictions, 'unknown')
    assert.equal(p.totalExitCapacity, null)
    assert.equal(p.facts.sourceImplementationEquivalence, false)
  }
  assert.equal(JSON.stringify(r).includes('fixture-secret'), false)
})
test('rounding, interest, fee shares and supplied-share donation are exact and native', () => {
  const at = 100n,
    m = [100n, 100000000n, 50n, 50000000n, 99n, W / 10n],
    v = {
      market: m,
      at,
      borrowRate: W / 10n,
      internalShares: 50000000n,
      actualShares: 50000000n,
      blueCash: 1000n,
      allowance: 1000n,
      idleCash: 3n,
      enrolled: true,
      allocations: [1n, 1n, 1n],
    },
    x = morphoConfiguredCapacityMath(v)
  assert.equal(x.interestRaw, '5')
  assert.equal(x.accruedSupplyAssetsRaw, '105')
  assert.equal(x.accruedBorrowAssetsRaw, '55')
  assert.equal(x.feeSharesRaw, '0')
  const feeCase = morphoConfiguredCapacityMath({
    ...v,
    market: [100n, 100000000n, 50n, 50000000n, 99n, W / 5n],
  })
  assert.equal(feeCase.feeSharesRaw, '961904')
  assert.equal(feeCase.internalPositionAssetsRaw, '51')
  assert.equal(x.internalPositionAssetsRaw, '52')
  assert.equal(x.configuredAdapterPullableRaw, '50')
  assert.equal(x.conditionalProtocolCapacityRaw, '53')
  assert.deepEqual(morphoConfiguredCapacityMath({ ...v, actualShares: 99000000n }), x)
  assert.equal(
    morphoConfiguredCapacityMath({ ...v, enrolled: false }).configuredAdapterPullableRaw,
    '0',
  )
  assert.equal(
    morphoConfiguredCapacityMath({ ...v, allocations: [1n, 0n, 1n] }).configuredAdapterPullableRaw,
    '0',
  )
  assert.equal(
    morphoConfiguredCapacityMath({ ...v, allowance: 2n }).configuredAdapterPullableRaw,
    '2',
  )
  assert.throws(
    () => morphoConfiguredCapacityMath({ ...v, internalShares: v.actualShares + 1n }),
    /internal_vs_actual/,
  )
  assert.throws(
    () => morphoConfiguredCapacityMath({ ...v, idleCash: 2n ** 256n - 1n }),
    /math_uint/,
  )
  assert.throws(
    () => morphoConfiguredCapacityMath({ ...v, borrowRate: 2n ** 256n - 1n }),
    /math_uint/,
  )
})
test('allocation-qualified bound matches exact ceil-burn cap changes and small brute force', () => {
  const v = {
    market: [10000000n, 10000000000000n, 4000000n, 4000000000000n, 1n, 0n],
    at: 100n,
    borrowRate: 0n,
    internalShares: internal,
    actualShares: internal,
    blueCash: 6000000n,
    allowance: 2n ** 256n - 1n,
    idleCash: 0n,
    enrolled: true,
    allocations: [1n, 1n, 5000000n],
  }
  const counter = morphoConfiguredCapacityMath(v)
  assert.equal(counter.configuredAdapterLiquidityBoundRaw, '5000000')
  assert.equal(counter.conditionalAllocationQualifiedPullableRaw, '1')
  assert.equal(counter.configuredAdapterPullableRaw, '1')
  for (let S = 10n; S <= 20n; S++)
    for (let cap = 1n; cap <= 6n; cap++) {
      const T = 10000000n,
        i = 5000000n,
        old = (i * (S + 1n)) / (T + 1000000n),
        caps = [cap, cap + 1n, old || 1n]
      const x = morphoConfiguredCapacityMath({
        ...v,
        market: [S, T, 0n, 0n, 99n, 0n],
        internalShares: i,
        actualShares: i,
        blueCash: S,
        allocations: caps,
      })
      const bound = BigInt(x.configuredAdapterLiquidityBoundRaw)
      let best = 0n,
        failed = false
      for (let amount = 1n; amount <= bound; amount++) {
        const n = amount * (T + 1000000n),
          burned = (n + S) / (S + 1n)
        const remaining = ((i - burned) * (S - amount + 1n)) / (T - burned + 1000000n)
        const change = remaining - caps[2],
          valid = caps.every((a) => a + change >= 0n)
        assert.equal(
          failed && valid,
          false,
          'allocation feasibility is a prefix under exact rounding',
        )
        if (valid) best = amount
        else failed = true
      }
      assert.equal(BigInt(x.conditionalAllocationQualifiedPullableRaw), best)
    }
  assert.throws(
    () => morphoConfiguredCapacityMath({ ...v, allocations: [(1n << 255n) - 1n, 1n, 1n] }),
    /allocation_int_overflow/,
  )
})
test('wrong IRM/native/configuration/expected rounding and two-origin disagreement remain gaps', async () => {
  for (const [key, value, fn] of [
    ['adapterIrm', '0x' + '1'.repeat(40), 'adaptiveCurveIrm'],
    ['adapterAsset', '0x' + '1'.repeat(40), 'asset'],
    ['adapterExpectedAssets', 5000001n, 'expectedSupplyAssets'],
    ['code_adapter', '0x6000', null],
  ]) {
    const r = await base(),
      t = r.traces.find((t) => t.anchor === 0 && t.key === key)
    t.response.result = fn
      ? encodeFunctionResult({ abi: ABI, functionName: fn, result: value })
      : value
    const x = replayMorphoV2AdapterCapacity(seal(r), plan)
    assert.equal(x.history.points[0].facts, null)
    assert.equal(x.history.points[0].totalExitCapacity, null)
  }
})
test('ABI, EIP1898, primitive response and global abort closure are strict', async () => {
  for (const mutate of [
    (r) =>
      (r.traces.find((t) => t.key === 'borrowRate').request.params[1].requireCanonical = false),
    (r) => (r.traces.find((t) => t.key === 'market').response.result = ['0x']),
    (r) => (r.physicalStarts = 191),
    (r) => {
      const t = r.traces.find((t) => t.key === 'adapterSupplyShares')
      t.response = null
      t.transport = 'timeout'
      t.workSettled = false
      r.captureClosedReason = 'rpc_abort_unsettled'
    },
  ]) {
    const r = await base()
    mutate(r)
    assert.throws(() => replayMorphoV2AdapterCapacity(seal(r), plan), /morpho_v2_capacity/)
  }
})
test('resealed dynamic calls cannot precede setup or the raw dependencies used to form them', async () => {
  for (const [anchor, parentKey, childKey] of [
    [0, 'market', 'borrowRate'],
    [0, 'liquidityAdapter', 'adapterSupplyShares'],
    [-1, 'chain', 'finalized'],
  ]) {
    const r = await base()
    for (const host of HOSTS) {
      const parent = r.traces.find(
        (t) => t.origin === host && t.anchor === anchor && t.key === parentKey,
      )
      const child = r.traces.find(
        (t) => t.origin === host && t.anchor === anchor && t.key === childKey,
      )
      // Keep physical slots, clocks, IDs, spacing and all raw call values intact.
      // Move the dependent call into its prerequisite's earlier slot on both origins.
      const a = {
        key: parent.key,
        method: parent.request.method,
        params: parent.request.params,
        result: parent.response.result,
      }
      const b = {
        key: child.key,
        method: child.request.method,
        params: child.request.params,
        result: child.response.result,
      }
      for (const [t, v] of [
        [parent, b],
        [child, a],
      ]) {
        t.key = v.key
        t.request.method = v.method
        t.request.params = v.params
        t.response.result = v.result
      }
    }
    assert.throws(() => replayMorphoV2AdapterCapacity(seal(r), plan), /dependency_chronology/)
  }
})
test('original resealed counter cannot place finalized setup after all getters', async () => {
  const r = await base(),
    start = Date.parse(r.startedAt)
  r.traces = HOSTS.flatMap((host) => {
    const xs = r.traces.filter((t) => t.origin === host)
    const reordered = [...xs.filter((t) => t.anchor !== -1), ...xs.filter((t) => t.anchor === -1)]
    reordered.forEach((t, i) => {
      t.startedAt = new Date(start + 100 + i * 60).toISOString()
      t.completedAt = new Date(start + 101 + i * 60).toISOString()
    })
    return reordered
  })
  r.capturedAt = new Date(start + 10000).toISOString()
  assert.throws(() => replayMorphoV2AdapterCapacity(seal(r), plan), /dependency_chronology/)
})
test('validated origin primitives survive caller mutation across all190starts', async () => {
  const origins = os(),
    f = fixture((n) => {
      if (n === 1) {
        origins[0].url = 'https://unapproved.example/key'
        origins[0].host = 'unapproved.example'
        origins.splice(0, 2)
      }
    }),
    r = await captureMorphoV2AdapterCapacity(plan, origins, { fetcher: f.fetcher })
  assert.equal(f.count(), 190)
  assert.equal(
    f.urls.some((u) => new URL(u).hostname === 'unapproved.example'),
    false,
  )
  assert.equal(
    replayMorphoV2AdapterCapacity(r, plan).current.status,
    'two_origin_conditional_configured_adapter_prongs',
  )
})
test('uncooperative transport closes globally; source forks cannot acquire downstream prongs', async () => {
  let starts = 0
  const r = await captureMorphoV2AdapterCapacity(plan, os(), {
    rpcTimeoutMs: 1,
    fetcher: async () => {
      starts++
      return new Promise(() => {})
    },
  })
  assert.equal(starts, 2)
  assert.equal(r.captureClosedReason, 'rpc_abort_unsettled')
  assert.equal(replayMorphoV2AdapterCapacity(r, plan).current.facts, null)
  const b = await base()
  b.traces.find((t) => t.key === 'finalized').response.result.hash = '0x' + 'b'.repeat(64)
  assert.throws(() => replayMorphoV2AdapterCapacity(seal(b), plan), /sources/)
})
test('append-only output cannot leak diagnosticURLs or breach output-subtracted reserve', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'morpho-capacity-'))
  try {
    const out = join(dir, 'one.json'),
      r = await base(),
      statfs = () => ({ bavail: POLICY.reserveBytes + POLICY.maxArtifactBytes, bsize: 1 })
    writeMorphoV2AdapterCapacityCapture(out, r, { statfs })
    assert.throws(() => writeMorphoV2AdapterCapacityCapture(out, r, { statfs }), /EEXIST/)
    assert.throws(
      () =>
        writeMorphoV2AdapterCapacityCapture(join(dir, 'low'), r, {
          statfs: () => ({ bavail: POLICY.reserveBytes, bsize: 1 }),
        }),
      /disk_reserve/,
    )
    assert.throws(
      () =>
        writeMorphoV2AdapterCapacityCapture(
          join(dir, 'url'),
          { url: 'https://provider/key' },
          { statfs },
        ),
      /artifact_url/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
