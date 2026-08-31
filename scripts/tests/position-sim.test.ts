/**
 * Tests for lib/position-sim: the Membrane engine maths, the comparison engine, the
 * scenario loader's symbol mapping, and the adapters' pure parsing helpers.
 *
 * The adapters' network calls are not exercised here — those need a live RPC. What IS
 * exercised is every piece of decoding/scaling arithmetic between the raw uint256 and
 * the rendered number, which is where an adapter bug would actually hide.
 *
 * Run: pnpm test:unit
 */

import assert from 'node:assert'
import {
  BORROW_LTV_GAP,
  CURE_WINDOW_SECONDS,
  MAX_LTV_HARD_CAP,
  applyRecall,
  fullRepayValue,
  membraneBorrowLtv,
  membraneMaxLtv,
  membraneRepayValue,
  weightedMembraneLine,
} from '../../lib/position-sim/membrane'
import { MAX_LIQ_FEE, measuredRepayFraction, runComparison } from '../../lib/position-sim/compare'
import { HELD_AT_ONE, SYMBOL_TO_SERIES, buildPricePath, priceAt } from '../../lib/position-sim/scenario'
import { demoPosition } from '../../lib/position-sim/demo'
import { readUrlState, writeUrlState } from '../../lib/position-sim/share'
import { decimalsFromScale, mulDivUp, ratio, unwrap, optional, UnsupportedError } from '../../lib/position-sim/adapters/types'
import { toNumber, parseAddress } from '../../lib/position-sim/rpc'
import type { Oct10Manifest, Oct10Series } from '../../lib/position-sim/scenario'

let passed = 0
let failed = 0
function test(name: string, fn: () => void) {
  try {
    fn()
    passed++
  } catch (e) {
    failed++
    console.error(`  FAIL  ${name}\n        ${(e as Error).message.split('\n')[0]}`)
  }
}
const close = (a: number, b: number, msg: string, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) < eps, `${msg}: got ${a}, want ${b}`)

console.log('lib/position-sim')

// ====================================================== membrane constants
test('the real contract constants are what the code uses', () => {
  close(BORROW_LTV_GAP, 0.03, 'BORROW_LTV_GAP — lib/Constants.sol:30')
  close(MAX_LTV_HARD_CAP, 0.9, 'MAX_LTV_HARD_CAP — lib/Constants.sol:23')
  assert.strictEqual(CURE_WINDOW_SECONDS, 28_800, 'cure window — liquidation-engine/src/contract.rs:52')
  close(MAX_LIQ_FEE, 0.1, 'MAX_LIQ_FEE — lib/Constants.sol:57')
})

test('the borrow cap sits exactly 3pp under the liquidation line', () => {
  close(membraneBorrowLtv(0.8), 0.77, '80% line')
  close(membraneBorrowLtv(0.02), 0, 'clamped at zero')
})

test('no modelled LTV may exceed the hard cap', () => {
  for (const [sym, v] of Object.entries({ WETH: 0.8, USDC: 0.87 })) {
    assert.ok(membraneMaxLtv(sym)! <= MAX_LTV_HARD_CAP, `${sym} within cap (${v})`)
  }
  assert.strictEqual(membraneMaxLtv('NOT_A_TOKEN'), null, 'unknown assets return null, never a default')
})

// ================================================= the partial-repay formula
test('membraneRepayValue implements the Solidity form, not the Rust one', () => {
  // Solidity: repay = loan × (L − B) / (L × (1 − B))      LiquidationEngine.sol:2222-2238
  // Rust:     repay = loan × (L − B) /  L                 cdp/src/liquidations.rs:474-483
  const loan = 100_000
  const coll = 125_000
  const B = 0.77
  const L = loan / coll // 0.8
  const got = membraneRepayValue(loan, coll, B)
  const solidity = (loan * (L - B)) / (L * (1 - B))
  const rust = (loan * (L - B)) / L
  close(got, solidity, 'matches Solidity')
  assert.ok(Math.abs(got - rust) > 1, 'and is measurably different from the Rust form')
  assert.ok(got > rust, 'the /(1-B) factor repays MORE, which is the point of the fix')
})

