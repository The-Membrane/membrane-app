import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  buildFluidUsdtBridgeJointLiveTimeProcess as build,
  FLUID_USDT_BRIDGE as B,
  FLUID_USDT_INPUT as U,
  FLUID_USDT_OUTPUT as T,
  FLUID_USDT_FACTORY as F,
  FLUID_USDT_QUOTER as Q,
  FLUID_USDT_POOL as P,
  FLUID_USDT_PRONGS as PRONGS,
  FLUID_USDT_RUNTIME_ADDRESSES as ADDRESSES,
  type FluidUsdtBridgeJointFrame as Frame,
  type FluidUsdtBridgeJointLiveTimeInput as Input,
} from '../../lib/carry/fluidUsdtBridgeJointLiveTimeProcess'

const MAX = (1n << 256n) - 1n
const BASE = Date.parse('2026-10-09T12:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
const hashes = () => Object.fromEntries(ADDRESSES.map((a) => [a, '0x' + '1'.repeat(64)]))
// All synthetic facts are controlled unsigned research inputs, never native-original authority.
function frame(time: number, block: number, cost = '1000'): Frame {
  return {
    source: {
      chainId: 1,
      blockNumber: String(block),
      blockHash: '0x' + String(block).padStart(64, '0'),
      blockTime: iso(time),
    },
    acquiredAtUtc: iso(BASE),
    availableAtUtc: iso(BASE),
    provenanceRef: 'controlled-' + block,
    profileId: 'controlled-research',
    holderSharesRaw: '1000000000000000000',
    shareDecimals: 18,
    fullHolderNetUsdcRaw: '1500',
    nativeProngs: Object.fromEntries(PRONGS.map((k) => [k, '2000'])) as Frame['nativeProngs'],
    withdrawalFeeBps: 5,
    paused: false,
    runtimeCodeHashes: hashes(),
    sourceClass: 'captured_identical_runtimes_only',
    owner: null,
    historicalOwnership: false,
    provenanceKind: 'native_hypothetical_shares',
    conversion: {
      factory: F,
      quoter: Q,
      pool: P,
      fee: 100,
      method: 'quoteExactOutputSingle',
      inputAsset: U,
      inputDecimals: 6,
      outputAsset: T,
      outputDecimals: 6,
      fixedFinalUsdtOutputRaw: '10145',
      requiredNetUsdcRaw: cost,
    },
  }
}
function fixture(ageMs = 0): Input {
  return {
    routeKey: 'USDT → FluidBridgeAggregatorProxy [USDC]',
    destination: B,
    inputAsset: U,
    inputDecimals: 6,
    outputAsset: T,
    outputDecimals: 6,
    owner: null,
    requestedFinalUsdtRaw: '10145',
    profileId: 'controlled-research',
    issueAtUtc: iso(BASE + ageMs),
    knowledgeCutoffUtc: iso(BASE),
    horizonHours: 3,
    maxHistoricalGapSeconds: 91800,
    current: { ...frame(BASE, 200), readAtUtc: iso(BASE) },
    history: [frame(BASE - 7200000, 100), frame(BASE - 3600000, 101, '1200')],
  }
}
function result(i = fixture()) {
  const r = build(i)
  assert.ok(r)
  return r
}
function scenario(i = fixture()) {
  const r = result(i)
  assert.equal(r.process.scenarios.length, 1)
  return r.process.scenarios[0]
}

test('dynamic exact-output cost breaches despite unchanged funding and entitlement', () => {
  const r = result(),
    s = r.process.scenarios[0]
  assert.equal(r.sourceMeasurement.marginUsdcRaw, '500')
  assert.equal(s.targetMarginUsdcRaw, '-100')
  assert.equal(s.points.at(-1)!.requiredNetUsdcRaw, '1600')
  assert.deepEqual(s.firstLoss, {
    after: iso(BASE + 7200000),
    by: iso(BASE + 10800000),
    afterIssueSeconds: 7200,
    byIssueSeconds: 10800,
  })
  assert.equal(r.process.targetSummary!.marginBand.p10Raw, '-100')
})
test('all seven signed donor channels remain one correlated edge', () => {
  const i = fixture()
  i.history[1].nativeProngs.bankCash = '1900'
  i.history[1].fullHolderNetUsdcRaw = '1400'
  const s = scenario(i)
  assert.equal(s.donor.jointDeltaRaw.bankCash, '-100')
  assert.equal(s.donor.jointDeltaRaw.fullEa, '-100')
  assert.equal(s.donor.jointDeltaRaw.requiredUsdc, '200')
  assert.equal(s.targetMarginUsdcRaw, '-400')
})
test('native withdrawal fee occurs once and full native net Ea caps funding', () => {
  const r = result()
  assert.equal(r.sourceMeasurement.fundingNetUsdcRaw, '1999')
  assert.equal(r.sourceMeasurement.fullNetUsdcEaRaw, '1500')
  assert.equal(r.sourceMeasurement.clippedNetUsdcRaw, '1500')
  assert.equal(r.sourceMeasurement.marginUsdcRaw, '500')
})
test('weakest native prong is never averaged', () => {
  const i = fixture()
  i.current.nativeProngs.bankCash = '1000'
  assert.equal(result(i).sourceMeasurement.marginUsdcRaw, '-1')
})
test('Q is USDT, S independent; native quote change must be supplied explicitly', () => {
  const i = fixture()
  i.requestedFinalUsdtRaw = '20000'
  assert.equal(build(i), null)
  for (const f of [i.current, ...i.history]) {
    f.conversion.fixedFinalUsdtOutputRaw = '20000'
    f.conversion.requiredNetUsdcRaw = '1300'
  }
  const r = result(i)
  assert.equal(r.sharesRaw, '1000000000000000000')
  assert.equal(r.sourceMeasurement.fullNetUsdcEaRaw, '1500')
  assert.equal(r.sourceMeasurement.marginUsdcRaw, '200')
  assert.equal(r.requestedAsset, T)
  assert.equal(r.marginAsset, U)
})
test('same full-S mismatch excludes native donor, zero S rejects', () => {
  const i = fixture()
  i.history[0].holderSharesRaw = '2'
  assert.equal(result(i).counts.excluded, 1)
  assert.equal(result(i).process.targetSummary, null)
  i.current.holderSharesRaw = '0'
  assert.equal(build(i), null)
})
test('fixed Q mismatch cannot donate another question cost', () => {
  const i = fixture()
  i.history[0].conversion.fixedFinalUsdtOutputRaw = '1'
  assert.equal(result(i).counts.excluded, 1)
})
test('fee, runtime, profile and pause drift each exclude the edge', () => {
  for (const mutate of [
    (f: Frame) => {
      f.withdrawalFeeBps = 6
    },
    (f: Frame) => {
      f.runtimeCodeHashes[B] = '0x' + '2'.repeat(64)
    },
    (f: Frame) => {
      f.profileId = 'different'
    },
    (f: Frame) => {
      f.paused = true
    },
  ]) {
    const i = fixture()
    mutate(i.history[0])
    assert.equal(result(i).counts.excluded, 1)
  }
})
test('a excluded middle point cannot invent adjacency across a gap', () => {
  const i = fixture()
  const x = frame(BASE - 5400000, 1001, '1100')
  i.history[0].source.blockNumber = '1000'
  i.history[1].source.blockNumber = '1002'
  i.current.source.blockNumber = '2000'
  x.holderSharesRaw = '3'
  i.history.splice(1, 0, x)
  const r = result(i)
  assert.equal(r.counts.excluded, 2)
  assert.equal(r.process.scenarios.length, 0)
})
test('strictly prior block/time and 91800-second maximum gap apply', () => {
  const i = fixture()
  i.history[1].source.blockNumber = '200'
  assert.equal(result(i).counts.excluded, 1)
  const j = fixture()
  j.history[0].source.blockTime = iso(BASE - 100000000)
  assert.equal(result(j).counts.excluded, 1)
})
test('native units, runtime roster, pool and positive Q are mandatory', () => {
  for (const mutate of [
    (i: Input) => {
      i.current.shareDecimals = 6 as 18
    },
    (i: Input) => {
      delete i.current.runtimeCodeHashes[B]
    },
    (i: Input) => {
      i.current.conversion.pool = B as typeof P
    },
    (i: Input) => {
      i.requestedFinalUsdtRaw = '0'
    },
  ]) {
    const i = fixture()
    mutate(i)
    assert.equal(build(i), null)
  }
})
test('historical ownership and arbitrary native-original claims are not admitted', () => {
  const i = fixture()
  i.history[0].owner = '0x' + '3'.repeat(40)
  assert.equal(build(i), null)
  const j = fixture()
  Object.assign(j.current, { originalIssue: {} })
  assert.equal(build(j), null)
})
test('fractional source age is added once to issue-relative horizon', () => {
  const i = fixture(1234),
    s = scenario(i)
  const required = 1000n + (200n * BigInt(10800000 + 1234)) / 3600000n
  assert.equal(s.targetMarginUsdcRaw, String(1500n - required))
  assert.equal(s.points[0].elapsedFromIssueSeconds, 0)
  assert.equal(s.points[0].elapsedFromSourceSeconds, 1.234)
  assert.equal(result(i).sourceAgeMs, 1234)
})
test('pre-issue loss is left censored at issue, never future duration from source', () => {
  const i = fixture(1200000)
  i.current.conversion.requiredNetUsdcRaw = '1400'
  i.history[1].conversion.requiredNetUsdcRaw = '1600'
  const r = result(i),
    s = r.process.scenarios[0]
  assert.equal(r.sourceMeasurement.marginUsdcRaw, '100')
  assert.equal(s.issueMarginUsdcRaw, '-100')
  assert.equal(s.firstLoss!.after, null)
  assert.equal(s.firstLoss!.byIssueSeconds, 0)
  assert.equal(s.sampledShortfalls![0].leftCensored, true)
  assert.ok(s.points.every((p) => Date.parse(p.atUtc) >= Date.parse(i.issueAtUtc)))
})
test('recovery exactly at issue is not reported as future recovery', () => {
  const i = fixture(1200000)
  i.current.conversion.requiredNetUsdcRaw = '1600'
  i.history[1].conversion.requiredNetUsdcRaw = '700'
  i.horizonHours = 1
  const r = result(i),
    s = r.process.scenarios[0]
  assert.equal(r.sourceMeasurement.marginUsdcRaw, '-100')
  assert.equal(s.issueMarginUsdcRaw, '0')
  assert.equal(s.firstRecovery, null)
  assert.deepEqual(s.sampledShortfalls, [])
})
test('future recovery brackets are sampled and issue-relative', () => {
  const i = fixture()
  i.current.conversion.requiredNetUsdcRaw = '2000'
  i.history[1].conversion.requiredNetUsdcRaw = '500'
  i.horizonHours = 2
  const s = scenario(i)
  assert.equal(s.firstRecovery!.byIssueSeconds, 3600)
  assert.equal(s.firstRecovery!.afterIssueSeconds, 0)
  assert.equal(s.targetMarginUsdcRaw, '500')
})
test('zero or negative projected exact-output cost censors every numeric band', () => {
  const i = fixture()
  i.history[1].conversion.requiredNetUsdcRaw = '1'
  i.horizonHours = 2
  const r = result(i)
  assert.equal(r.counts.censored, 1)
  assert.equal(r.process.targetSummary, null)
  assert.equal(r.process.modeledIssueMarginBand, null)
  assert.equal(r.process.scenarios[0].targetMarginUsdcRaw, null)
})
test('negative cash paths remain censored rather than floored into complete forecasts', () => {
  const i = fixture()
  i.history[1].nativeProngs.bankCash = '0'
  const r = result(i)
  assert.equal(r.counts.censored, 1)
  assert.equal(r.process.targetSummary, null)
  assert.equal(r.process.scenarios[0].sampledShortfalls, null)
})
test('projection and fee intermediate overflow fail closed', () => {
  const i = fixture()
  i.history[0].nativeProngs.bridgeFunding = '0'
  i.history[1].nativeProngs.bridgeFunding = String(MAX)
  assert.equal(result(i).counts.censored, 1)
  const j = fixture()
  for (const p of PRONGS) j.current.nativeProngs[p] = String(MAX)
  assert.equal(build(j), null)
})
test('mixed usable and censored donor edges suppress complete target band', () => {
  const i = fixture()
  i.history.push(frame(BASE - 1800000, 102, '2000'))
  i.history[2].nativeProngs.bankCash = '0'
  const r = result(i)
  assert.equal(r.counts.usable, 1)
  assert.equal(r.counts.censored, 1)
  assert.equal(r.process.targetSummary, null)
})
test('availability includes conversion acquisition and cannot be backdated', () => {
  const i = fixture()
  i.current.acquiredAtUtc = iso(BASE + 1000)
  i.current.availableAtUtc = iso(BASE + 2000)
  assert.equal(build(i), null)
  i.issueAtUtc = iso(BASE + 3000)
  i.knowledgeCutoffUtc = iso(BASE + 2000)
  assert.ok(build(i))
  i.knowledgeCutoffUtc = iso(BASE)
  assert.equal(build(i), null)
})
test('future/stale current source and reverse read/acquisition clocks reject', () => {
  for (const age of [-1, 1800001]) assert.equal(build(fixture(age)), null)
  const i = fixture()
  i.current.readAtUtc = iso(BASE + 1)
  assert.equal(build(i), null)
})
test('input snapshot ignores no getters, rejects sparse/cycle/oversized keys and isolates caller', () => {
  let called = 0
  const i = fixture()
  Object.defineProperty(i, 'owner', {
    enumerable: true,
    get() {
      called++
      return null
    },
  })
  assert.equal(build(i), null)
  assert.equal(called, 0)
  const sparse = fixture()
  delete sparse.history[0]
  assert.equal(build(sparse), null)
  const cyclic = fixture()
  Object.assign(cyclic, { extra: cyclic })
  assert.equal(build(cyclic), null)
  const large = fixture()
  Object.assign(large, { ['x'.repeat(300000)]: 1 })
  assert.equal(build(large), null)
  const original = fixture(),
    r = result(original)
  original.current.conversion.requiredNetUsdcRaw = '9000'
  assert.equal(r.process.input.current.conversion.requiredNetUsdcRaw, '1000')
  assert.ok(Object.isFrozen(r.process.input.current.conversion))
})
test('public result contains no generic fixed-cost headroom or USDT capacity band', () => {
  const r = result(),
    s = r.process.scenarios[0]
  for (const key of [
    'targetHeadroomRaw',
    'sampledTroughHeadroomRaw',
    'availableRaw',
    'capacityRaw',
    'headroomRaw',
  ])
    assert.equal(Object.hasOwn(s, key), false)
  assert.equal(Object.hasOwn(s.points[0], 'headroomRaw'), false)
  assert.equal(r.process.targetSummary!.unit, 'USDC_margin_supporting_fixed_USDT_Q')
  assert.equal(r.MRaw, null)
  assert.equal(r.originalAuthority, false)
  assert.equal(r.authenticated, false)
  assert.equal(r.executionProven, false)
  assert.equal(r.calibratedProbability, false)
  assert.equal(r.assumptions.finalSwapExecution, 'unassessed')
  assert.equal(r.assumptions.combinedBridgeUSDTExecutionRoute, 'unassessed')
})
test('saved ten native joins retain their actual later clocks; controlled current is not native authority', () => {
  const dir = resolve('data/research/venue-signals')
  const saved = JSON.parse(
    readFileSync(
      resolve(
        dir,
        'fluid-usdt-native-conversion-extension-2026-10-09T04-41-15.376Z-c422e99c-0485-4706-90a0-975df770ffee/replayed-conversion-points.json',
      ),
      'utf8',
    ),
  )
  const plan = JSON.parse(
    readFileSync(resolve(dir, 'fluid-usdt-native-conversion-extension-v1.plan.json'), 'utf8'),
  )
  const i = fixture()
  i.history = saved.points.map((p: any, n: number) => {
    const f = frame(
      Date.parse(p.source.blockTime),
      Number(p.source.blockNumber),
      p.requiredNetUsdcForResearchQRaw,
    )
    assert.deepEqual(p.source, plan.anchors[n].source)
    assert.deepEqual(p.nativeProngs, plan.anchors[n].nativeProngs)
    f.source = p.source
    f.holderSharesRaw = p.fullSharesRaw
    f.fullHolderNetUsdcRaw = p.fullNetUsdcEaRaw
    f.nativeProngs = p.nativeProngs
    f.withdrawalFeeBps = p.withdrawalFeeBps
    f.acquiredAtUtc = p.acquiredAtUtc
    // This unsigned fixture declares a conservative availability after the recorded post-retention result.
    f.availableAtUtc = '2026-10-09T04:43:00.000Z'
    f.provenanceRef = 'saved-native-join-' + n
    f.runtimeCodeHashes = { ...plan.anchors[n].runtimeCodeHashes, ...p.runtimeCodeHashes }
    return f
  })
  i.current = {
    ...structuredClone(i.history[0]),
    source: {
      chainId: 1,
      blockNumber: '26153000',
      blockHash: '0x' + '9'.repeat(64),
      blockTime: '2026-10-09T05:00:00.000Z',
    },
    readAtUtc: '2026-10-09T05:00:00.000Z',
    acquiredAtUtc: '2026-10-09T05:00:00.000Z',
    availableAtUtc: '2026-10-09T05:00:00.000Z',
    provenanceRef: 'CONTROLLED-current-no-native-original-authority',
  }
  i.issueAtUtc = '2026-10-09T05:01:00.000Z'
  i.knowledgeCutoffUtc = i.current.availableAtUtc
  i.horizonHours = 1
  const r = result(i)
  assert.equal(r.counts.attempted, 9)
  assert.equal(r.originalAuthority, false)
  assert.equal(r.process.input.history[0].acquiredAtUtc, saved.points[0].acquiredAtUtc)
  const old = structuredClone(i)
  old.issueAtUtc = '2026-10-02T12:00:00.000Z'
  assert.equal(build(old), null)
})

test('two unequal donors retain a nondegenerate uncalibrated order-statistic band', () => {
  const i = fixture()
  i.horizonHours = 1
  i.history[1].conversion.requiredNetUsdcRaw = '1100'
  i.history.push(frame(BASE - 1800000, 102, '1200'))
  const r = result(i),
    b = r.process.targetSummary!.marginBand
  assert.equal(r.counts.usable, 2)
  assert.equal(b.p10Raw, '300')
  assert.equal(b.p90Raw, '400')
  assert.equal(b.method, 'empirical_lower_floor_upper_ceil_order_statistics_uncalibrated')
  assert.equal(r.calibratedProbability, false)
})
