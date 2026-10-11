import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FLUID_USDT_BRIDGE_JOINT_ROUTE as ROUTE,
  FLUID_USDT_BRIDGE_JOINT_VAULT as VAULT,
  FLUID_USDT_BRIDGE_JOINT_ASSET as USDT,
  issuedFluidUsdtBridgeJointHolderForecast as issue,
  fluidUsdtBridgeJointHolderForecastIssue as receipt,
  fluidUsdtBridgeJointHolderForecastFromResponse as fromResponse,
  fluidUsdtBridgeJointHolderForecastIssueFromResponse as receiptFromResponse,
  selectedFluidUsdtBridgeJointHolderForecast as select,
  selectedFluidUsdtBridgeJointHolderForecastFromIssue as fromReceipt,
  selectedFluidUsdtBridgeJointHolderForecastIssue as selectReceipt,
  fluidUsdtBridgeJointHolderForecastRenderWindow as renderWindow,
} from '../../lib/carry/fluidUsdtBridgeJointHolderForecastBinding'
import { resolveFluidUsdcBridgeJointTrustedProfile } from '../../lib/carry/fluidUsdcBridgeJointTrustedProfile'
import { FLUID_USDT_QUOTE_CONTRACTS as C } from '../../lib/carry/fluidUsdtBridgeNativeQuoteEvidenceCodec'

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const iso = (n: number) => new Date(n).toISOString()
const owner = '0x4bd98243845d823b0a79e34a873be93fb3bd7678'
const profile = resolveFluidUsdcBridgeJointTrustedProfile(
  'USDC → FluidBridgeAggregatorProxy [USDC]',
  VAULT,
  C.usdc,
)!
const anchors = profile.anchors.filter((a) => a.cashIndex >= 111 && a.cashIndex <= 118)
const runtimes = {
  ...profile.runtimeCodeHashes,
  [C.factory]: '0x4d7b8525cd5d14343fa67a732fba5b24cddba11620ca88392f4ec6c52f91fd69',
  [C.quoter]: '0x06148f47d0f41a68d3bc970030a7150e5d608cfbc28d372440a2e41ce543d92b',
  [C.pool]: '0x2ff673bacc60a73fc85c678888296c6bce3de2a9d7475c032fe7aa6e0eacba86',
  [C.usdt]: '0xb44fb4e949d0f78f87f79ee46428f23a2a5713ce6fc6e0beb3dda78c2ac1ea55',
}
const flags = {
  originalAuthority: false,
  authenticated: false,
  executionQualified: false,
  calibrated: false,
  sourceImplementationEquivalence: false,
  noUSDTCapacityAmountBand: true,
  noLinearScaling: true,
  combinedBridgeUSDTExecutionRoute: 'unassessed',
  MRaw: null,
}
function fixture(Q = '1000000', S = '1000000000000000000', H = 37) {
  // Structural clean fixtures exercise browser-local issue binding only.
  // They establish no actual native acquisition, historical ownership or execution.
  const now = Date.now(),
    asOfMs = now - 1000,
    source = {
      chainId: 1,
      blockNumber: 30000000,
      blockHash: '0x' + '1'.repeat(64),
      blockTime: iso(Math.floor((now - 300000) / 1000) * 1000),
      finalized: true,
    }
  const conversion = {
    factory: C.factory,
    quoter: C.quoter,
    pool: C.pool,
    fee: 100,
    method: 'quoteExactOutputSingle',
    inputAsset: C.usdc,
    inputDecimals: 6,
    outputAsset: C.usdt,
    outputDecimals: 6,
    fixedFinalUsdtOutputRaw: Q,
    requiredNetUsdcRaw: Q,
  }
  const base = {
    profileId: 'fluid-usdt-bridge-same-pool-quote-funding-v1',
    holderSharesRaw: S,
    shareDecimals: 18,
    fullHolderNetUsdcRaw: '100000000',
    nativeProngs: {
      bridgeFunding: '100000000',
      bankCash: '100000000',
      bankSupply: '100000000',
      bankWithdrawableUntilLimit: '100000000',
      bankResolverWithdrawable: '100000000',
    },
    withdrawalFeeBps: 5,
    paused: false,
    runtimeCodeHashes: runtimes,
    sourceClass: 'captured_identical_runtimes_only',
    historicalOwnership: false,
    conversion,
  }
  const points = anchors.map((a, n) => ({
    ...clone(base),
    source: {
      chainId: 1,
      blockNumber: String(a.source.blockNumber),
      blockHash: a.source.blockHash,
      blockTime: a.source.blockTime,
    },
    acquiredAtUtc: iso(now - 5000 + n * 10),
    availableAtUtc: iso(now - 4500),
    provenanceRef: 'controlled_unsigned_history:' + a.cashIndex,
    owner: null,
    provenanceKind: 'native_hypothetical_shares',
  }))
  const current = {
    schema: 'fluid_usdt_bridge_joint_current_evidence_v1',
    source,
    current: {
      ...clone(base),
      source: {
        chainId: 1,
        blockNumber: String(source.blockNumber),
        blockHash: source.blockHash,
        blockTime: source.blockTime,
      },
      acquiredAtUtc: iso(now - 3500),
      availableAtUtc: iso(now - 2500),
      readAtUtc: iso(now - 4000),
      provenanceRef: 'controlled_unsigned_current',
      owner,
      provenanceKind: 'native_current_full_position',
    },
    roundtripUsdtRaw: Q,
    ...flags,
  }
  const history = {
    schema: 'fluid_usdt_bridge_joint_historical_evidence_v1',
    points,
    sharesRaw: S,
    requestedFinalUsdtRaw: Q,
    acquiredAtUtc: points[7].acquiredAtUtc,
    availableAtUtc: points[7].availableAtUtc,
    owner: null,
    historicalOwnership: false,
    ...flags,
  }
  const q = {
    routeKey: ROUTE,
    destination: VAULT,
    requestedHolderAddress: owner,
    requestedRaw: Q,
    requestedAssetAddress: USDT,
    requestedAssetDecimals: 6,
    horizonHours: H,
    asOfMs,
    independentSource: clone(source),
  }
  const response = {
    fluidUsdtBridgeJointCurrentEvidence: current,
    fluidUsdtBridgeJointHistoricalEvidence: history,
    fluidUsdtBridgeJointIssuedAtUtc: iso(asOfMs),
  }
  return { now, current, history, q, response }
}
function issued(f = fixture()) {
  const model = issue(f.current, f.history, f.q)!
  assert.ok(model)
  return { f, model, receipt: receipt(model)! }
}
test('exact USDT request produces an original local unsigned model and receipt in independent USDC margin units', () => {
  const { f, model, receipt: r } = issued()
  assert.equal(model.asset, USDT)
  assert.equal(model.marginAsset, C.usdc)
  assert.equal(model.shareDecimals, 18)
  assert.equal(r.requestedRaw, '1000000')
  assert.equal(r.fullEaRaw, '100000000')
  assert.equal(r.sharesRaw, '1000000000000000000')
  assert.equal(r.requiredNetUsdcRaw, '1000000')
  assert.equal(r.assetDecimals, 6)
  assert.equal(r.marginDecimals, 6)
  assert.equal(select(model, f.q), model)
  assert.equal(fromReceipt(r, f.q), model)
  assert.equal(selectReceipt(r, f.q), r)
  assert.equal(model.originalAuthority, false)
  assert.equal(model.authenticated, false)
  assert.equal(model.executionProven, false)
  assert.equal(model.calibratedProbability, false)
  assert.equal(model.forecastValidated, false)
  assert.equal(model.coveragePromotion, false)
  assert.equal(model.MRaw, null)
  assert.equal(model.assumptions.combinedBridgeUSDTExecutionRoute, 'unassessed')
  assert.equal(model.assumptions.noUSDTCapacityAmountGrid, true)
  assert.ok(
    Object.isFrozen(model) && Object.isFrozen(r) && Object.isFrozen(model.process.input.history),
  )
})
test('H arbitrary supported future interval binds issue-relative target and applies source age once', () => {
  const f = fixture('2000000', '999000000000000000', 49),
    m = issue(f.current, f.history, f.q)!
  assert.ok(m)
  assert.equal(m.targetAtUtc, iso(f.q.asOfMs + 49 * 3600000))
  assert.equal(m.sourceAgeMs, f.q.asOfMs - Date.parse(f.current.source.blockTime))
  assert.equal(m.assumptions.sourceAgeAppliedOnce, true)
  assert.equal(m.assumptions.historicalNETIncludesCompetingUsersOnce, true)
  assert.equal(m.process.input.requestedFinalUsdtRaw, '2000000')
  assert.equal(receipt(m)!.sharesRaw, '999000000000000000')
})
test('full S and full native Ea remain independent from Q while R uses exact fixed-Q quote cost', () => {
  const f = fixture('3000000', '1000000000000000000'),
    m = issue(f.current, f.history, f.q)!
  assert.ok(m)
  assert.equal(receipt(m)!.fullEaRaw, '100000000')
  assert.equal(receipt(m)!.requestedRaw, '3000000')
  assert.equal(m.process.input.current.fullHolderNetUsdcRaw, '100000000')
  assert.equal(m.process.input.current.conversion.requiredNetUsdcRaw, '3000000')
})
test('JSON string actual response creates only local original receipt and respects real receive clock', () => {
  const f = fixture(),
    m = fromResponse(JSON.stringify(f.response), 200, f.q, Date.now())!
  assert.ok(m)
  const r = receiptFromResponse(JSON.stringify(f.response), 200, f.q, Date.now())!
  assert.ok(r)
  assert.equal(r.originalAuthority, false)
  assert.equal(r.authenticated, false)
  assert.ok(fromReceipt(r, f.q))
  assert.equal(fromReceipt(clone(r), f.q), null)
})
test('canonical503 only can retain complete independent conditional evidence', () => {
  const f = fixture(),
    v = { ...f.response, error: 'holder_exit_assessment_unavailable' }
  assert.ok(fromResponse(v, 503, f.q, Date.now()))
  assert.equal(fromResponse({ ...v, error: 'anything_else' }, 503, f.q, Date.now()), null)
  assert.equal(fromResponse(v, 500, f.q, Date.now()), null)
})
test('USDC and unrelated routes never alias the independent USDT issuer', () => {
  const f = fixture()
  for (const q of [
    { ...f.q, routeKey: 'USDC → FluidBridgeAggregatorProxy [USDC]' },
    { ...f.q, routeKey: 'Morpho v2 USDT' },
    { ...f.q, destination: C.pool },
    { ...f.q, requestedAssetAddress: C.usdc },
  ]) {
    assert.equal(issue(f.current, f.history, q), null)
  }
})
test('wrong owner, payout decimals, raw syntax, zero and uint256 overflow reject', () => {
  const f = fixture()
  for (const extra of [
    { requestedHolderAddress: '0x' + '0'.repeat(40) },
    { requestedHolderAddress: '0x' + '2'.repeat(40) },
    { requestedAssetDecimals: 18 },
    { requestedRaw: '0' },
    { requestedRaw: '1000000.0' },
    { requestedRaw: (1n << 256n).toString() },
  ])
    assert.equal(issue(f.current, f.history, { ...f.q, ...extra }), null)
})
test('horizon bounds and safe future Date arithmetic are enforced', () => {
  const f = fixture()
  for (const H of [0, -1, 1.5, 8761, Infinity])
    assert.equal(issue(f.current, f.history, { ...f.q, horizonHours: H }), null)
  assert.equal(issue(f.current, f.history, { ...f.q, asOfMs: Number.MAX_SAFE_INTEGER }), null)
})
test('native current source and independent question source must agree exactly', () => {
  const f = fixture()
  for (const change of [
    (v: any) => {
      v.source.blockHash = '0x' + '3'.repeat(64)
    },
    (v: any) => {
      v.source.blockNumber++
    },
    (v: any) => {
      v.source.finalized = false
    },
    (v: any) => {
      v.current.source.blockTime = iso(Date.parse(v.source.blockTime) + 1000)
    },
  ]) {
    const c = clone(f.current)
    change(c)
    assert.equal(issue(c, f.history, f.q), null)
  }
  assert.equal(
    issue(f.current, f.history, {
      ...f.q,
      independentSource: { ...f.q.independentSource, blockHash: '0x' + '4'.repeat(64) },
    }),
    null,
  )
})
test('all eight exact historical anchors are required without current or future ownership invention', () => {
  const f = fixture()
  for (const change of [
    (h: any) => {
      h.points.pop()
    },
    (h: any) => {
      h.points[1] = clone(h.points[0])
    },
    (h: any) => {
      h.points[0].owner = owner
    },
    (h: any) => {
      h.historicalOwnership = true
    },
    (h: any) => {
      h.points[0].provenanceKind = 'native_current_full_position'
    },
    (h: any) => {
      h.points[7].source.blockNumber = String(f.current.source.blockNumber)
    },
  ]) {
    const h = clone(f.history)
    change(h)
    assert.equal(issue(f.current, h, f.q), null)
  }
})
test('historical full-S, fixed-Q, pool/fee/runtime/source mismatch is rejected before model issue', () => {
  const f = fixture()
  for (const change of [
    (h: any) => {
      h.points[0].holderSharesRaw = '42'
    },
    (h: any) => {
      h.sharesRaw = '42'
    },
    (h: any) => {
      h.points[0].conversion.fixedFinalUsdtOutputRaw = '999999'
    },
    (h: any) => {
      h.points[0].conversion.pool = C.factory
    },
    (h: any) => {
      h.points[0].conversion.fee = 500
    },
    (h: any) => {
      h.points[0].withdrawalFeeBps = 6
    },
    (h: any) => {
      h.points[0].runtimeCodeHashes[C.usdt] = '0x' + '0'.repeat(64)
    },
    (h: any) => {
      h.points[0].source.blockHash = '0x' + '5'.repeat(64)
    },
  ]) {
    const h = clone(f.history)
    change(h)
    assert.equal(issue(f.current, h, f.q), null)
  }
})
test('current and historical units distinguish native gross prongs, net Ea and USDT requested cost', () => {
  const f = fixture()
  for (const change of [
    (c: any) => {
      c.current.shareDecimals = 6
    },
    (c: any) => {
      c.current.conversion.inputDecimals = 18
    },
    (c: any) => {
      c.current.conversion.outputDecimals = 18
    },
    (c: any) => {
      c.current.conversion.inputAsset = C.usdt
    },
    (c: any) => {
      c.current.conversion.requiredNetUsdcRaw = '0'
    },
    (c: any) => {
      c.current.nativeProngs.bankCash = (1n << 256n).toString()
    },
    (c: any) => {
      c.current.fullHolderNetUsdcRaw = '-1'
    },
  ]) {
    const c = clone(f.current)
    change(c)
    assert.equal(issue(c, f.history, f.q), null)
  }
})
test('native current roundtrip must cover Q independently of full-S entitlement or cash', () => {
  const f = fixture()
  f.current.roundtripUsdtRaw = '999999'
  assert.equal(issue(f.current, f.history, f.q), null)
  f.current.roundtripUsdtRaw = (1n << 256n).toString()
  assert.equal(issue(f.current, f.history, f.q), null)
})
test('actual historical availability after issue cannot fit as a prior donor', () => {
  const f = fixture()
  f.history.points[7].availableAtUtc = iso(f.q.asOfMs + 1)
  f.history.availableAtUtc = f.history.points[7].availableAtUtc
  assert.equal(issue(f.current, f.history, f.q), null)
})
test('aggregate historical clocks cannot be refreshed or shortened independently from frame clocks', () => {
  const f = fixture()
  for (const field of ['acquiredAtUtc', 'availableAtUtc']) {
    const h = clone(f.history)
    h[field] = iso(Date.parse(h[field]) - 1)
    assert.equal(issue(f.current, h, f.q), null)
  }
})
test('current source/read/acquisition/retention chronology must remain causal', () => {
  const f = fixture()
  for (const change of [
    (c: any) => {
      c.current.readAtUtc = iso(Date.parse(c.current.acquiredAtUtc) + 1)
    },
    (c: any) => {
      c.current.availableAtUtc = iso(Date.parse(c.current.acquiredAtUtc) - 1)
    },
    (c: any) => {
      c.current.availableAtUtc = iso(f.q.asOfMs + 1)
    },
    (c: any) => {
      c.current.readAtUtc = iso(Date.parse(c.source.blockTime) - 1)
    },
  ]) {
    const c = clone(f.current)
    change(c)
    assert.equal(issue(c, f.history, f.q), null)
  }
})
test('actual wall clock rejects stale source or issue even if caller render time appears fresh', () => {
  const f = fixture(),
    stale = iso(Math.floor((Date.now() - 1800001) / 1000) * 1000)
  f.current.source.blockTime = stale
  f.current.current.source.blockTime = stale
  f.q.independentSource.blockTime = stale
  assert.equal(issue(f.current, f.history, f.q), null)
  const a = fixture()
  assert.equal(issue(a.current, a.history, { ...a.q, asOfMs: a.now - 1800001 }), null)
})
test('receive clock cannot precede actual server issue or be invented into the future', () => {
  const f = fixture()
  assert.equal(fromResponse(f.response, 200, f.q, f.q.asOfMs - 1), null)
  assert.equal(fromResponse(f.response, 200, f.q, Date.now() + 3600000), null)
  assert.equal(
    fromResponse(
      { ...f.response, fluidUsdtBridgeJointIssuedAtUtc: iso(f.q.asOfMs + 1) },
      200,
      f.q,
      Date.now(),
    ),
    null,
  )
})
test('render clock cannot move backward before issue or forward past actual clock', () => {
  const { f, model, receipt: r } = issued()
  assert.equal(renderWindow(model, f.q.asOfMs - 1), false)
  assert.equal(fromReceipt(r, f.q, Date.now() + 3600000), null)
  assert.equal(renderWindow(clone(model), Date.now()), false)
})
test('model and receipt clones or arbitrary JSON cannot select already issued originals', () => {
  const { f, model, receipt: r } = issued()
  assert.equal(select(clone(model), f.q), null)
  assert.equal(fromReceipt(clone(r), f.q), null)
  assert.equal(selectReceipt({ ...r }, f.q), null)
  assert.equal(receipt(clone(model)), null)
  assert.equal(fromReceipt(f.response, f.q), null)
})
test('question owner/Q/H/time/source changes invalidate original receipt selection', () => {
  const { f, receipt: r } = issued()
  for (const extra of [
    { requestedHolderAddress: '0x' + '2'.repeat(40) },
    { requestedRaw: '1000001' },
    { horizonHours: 48 },
    { asOfMs: f.q.asOfMs + 1 },
    {
      independentSource: {
        ...f.q.independentSource,
        blockNumber: f.q.independentSource.blockNumber + 1,
      },
    },
  ])
    assert.equal(fromReceipt(r, { ...f.q, ...extra }), null)
})
test('post-issue transport mutations cannot change an original frozen local forecast', () => {
  const { f, model, receipt: r } = issued(),
    Ea = r.fullEaRaw
  f.current.current.fullHolderNetUsdcRaw = '1'
  f.history.points[0].nativeProngs.bankCash = '0'
  assert.equal(fromReceipt(r, f.q), model)
  assert.equal(receipt(model)!.fullEaRaw, Ea)
})
test('changing global Date.now after import cannot invent issue or keep receipt alive', () => {
  const { f, model, receipt: r } = issued(),
    before = Date.now
  try {
    Date.now = () => before() + 3600000
    assert.equal(renderWindow(model), false)
    assert.equal(fromReceipt(r, f.q), null)
    assert.equal(issue(f.current, f.history, f.q), null)
  } finally {
    Date.now = before
  }
})
test('whole forecast stays censored when forward required USDC cost becomes invalid', () => {
  const f = fixture('1000000', '1000000000000000000', 168)
  f.history.points.forEach((p, n) => {
    p.conversion.requiredNetUsdcRaw = String((8 - n) * 1000000)
  })
  const m = issue(f.current, f.history, f.q)!
  assert.ok(m)
  assert.equal(m.process.complete, false)
  assert.equal(m.process.targetSummary, null)
  assert.ok(m.counts.censored > 0)
  assert.equal(m.authenticated, false)
  assert.equal(m.MRaw, null)
})
test('claims of native authentication, final execution, calibration or known maximum flow are rejected', () => {
  const f = fixture()
  for (const [field, value] of [
    ['authenticated', true],
    ['originalAuthority', true],
    ['executionQualified', true],
    ['calibrated', true],
    ['sourceImplementationEquivalence', true],
    ['MRaw', '1000'],
    ['noLinearScaling', false],
    ['combinedBridgeUSDTExecutionRoute', 'approved'],
  ] as const) {
    const c = clone(f.current)
    ;(c as any)[field] = value
    assert.equal(issue(c, f.history, f.q), null)
    const h = clone(f.history)
    ;(h as any)[field] = value
    assert.equal(issue(f.current, h, f.q), null)
  }
})
test('public clean envelope rejects private raw proof paths and unrequested evidence fields', () => {
  const f = fixture()
  assert.equal(
    issue({ ...f.current, retention: { artifactDirectory: '/private/path' } }, f.history, f.q),
    null,
  )
  assert.equal(issue(f.current, { ...f.history, rawOriginals: [] }, f.q), null)
  assert.equal(
    issue({ ...f.current, current: { ...f.current.current, originalIssue: {} } }, f.history, f.q),
    null,
  )
})
test('bounded snapshots reject getters without invocation, cycles, sparse arrays and exotic prototypes', () => {
  let calls = 0
  const f = fixture(),
    c: any = { ...f.current }
  Object.defineProperty(c, 'current', {
    enumerable: true,
    get() {
      calls++
      throw Error('must not invoke')
    },
  })
  assert.equal(issue(c, f.history, f.q), null)
  assert.equal(calls, 0)
  const h: any = clone(f.history)
  h.points[0].loop = h
  assert.equal(issue(f.current, h, f.q), null)
  const a: any = clone(f.history)
  delete a.points[0]
  assert.equal(issue(f.current, a, f.q), null)
  const b: any = clone(f.current)
  Object.setPrototypeOf(b, null)
  assert.equal(issue(b, f.history, f.q), null)
})
test('shared plain aliases are cloned safely and never treated as cyclic authorization', () => {
  const f = fixture()
  f.history.points.forEach((p) => {
    p.runtimeCodeHashes = f.current.current.runtimeCodeHashes
  })
  assert.ok(issue(f.current, f.history, f.q))
})
test('actual JSON duplicate keys reject rather than selecting the last forged request or timestamp', () => {
  const f = fixture(),
    s = JSON.stringify(f.response)
  const dup = s.replace(
    '"fluidUsdtBridgeJointIssuedAtUtc":',
    '"fluidUsdtBridgeJointIssuedAtUtc":"2000-01-01T00:00:00.000Z","fluidUsdtBridgeJointIssuedAtUtc":',
  )
  assert.equal(fromResponse(dup, 200, f.q, Date.now()), null)
})
test('response getter and unexpected scalar callbacks cannot run', () => {
  const f = fixture(),
    v: any = { ...f.response }
  let calls = 0
  Object.defineProperty(v, 'fluidUsdtBridgeJointCurrentEvidence', {
    enumerable: true,
    get() {
      calls++
      return f.current
    },
  })
  assert.equal(fromResponse(v, 200, f.q, Date.now()), null)
  assert.equal(calls, 0)
  assert.equal(issue(f.current, f.history, { ...f.q, asOfMs: (() => f.q.asOfMs) as any }), null)
})

test('object transport UTF8 byte cap is independent from UTF16 snapshot size', () => {
  const f = fixture(),
    v = { ...f.response, unusedMetadata: '€'.repeat(3 * 1024 * 1024) }
  assert.equal(fromResponse(v, 200, f.q, Date.now()), null)
})