test('the partial repay actually restores the borrow cap', () => {
  // Repaying `r` removes `r` of debt AND `r` of collateral (it leaves with the repay).
  const loan = 100_000
  const coll = 125_000
  const B = 0.77
  const r = membraneRepayValue(loan, coll, B)
  close((loan - r) / (coll - r), B, 'post-liquidation LTV lands on the cap')
})

test('a partial repay is always less than the whole loan', () => {
  for (const L of [0.78, 0.8, 0.85, 0.9, 0.99]) {
    const coll = 100_000
    const loan = L * coll
    const r = membraneRepayValue(loan, coll, 0.77)
    assert.ok(r > 0 && r <= loan, `L=${L}: repay ${r} must be within (0, ${loan}]`)
    assert.ok(r < loan, `L=${L}: a partial liquidation must never take the whole loan`)
  }
})

test('membraneRepayValue is zero under the cap and total when underwater', () => {
  close(membraneRepayValue(70_000, 100_000, 0.77), 0, 'under the cap')
  close(membraneRepayValue(110_000, 100_000, 0.77), 100_000, 'underwater -> all collateral value')
  close(membraneRepayValue(0, 100_000, 0.77), 0, 'no debt')
  close(membraneRepayValue(50_000, 0, 0.77), 50_000, 'no collateral -> whole debt')
})

test('a full-repayment engine takes far more than a partial one', () => {
  const loan = 100_000
  const coll = 125_000
  const partial = membraneRepayValue(loan, coll, 0.77)
  const full = fullRepayValue(loan, 1)
  const closeFactor = fullRepayValue(loan, 0.5)
  assert.ok(full > partial, 'full repayment takes more')
  assert.strictEqual(full, loan, 'a 100% close factor takes the whole loan')
  close(closeFactor, 50_000, 'a 50% close factor')
})

// ============================================================ venue recall
test('recall covers the call before any collateral is touched', () => {
  const venue = { recallRate: 0.9, fastRate: 0.9, deployedUsd: 100_000, provenance: {} as never }
  const r = applyRecall(50_000, venue)
  close(r.recalledUsd, 50_000, 'the venue answers the whole call')
  close(r.shortfallUsd, 0, 'nothing reaches collateral')
  assert.ok(r.cured, 'fast capital covered it')
})

test('a shallow venue leaves a shortfall for collateral', () => {
  const venue = { recallRate: 0.3, fastRate: 0, deployedUsd: 100_000, provenance: {} as never }
  const r = applyRecall(50_000, venue)
  close(r.recalledUsd, 30_000, 'only the recallable share returns')
  close(r.shortfallUsd, 20_000, 'the rest is a shortfall')
  assert.ok(!r.cured, 'no fast capital -> no cure')
})

test('the recall rate is the dominant variable', () => {
  const call = 50_000
  const deep = applyRecall(call, { recallRate: 0.95, fastRate: 0.95, deployedUsd: 100_000, provenance: {} as never })
  const shallow = applyRecall(call, { recallRate: 0.12, fastRate: 0, deployedUsd: 100_000, provenance: {} as never })
  assert.ok(shallow.shortfallUsd > deep.shortfallUsd, 'a shallower venue pushes more onto collateral')
  close(deep.shortfallUsd, 0, 'a deep venue absorbs it entirely')
})

test('no venue means no recall — never a silent default', () => {
  const r = applyRecall(50_000, null)
  close(r.recalledUsd, 0, 'nothing recalled')
  close(r.shortfallUsd, 50_000, 'the whole call hits collateral')
  assert.ok(!r.cured)
})

test('weightedMembraneLine reports unknown assets instead of guessing', () => {
  const w = weightedMembraneLine([
    { symbol: 'WETH', valueUsd: 100_000 },
    { symbol: 'MYSTERY', valueUsd: 100_000 },
  ])
  assert.deepStrictEqual(w.unknown, ['MYSTERY'], 'the unknown asset is named')
  close(w.maxLtv, 0.8, 'the line uses only the assets we have a value for')
  close(w.borrowLtv, 0.77, 'cap follows the 3pp gap')
})

// ========================================================== scenario loader
test('collateral assets are priced off the ORACLE series, not spot', () => {
  assert.strictEqual(SYMBOL_TO_SERIES.WETH, 'ethOracle', 'liquidations fire off the oracle')
  assert.strictEqual(SYMBOL_TO_SERIES.WBTC, 'btcOracle')
  assert.strictEqual(SYMBOL_TO_SERIES.USDe, 'usdeSpot', 'USDe has no mainstream oracle column here')
})

test('USDe is not held at $1 — it is the one that moved', () => {
  assert.ok(!HELD_AT_ONE.includes('USDe'), 'USDe must use its measured series')
  assert.ok(HELD_AT_ONE.includes('USDC') && HELD_AT_ONE.includes('USDT'))
})

const fakeSeries: Oct10Series = {
  startTs: 1_760_054_400,
  stepSeconds: 60,
  count: 5,
  columns: {
    ethOracle: [4000, 3800, null, 3000, 3200],
    btcOracle: [120000, 118000, 110000, 100000, 105000],
  },
  carried: {},
}
const fakeManifest: Oct10Manifest = {
  name: 'test', windowStartUtc: '2025-10-10T00:00:00Z', windowEndUtc: '2025-10-10T00:04:00Z',
  resolution: '1 minute', sources: [], caveats: [],
}

test('buildPricePath names the symbols it cannot price', () => {
  const { path, unpriced } = buildPricePath(fakeSeries, fakeManifest, ['WETH', 'USDC', 'PEPE'])
  assert.deepStrictEqual(unpriced, ['PEPE'], 'unpriceable symbols are reported, not faked')
  assert.deepStrictEqual(path.series.USDC, [1, 1, 1, 1, 1], 'stables held at one')
  assert.strictEqual(path.series.WETH?.[0], 4000)
  assert.strictEqual(path.series.PEPE, undefined, 'no invented series')
})

test('priceAt carries the last real print across a gap but never invents one', () => {
  const { path } = buildPricePath(fakeSeries, fakeManifest, ['WETH'])
  assert.strictEqual(priceAt(path, 'WETH', 1), 3800)
  assert.strictEqual(priceAt(path, 'WETH', 2), 3800, 'the gap carries the previous round')
  assert.strictEqual(priceAt(path, 'WETH', 3), 3000)
  assert.strictEqual(priceAt(path, 'NOPE', 0), null, 'an unknown symbol has no price')
})

// ======================================================= comparison engine
function crashPath() {
  // A ~45% drawdown and a partial recovery, applied as a MULTIPLIER to each asset's
  // real opening price so minute 0 reproduces the demo position's stored values
  // exactly. That keeps the balance-sheet assertions exact rather than approximate.
  const p = demoPosition()
  const openEth = p.collateral.find((c) => c.symbol === 'WETH')!.priceUsd
  const openBtc = p.collateral.find((c) => c.symbol === 'WBTC')!.priceUsd
  const factor: number[] = []
  for (let i = 0; i < 60; i++) {
    factor.push(i < 10 ? 1 : i < 30 ? 1 - ((i - 10) / 20) * 0.45 : 0.55 + ((i - 30) / 30) * 0.18)
  }
  return buildPricePath(
    {
      startTs: 1_760_054_400,
      stepSeconds: 60,
      count: 60,
      columns: {
        ethOracle: factor.map((f) => openEth * f),
        btcOracle: factor.map((f) => openBtc * f),
      },
      carried: {},
    },
    fakeManifest,
    ['WETH', 'WBTC', 'USDC'],
  )
}

const baseOpts = {
  membraneLiqFee: 0.05,
  venue: null,
  sourceRepayFraction: 0.5776,
  sourceRepayFractionLabel: '58%',
  scenarioLabel: 'test',
}

test('both engines see the identical price path', () => {
  const { path, unpriced } = crashPath()
  const cmp = runComparison(demoPosition(), path, unpriced, baseOpts)
  // Before any liquidation fires, equity must be identical in both runs.
  close(cmp.source.equitySeries[0] as number, cmp.membrane.equitySeries[0] as number, 'same starting equity')
  close(cmp.source.startEquityUsd, cmp.membrane.startEquityUsd, 'same start')
})

test('a crash liquidates on both engines — Membrane is not magic', () => {
  const { path, unpriced } = crashPath()
  const cmp = runComparison(demoPosition(), path, unpriced, baseOpts)
  assert.ok(cmp.source.events.length > 0, 'the source engine liquidated')
  assert.ok(cmp.membrane.events.length > 0, 'membrane liquidated too')
})

// This is the result that matters most and it is NOT flattering. Our modelled Membrane
// line (77.4% on this basket) is TIGHTER than Aave's real one (80.4%), so with no
// deployment to recall from, Membrane breaches sooner and liquidates more often. It
// ends with LESS equity than Aave here. If this assertion ever flips, someone has
// loosened the modelled LTVs — check that it was for a real reason.
test('with no venue, a tighter modelled line makes Membrane liquidate earlier and MORE often', () => {
  const { path, unpriced } = crashPath()
  const cmp = runComparison(demoPosition(), path, unpriced, baseOpts)
  const membraneLine = weightedMembraneLine(demoPosition().collateral).maxLtv
  assert.ok(membraneLine < demoPosition().liquidationLtv, 'the modelled line is tighter than Aave\'s')
  assert.ok(cmp.membrane.events.length > cmp.source.events.length, 'more partial liquidations')
  assert.ok(cmp.equityDeltaUsd < 0, 'and Membrane ends BEHIND — no deployment means no recall to spend')
})

test('recalled capital is equity-neutral — a recall is not free money', () => {
  const { path, unpriced } = crashPath()
  const deployed = 400_000
  const venue = { recallRate: 0.95, fastRate: 0.95, deployedUsd: deployed, provenance: {} as never }
  const cmp = runComparison(demoPosition(), path, unpriced, { ...baseOpts, venue })
  // Deployed capital must appear on BOTH balance sheets: the source protocol simply
  // cannot reach it. Starting equity therefore has to be identical.
  close(cmp.source.startEquityUsd, cmp.membrane.startEquityUsd, 'same starting balance sheet', 1e-6)
  close(
    cmp.source.startEquityUsd,
    demoPosition().totalCollateralUsd + deployed - demoPosition().totalDebtUsd,
    'equity is collateral + deployed - debt',
    1e-6,
  )
  // Membrane's entire advantage must be explainable by the penalty it avoided plus the
  // forced sale it did not make — never by conjuring the deployed capital twice.
  assert.ok(
    cmp.equityDeltaUsd < deployed,
    'the advantage cannot exceed the deployed capital — that would mean double-counting',
  )
  assert.ok(cmp.equityDeltaUsd > 0, 'but with recall available Membrane does come out ahead')
})

test('a deep venue lets Membrane cure without selling collateral', () => {
  const { path, unpriced } = crashPath()
  const venue = { recallRate: 0.98, fastRate: 0.98, deployedUsd: 400_000, provenance: {} as never }
  const cmp = runComparison(demoPosition(), path, unpriced, { ...baseOpts, venue })
  const cures = cmp.membrane.events.filter((e) => e.kind === 'cure')
  assert.ok(cures.length > 0, 'the cure window fired')
  assert.ok(cures.every((e) => e.seizedUsd === 0), 'a cure sells nothing')
  close(cmp.membrane.penaltyPaidUsd, 0, 'and costs no penalty')
})

test('the recall rate is the dominant variable once it binds', () => {
  const { path, unpriced } = crashPath()
  // Deployed capital is sized so the RATE actually binds. At 400k even a 10% rate
  // covers the whole call, so every rate gives the same answer — a real property of
  // the engine, not a bug, but useless as a test of sensitivity.
  const mk = (recallRate: number) =>
    runComparison(demoPosition(), path, unpriced, {
      ...baseOpts,
      venue: { recallRate, fastRate: 0, deployedUsd: 60_000, provenance: {} as never },
    })
  const deep = mk(0.95)
  const shallow = mk(0.1)
  assert.ok(
    deep.membrane.penaltyPaidUsd < shallow.membrane.penaltyPaidUsd,
    `deeper recall pays less penalty (${deep.membrane.penaltyPaidUsd} vs ${shallow.membrane.penaltyPaidUsd})`,
  )
  assert.ok(
    deep.membrane.endCollateralUsd > shallow.membrane.endCollateralUsd,
    'and keeps more collateral, because less of the call reached it',
  )
})

test('a calm path liquidates on neither engine', () => {
  const flat = buildPricePath(
    { startTs: 0, stepSeconds: 60, count: 30, columns: { ethOracle: new Array(30).fill(4370), btcOracle: new Array(30).fill(121566) }, carried: {} },
    fakeManifest,
    ['WETH', 'WBTC', 'USDC'],
  )
  const cmp = runComparison(demoPosition(), flat.path, flat.unpriced, baseOpts)
  assert.strictEqual(cmp.source.events.length, 0, 'no source liquidation')
  assert.strictEqual(cmp.membrane.events.length, 0, 'no membrane liquidation')
  close(cmp.equityDeltaUsd, 0, 'and no difference between them')
})

test('every run carries its caveats — they are never empty', () => {
  const { path, unpriced } = crashPath()
  const cmp = runComparison(demoPosition(), path, unpriced, baseOpts)
  assert.ok(cmp.source.caveats.length > 0, 'source caveats present')
  assert.ok(cmp.membrane.caveats.length > 0, 'membrane caveats present')
  assert.ok(
    cmp.membrane.caveats.some((c) => c.toLowerCase().includes('no ethereum mainnet deployment')),
    'the no-deployment caveat is always stated',
  )
})

test('measuredRepayFraction uses measured events, not the documented close factor', () => {
  const measured = {
    aaveV3: { medianRepayFraction: 0.5776, events: 3111 },
    morphoBlue: { medianRepayFraction: 1, events: 886 },
  }
  const aave = measuredRepayFraction('aave-v3', measured)
  close(aave.fraction, 0.5776, 'aave median')
  assert.ok(aave.label.includes('3,111'), 'the event count is quoted')
  const morpho = measuredRepayFraction('morpho-blue', measured)
  close(morpho.fraction, 1, 'morpho median is a full liquidation')
  const unknown = measuredRepayFraction('aave-v3', null)
  assert.ok(unknown.label.includes('no measured events'), 'falls back honestly and says so')
})

// ============================================== the demo position is coherent
test('the demo position uses real Aave V3 risk parameters', () => {
  const p = demoPosition()
  assert.strictEqual(p.provenance.kind, 'mock', 'the balances are marked mock')
  const weth = p.collateral.find((c) => c.symbol === 'WETH')!
  close(weth.liquidationThreshold, 0.83, 'real Aave WETH liquidation threshold')
  close(weth.maxLtv, 0.805, 'real Aave WETH LTV')
  close(weth.liquidationBonus!, 0.05, 'real Aave WETH bonus')
  assert.ok(p.ltv < p.liquidationLtv, 'the demo opens healthy')
  assert.ok(p.healthFactor > 1, 'health factor above one')
})

// ================================================================ url state
test('url state round-trips so a shared link reproduces the run', () => {
  const s = { address: '0xabc', position: 'aave-v3', membraneMaxLtv: 0.8, liqFee: 0.05, recallRate: 0.9, fastRate: 0.5, deployedUsd: 250_000 }
  const q = Object.fromEntries(new URLSearchParams(writeUrlState(s).slice(1)))
  const back = readUrlState(q)
  assert.strictEqual(back.address, '0xabc')
  close(back.membraneMaxLtv!, 0.8, 'ltv')
  close(back.recallRate!, 0.9, 'recall')
  assert.strictEqual(back.deployedUsd, 250_000)
  assert.deepStrictEqual(readUrlState({}), {
    address: undefined, position: undefined, membraneMaxLtv: undefined,
    liqFee: undefined, recallRate: undefined, fastRate: undefined, deployedUsd: undefined,
  })
})

// ================================================== adapter parsing helpers
test('parseAddress accepts only real addresses', () => {
  assert.strictEqual(parseAddress('0x' + 'a'.repeat(40)), '0x' + 'a'.repeat(40))
  assert.strictEqual(parseAddress('  0x' + 'A'.repeat(40) + ' '), '0x' + 'a'.repeat(40), 'trimmed and lowercased')
  assert.strictEqual(parseAddress('0x123'), null, 'too short')
  assert.strictEqual(parseAddress('vitalik.eth'), null, 'ENS is not resolved here')
  assert.strictEqual(parseAddress(''), null)
})

test('toNumber scales uint256 by decimals without losing the fraction', () => {
  close(toNumber(1_500_000_000_000_000_000n, 18), 1.5, '1.5e18')
  close(toNumber(123_456_789n, 8), 1.23456789, '8 decimals (WBTC)')
  close(toNumber(2_500_000n, 6), 2.5, '6 decimals (USDC)')
  close(toNumber(0n, 18), 0, 'zero')
  assert.strictEqual(toNumber(42n, 0), 42, 'no decimals')
})

test('ratio never returns a nonsense number for a debt-free position', () => {
  assert.strictEqual(ratio(100, 0), Number.POSITIVE_INFINITY, 'no debt -> infinite health, not 1e59')
  close(ratio(50, 100), 0.5, 'ordinary ratio')
})

test('decimalsFromScale rejects a scale that is not a power of ten', () => {
  assert.strictEqual(decimalsFromScale(10n ** 18n, 'x'), 18)
  assert.strictEqual(decimalsFromScale(10n ** 6n, 'x'), 6)
  assert.strictEqual(decimalsFromScale(1n, 'x'), 0)
  assert.throws(() => decimalsFromScale(3n, 'WEIRD'), /WEIRD/, 'throws naming the asset rather than guessing')
})

test('mulDivUp rounds up — Morpho debt must never round in the borrower’s favour', () => {
  assert.strictEqual(mulDivUp(10n, 10n, 3n), 34n, '100/3 rounds up to 34')
  assert.strictEqual(mulDivUp(10n, 10n, 5n), 20n, 'exact division does not round up')
  assert.strictEqual(mulDivUp(0n, 10n, 3n), 0n, 'zero stays zero')
})

test('unwrap throws with the failing call named; optional swallows it', () => {
  assert.strictEqual(unwrap({ status: 'success', result: 7 }, 'x'), 7)
  assert.throws(() => unwrap({ status: 'failure', error: new Error('rpc down') }, 'Pool.getUserAccountData()'), /getUserAccountData/)
  assert.throws(() => unwrap(undefined, 'MissingCall()'), /MissingCall/)
  assert.strictEqual(optional({ status: 'failure', error: new Error('x') }), null, 'optional returns null')
  assert.strictEqual(optional({ status: 'success', result: 9 }), 9)
})

test('UnsupportedError is distinguishable so a stub is not reported as a failure', () => {
  const e = new UnsupportedError('fluid enumeration not implemented')
  assert.ok(e instanceof UnsupportedError)
  assert.ok(e instanceof Error)
  assert.ok(e.message.includes('fluid'))
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
