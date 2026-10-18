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
import fs from 'node:fs'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChakraProvider } from '@chakra-ui/react'
import { Controls } from '../../components/Simulator/Controls'
import {
  BORROW_LTV_GAP,
  LIQ_DEBT_MINIMUM_USD,
  applyDebtMinimum,
  CURE_WINDOW_SECONDS,
  DEPLOY_LAUNCH_LTV,
  MAX_LTV_HARD_CAP,
  MEMBRANE_ASSET_LTV,
  MEMBRANE_DEPLOY_LTV_PROVENANCE,
  MEMBRANE_LTV_INPUT_MIN,
  MEMBRANE_LTV_PROVENANCE,
  NO_DELAY_LTV_HARD_CAP,
  applyRecall,
  clampMembraneLtv,
  fullRepayValue,
  hasMembraneLine,
  isDeployListedLtv,
  membraneBorrowLtv,
  membraneMaxLtv,
  membraneRepayValue,
  membraneSaleAfterRecall,
  weightedMembraneLine,
} from '../../lib/position-sim/membrane'
import {
  MAX_LIQ_FEE,
  measuredRepayFraction,
  runComparison,
  splitByDelayClass,
} from '../../lib/position-sim/compare'
import {
  HELD_AT_ONE,
  SYMBOL_TO_SERIES,
  buildPricePath,
  priceAt,
} from '../../lib/position-sim/scenario'
import { demoPosition } from '../../lib/position-sim/demo'
import { DelayTimer, cureWalk } from '../../lib/position-sim/curePath'
import {
  MEASURED_STABLES,
  STABLE_SYMBOLS,
  YIELD_BEARING_STABLES,
  delayClassOf,
  heldAtOne,
  heldAtReadPrice,
  heldFlat,
  isNoDelayCollateral,
  lineIsNoDelay,
  positionLtvCap,
} from '../../lib/position-sim/collateralClass'
import { readUrlState, writeUrlState } from '../../lib/position-sim/share'
import {
  decimalsFromScale,
  mulDivUp,
  ratio,
  unwrap,
  optional,
  UnsupportedError,
} from '../../lib/position-sim/adapters/types'
import { toNumber, parseAddress } from '../../lib/position-sim/rpc'
import type { Oct10Manifest, Oct10Series } from '../../lib/position-sim/scenario'
import { stamp } from '../../lib/position-sim/types'
import type { PricePath, ProtocolPosition } from '../../lib/position-sim/types'

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
  assert.strictEqual(
    CURE_WINDOW_SECONDS,
    28_800,
    'cure window — liquidation-engine/src/contract.rs:52',
  )
  close(MAX_LIQ_FEE, 0.1, 'MAX_LIQ_FEE — lib/Constants.sol:57')
})

test('the borrow cap sits exactly 3pp under the liquidation line', () => {
  close(membraneBorrowLtv(0.8), 0.77, '80% line')
  close(membraneBorrowLtv(0.02), 0, 'clamped at zero')
})

test('no modelled LTV may exceed the hard cap of its delay class', () => {
  // A delayed listing is clamped at MAX_LTV_HARD_CAP = 90% (lib/Constants.sol:23,
  // Collateral.sol:538-540); a no-delay (stable) listing at NO_DELAY_LTV_HARD_CAP = 96%
  // (lib/Constants.sol:32). The class is collateralClass.ts's, not a second list.
  close(NO_DELAY_LTV_HARD_CAP, 0.96, 'NO_DELAY_LTV_HARD_CAP — lib/Constants.sol:32')
  for (const sym of Object.keys(MEMBRANE_ASSET_LTV)) {
    const cap = isNoDelayCollateral(sym) ? NO_DELAY_LTV_HARD_CAP : MAX_LTV_HARD_CAP
    assert.ok(membraneMaxLtv(sym)! <= cap, `${sym} within its class cap (${cap})`)
  }
  // The clamp itself, per class: push a delayed and a no-delay entry past both caps.
  const saved = { WETH: MEMBRANE_ASSET_LTV.WETH, USDC: MEMBRANE_ASSET_LTV.USDC }
  try {
    MEMBRANE_ASSET_LTV.WETH = 0.95
    MEMBRANE_ASSET_LTV.USDC = 0.99
    close(membraneMaxLtv('WETH')!, MAX_LTV_HARD_CAP, 'a delayed asset stops at 90%')
    close(membraneMaxLtv('USDC')!, NO_DELAY_LTV_HARD_CAP, 'a no-delay asset stops at 96%, not 90%')
  } finally {
    MEMBRANE_ASSET_LTV.WETH = saved.WETH
    MEMBRANE_ASSET_LTV.USDC = saved.USDC
  }
  assert.strictEqual(
    membraneMaxLtv('NOT_A_TOKEN'),
    null,
    'unknown assets return null, never a default',
  )
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
  const deep = applyRecall(call, {
    recallRate: 0.95,
    fastRate: 0.95,
    deployedUsd: 100_000,
    provenance: {} as never,
  })
  const shallow = applyRecall(call, {
    recallRate: 0.12,
    fastRate: 0,
    deployedUsd: 100_000,
    provenance: {} as never,
  })
  assert.ok(
    shallow.shortfallUsd > deep.shortfallUsd,
    'a shallower venue pushes more onto collateral',
  )
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
  name: 'test',
  windowStartUtc: '2025-10-10T00:00:00Z',
  windowEndUtc: '2025-10-10T00:04:00Z',
  resolution: '1 minute',
  sources: [],
  caveats: [],
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
//
// demoPosition() (lib/position-sim/demo.ts) was switched to a real on-chain snapshot
// (owner, 2026-09-11/12): six collateral legs — WETH, WBTC, weETH, cbBTC, LBTC, eBTC —
// against three stable debt legs. crashPath() below only ever drove WETH/WBTC/USDC, so
// once the real snapshot landed, ~59% of the collateral (weETH+LBTC+eBTC — cbBTC's
// symbol IS mapped to the btc series but the other three have no series in
// lib/position-sim/scenario.ts's SYMBOL_TO_SERIES) never moved during the "crash" and
// nothing ever breached: the five tests below that need a breach were asserting
// against a position that could no longer produce one.
//
// This section restores the two-asset worked-example position the tests were written
// against (WETH/WBTC collateral, USDC debt, real Aave V3 risk params) as a LOCAL test
// fixture — it is the shape demoPosition() itself used before the on-chain switch. It
// is deliberately not imported from lib/position-sim/demo.ts (engine code, not to be
// changed): every leg below is one crashPath() can actually price, which is the only
// property these tests need.
const AAVE_WETH = { liquidationThreshold: 0.83, maxLtv: 0.805, liquidationBonus: 0.05 }
const AAVE_WBTC = { liquidationThreshold: 0.78, maxLtv: 0.73, liquidationBonus: 0.05 }
const CRASH_OPEN_ETH = 4370.37
const CRASH_OPEN_BTC = 121566.15

function crashTestPosition(): ProtocolPosition {
  const ethAmount = 40
  const btcAmount = 1.5
  // 210k, not the 250k the shipped demo later moved to (6bdfd4e7, "worked example now
  // crosses the line"): at 250k debt the venue-recall test goes negative — the extra
  // debt changes which liquidation clears the loan by the time price partially
  // recovers, which is a real property of the engine, not something these tests are
  // trying to pin. 210k is the amount every test in this file was originally written
  // and verified against (66e16ad1) and it is still comfortably enough to breach both
  // engines under crashPath().
  const debtAmount = 210_000
  const collateral = [
    {
      symbol: 'WETH',
      address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      decimals: 18,
      amount: ethAmount,
      priceUsd: CRASH_OPEN_ETH,
      valueUsd: ethAmount * CRASH_OPEN_ETH,
      ...AAVE_WETH,
    },
    {
      symbol: 'WBTC',
      address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
      decimals: 8,
      amount: btcAmount,
      priceUsd: CRASH_OPEN_BTC,
      valueUsd: btcAmount * CRASH_OPEN_BTC,
      ...AAVE_WBTC,
    },
  ]
  const debt = [
    {
      symbol: 'USDC',
      address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      decimals: 6,
      amount: debtAmount,
      priceUsd: 1,
      valueUsd: debtAmount,
      borrowApr: null,
    },
  ]
  const totalCollateralUsd = collateral.reduce((a, c) => a + c.valueUsd, 0)
  const totalDebtUsd = debt.reduce((a, d) => a + d.valueUsd, 0)
  const liquidationLtv =
    collateral.reduce((a, c) => a + c.liquidationThreshold * c.valueUsd, 0) / totalCollateralUsd
  return {
    protocol: 'aave-v3',
    label: 'Aave V3',
    collateral,
    debt,
    totalCollateralUsd,
    totalDebtUsd,
    ltv: totalDebtUsd / totalCollateralUsd,
    liquidationLtv,
    healthFactor: (totalCollateralUsd * liquidationLtv) / totalDebtUsd,
    provenance: stamp(
      'mock',
      'worked example · not a real wallet',
      'Two-asset fixture reproducing the pre-2026-09-11 demoPosition() shape, kept ' +
        'local to the crash tests because every leg must be one crashPath() can price.',
    ),
  }
}

function crashPath() {
  // A ~45% drawdown and a partial recovery, applied as a MULTIPLIER to each asset's
  // real opening price so minute 0 reproduces the fixture's stored values exactly.
  // That keeps the balance-sheet assertions exact rather than approximate.
  const p = crashTestPosition()
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
  const cmp = runComparison(crashTestPosition(), path, unpriced, baseOpts)
  // Before any liquidation fires, equity must be identical in both runs.
  close(
    cmp.source.equitySeries[0] as number,
    cmp.membrane.equitySeries[0] as number,
    'same starting equity',
  )
  close(cmp.source.startEquityUsd, cmp.membrane.startEquityUsd, 'same start')
})

test('a crash liquidates on both engines — Membrane is not magic', () => {
  const { path, unpriced } = crashPath()
  const cmp = runComparison(crashTestPosition(), path, unpriced, baseOpts)
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
  const cmp = runComparison(crashTestPosition(), path, unpriced, baseOpts)
  const membraneLine = weightedMembraneLine(crashTestPosition().collateral).maxLtv
  assert.ok(
    membraneLine < crashTestPosition().liquidationLtv,
    "the modelled line is tighter than Aave's",
  )
  assert.ok(cmp.membrane.events.length > cmp.source.events.length, 'more partial liquidations')
  assert.ok(
    cmp.equityDeltaUsd < 0,
    'and Membrane ends BEHIND — no deployment means no recall to spend',
  )
})

test('recalled capital is equity-neutral — a recall is not free money', () => {
  const { path, unpriced } = crashPath()
  const deployed = 400_000
  const venue = { recallRate: 0.95, fastRate: 0.95, deployedUsd: deployed, provenance: {} as never }
  const cmp = runComparison(crashTestPosition(), path, unpriced, { ...baseOpts, venue })
  // Deployed capital must appear on BOTH balance sheets: the source protocol simply
  // cannot reach it. Starting equity therefore has to be identical.
  close(cmp.source.startEquityUsd, cmp.membrane.startEquityUsd, 'same starting balance sheet', 1e-6)
  close(
    cmp.source.startEquityUsd,
    crashTestPosition().totalCollateralUsd + deployed - crashTestPosition().totalDebtUsd,
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

test('a deep venue lets Membrane cure without SELLING collateral — and the call is paid', () => {
  // UPDATED 2026-10-14, twice. This used to assert the cure cost nothing. The contract pays
  // the call on the RECALL-ONLY lane (LiquidationEngine.sol:1603-1658), and its Step 1.5
  // recalls toward the WHOLE debt (repayTarget = totalDebt, :1319; :1450-1453) at the very
  // call that would start the timer. So a deep venue repays the loan at the first breach:
  // one event, one fee, on min(restore-to-cap target, recalled) (:1653-1654), nothing sold.
  const { path, unpriced } = crashPath()
  const venue = { recallRate: 0.98, fastRate: 0.98, deployedUsd: 400_000, provenance: {} as never }
  const cmp = runComparison(crashTestPosition(), path, unpriced, { ...baseOpts, venue })
  const ev = cmp.membrane.events
  assert.strictEqual(ev.length, 1, 'one call, at the first breach')
  assert.strictEqual(ev[0].kind, 'recall', 'answered by the venue alone')
  close(
    ev[0].recalledUsd,
    crashTestPosition().totalDebtUsd,
    'the recall repays the whole debt',
    1e-6,
  )
  close(ev[0].seizedUsd, ev[0].penaltyUsd, 'no collateral leaves beyond the fee', 1e-9)
  assert.ok(
    ev[0].penaltyUsd > 0 && ev[0].penaltyUsd < baseOpts.membraneLiqFee * ev[0].recalledUsd,
    'the fee is on the restore-to-cap target, not on the whole recall',
  )
  close(cmp.membrane.penaltyPaidUsd, ev[0].penaltyUsd, 'and it is the only fee', 1e-9)
  close(cmp.membrane.endDebtUsd, 0, 'the loan is repaid', 1e-6)
})

test('the recall rate is the dominant variable once it binds', () => {
  // The recall rate is the capital a full 8h window brings, so it binds at EXPIRY: an 8%
  // drop holds the position in band (300k / 368k = 81.5% vs the 80% line, 83.2% break)
  // until the window ends. A band break minutes after the breach only gets the fast share
  // (here 0), so a crash path would not exercise the rate at all.
  // Deployed capital is sized so the RATE actually binds: at 95% the recall alone gets
  // the position under its line (the paid recall-only lane, only the fee leaves); at 10%
  // it does not, and the shortfall is sold from collateral with the fee on top.
  const { path, unpriced } = bandPath(0.08, 600, false)
  const mk = (recallRate: number) =>
    runComparison(bandPosition(), path, unpriced, {
      ...baseOpts,
      venue: { recallRate, fastRate: 0, deployedUsd: 30_000, provenance: {} as never },
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
    {
      startTs: 0,
      stepSeconds: 60,
      count: 30,
      columns: { ethOracle: new Array(30).fill(4370), btcOracle: new Array(30).fill(121566) },
      carried: {},
    },
    fakeManifest,
    ['WETH', 'WBTC', 'USDC'],
  )
  const cmp = runComparison(crashTestPosition(), flat.path, flat.unpriced, baseOpts)
  assert.strictEqual(cmp.source.events.length, 0, 'no source liquidation')
  assert.strictEqual(cmp.membrane.events.length, 0, 'no membrane liquidation')
  close(cmp.equityDeltaUsd, 0, 'and no difference between them')
})

test('every run carries its caveats — they are never empty', () => {
  const { path, unpriced } = crashPath()
  const cmp = runComparison(crashTestPosition(), path, unpriced, baseOpts)
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
  // 2026-09-11/12: the demo wallet became a real on-chain snapshot (lib/position-sim/
  // demo.ts), so the balances are read, not invented — the risk PARAMETERS below are
  // still real Aave V3 mainnet values either way.
  assert.strictEqual(p.provenance.kind, 'onchain', 'the balances are a real on-chain read')
  const weth = p.collateral.find((c) => c.symbol === 'WETH')!
  close(weth.liquidationThreshold, 0.83, 'real Aave WETH liquidation threshold')
  close(weth.maxLtv, 0.805, 'real Aave WETH LTV')
  close(weth.liquidationBonus!, 0.05, 'real Aave WETH bonus')
  assert.ok(p.ltv < p.liquidationLtv, 'the demo opens healthy')
  assert.ok(p.healthFactor > 1, 'health factor above one')
})

// ================================================================ url state
test('url state round-trips so a shared link reproduces the run', () => {
  const s = {
    address: '0xabc',
    position: 'aave-v3',
    membraneMaxLtv: 0.8,
    liqFee: 0.05,
    recallRate: 0.9,
    fastRate: 0.5,
    deployedUsd: 250_000,
  }
  const q = Object.fromEntries(new URLSearchParams(writeUrlState(s).slice(1)))
  const back = readUrlState(q)
  assert.strictEqual(back.address, '0xabc')
  close(back.membraneMaxLtv!, 0.8, 'ltv')
  close(back.recallRate!, 0.9, 'recall')
  assert.strictEqual(back.deployedUsd, 250_000)
  assert.deepStrictEqual(readUrlState({}), {
    address: undefined,
    position: undefined,
    membraneMaxLtv: undefined,
    liqFee: undefined,
    recallRate: undefined,
    fastRate: undefined,
    deployedUsd: undefined,
    hero: undefined, // ?hero=history|oct10 A/B override, added after this test was written
  })
})

// ======================================== the delay window (lib/position-sim/curePath)
// Every case below is a contract clause, cited in curePath.ts. These are the tests that
// stop the census and the per-address simulator drifting apart.
const walkBase = {
  line: 0.8,
  band: 0.04,
  delaySeconds: CURE_WINDOW_SECONDS,
  stepSeconds: 60,
  gap: BORROW_LTV_GAP,
}
/** A ratio series that holds `r` for `n` minutes after t0. */
const flatAfter = (r: number, n: number) => [1, ...new Array(n).fill(r)]

test('the break line is line x (1 + band), not line + band', () => {
  // LiquidationEngine.sol:2099-2103. At line 0.8 / band 0.04 the break is 0.832,
  // NOT 0.84. An LTV of 0.835 must therefore be OUTSIDE the window.
  const inside = cureWalk({
    ...walkBase,
    debtUsd: 831,
    collateralUsd: 1000,
    ratios: flatAfter(1, 10),
  })
  assert.notStrictEqual(inside.outcome, 'sold-at-t0', '83.1% is inside a 83.2% break line')
  const outside = cureWalk({
    ...walkBase,
    debtUsd: 835,
    collateralUsd: 1000,
    ratios: flatAfter(1, 10),
  })
  assert.strictEqual(
    outside.outcome,
    'sold-at-t0',
    '83.5% is past it — an additive band would have held',
  )
})

test('a breach already past the band at t0 gets no window at all', () => {
  const r = cureWalk({ ...walkBase, debtUsd: 900, collateralUsd: 1000, ratios: flatAfter(2, 600) })
  assert.strictEqual(r.outcome, 'sold-at-t0', 'Immediate — LiquidationEngine.sol:1390')
  assert.strictEqual(r.closedAtIndex, 0, 'and it is priced at t0, not at the recovery')
  close(r.closedUsd, membraneRepayValue(900, 1000, 0.77), 'the shipped one-repay figure', 1e-9)
})

test('a sale at t0 past the band walks on, and a later band break sells again', () => {
  // 90% on an 80% line is past the 83.2% break line: Immediate at t0 (LiquidationEngine.sol
  // :1694-1703 at 16e12329), repaid to the 77% cap. A sale leaves no timer (:1724-1727) and the
  // position stays live, so the walk goes on: a 10% fall puts the reduced position at 85.6%,
  // past the band again, and it is sold again.
  const ratios = [1, ...new Array(30).fill(1), ...new Array(30).fill(0.9)]
  const input = { ...walkBase, debtUsd: 900_000, collateralUsd: 1_000_000, ratios }
  const r = cureWalk(input)
  assert.strictEqual(r.outcome, 'sold-at-t0', 'the outcome names the first sale')
  assert.strictEqual(r.closedAtIndex, 0)
  assert.strictEqual(r.sales, 2, 'the walk went on and sold the later band break')
  assert.strictEqual(r.breaches, 2)
  const first = membraneRepayValue(900_000, 1_000_000, 0.77)
  const second = membraneRepayValue(900_000 - first, (1_000_000 - first) * 0.9, 0.77)
  close(r.closedUsd, first + second, 'two repays to cap', 1e-6)
  // The old stop after one repay survives only as the published sensitivity.
  const old = cureWalk({ ...input, stopAfterT0BandSale: true })
  assert.strictEqual(old.outcome, 'sold-at-t0')
  assert.strictEqual(old.sales, 1)
  close(old.closedUsd, first, 'the old one repay', 1e-9)
  // With no series there is nothing to walk: one repay, still named for the t0 sale.
  const bare = cureWalk({ ...input, ratios: null })
  assert.strictEqual(bare.outcome, 'sold-at-t0')
  close(bare.closedUsd, first, 'the one-repay fallback', 1e-9)
})

test('an account under its own line at t0 keeps the conservative one-repay treatment', () => {
  // The 601-account cohort whose line is inverted from a health factor >= 1. A walk
  // would "cure" them trivially, which would be a gift, so they never enter one.
  const r = cureWalk({ ...walkBase, debtUsd: 700, collateralUsd: 1000, ratios: flatAfter(1, 600) })
  assert.strictEqual(r.outcome, 'sold-immediately-unlocated-line')
  close(r.closedUsd, membraneRepayValue(700, 1000, 0.77), 'still repaid to cap', 1e-9)
  assert.strictEqual(r.minutesToFirstCure, null, 'no cure is credited')
})

test('no price series falls back to the shipped one-repay figure, never to a cure', () => {
  const r = cureWalk({ ...walkBase, debtUsd: 810, collateralUsd: 1000, ratios: null })
  assert.strictEqual(r.outcome, 'sold-immediately-no-series')
  close(r.closedUsd, membraneRepayValue(810, 1000, 0.77), 'one repay to cap', 1e-9)
})

test('in band and inside the window, nothing is sold', () => {
  // 81% LTV, under the 83.2% break, price flat for 100 minutes then back under the line.
  const r = cureWalk({
    ...walkBase,
    debtUsd: 810,
    collateralUsd: 1000,
    ratios: [1, ...new Array(99).fill(1), ...new Array(50).fill(1.2)],
  })
  assert.strictEqual(r.outcome, 'cured-then-held', 'the price came back before the 8h ran out')
  assert.strictEqual(r.closedUsd, 0, 'and nothing was closed')
  assert.strictEqual(r.minutesToFirstCure, 100, 'the first minute back under the line')
})

test('the window expires into a sale priced at THAT minute, not at t0', () => {
  const r = cureWalk({
    ...walkBase,
    debtUsd: 810,
    collateralUsd: 1000,
    ratios: flatAfter(0.99, 600),
  })
  assert.strictEqual(r.outcome, 'sold-at-expiry')
  assert.strictEqual(r.closedAtIndex, 480, '28800s / 60s = the 480th minute')
  close(
    r.closedUsd,
    membraneRepayValue(810, 990, 0.77),
    'sized against the collateral at minute 480',
    1e-9,
  )
  assert.ok(r.closedUsd > membraneRepayValue(810, 1000, 0.77), 'a lower price means a BIGGER repay')
})

test('breaking the band during the window sells at once, before expiry', () => {
  const r = cureWalk({
    ...walkBase,
    debtUsd: 810,
    collateralUsd: 1000,
    ratios: [1, ...new Array(9).fill(1), ...new Array(600).fill(0.9)],
  })
  assert.strictEqual(r.outcome, 'sold-at-band', 'BrokeWindow — LiquidationEngine.sol:1388-1389')
  assert.strictEqual(r.closedAtIndex, 10, 'the minute the band broke, not minute 480')
})

test('a recovery re-arms the window — the delay is not one-shot', () => {
  // Breach, cure at minute 10, re-breach at minute 20. A one-shot model would sell at
  // minute 480 (t0 + 8h). The contract clears the timer on recovery (:1362-1382), so
  // the sale lands at minute 20 + 480 = 500 instead.
  const ratios = [1, ...new Array(9).fill(1), ...new Array(10).fill(1.2), ...new Array(700).fill(1)]
  const r = cureWalk({ ...walkBase, debtUsd: 810, collateralUsd: 1000, ratios })
  assert.strictEqual(r.outcome, 'sold-at-expiry')
  assert.strictEqual(r.closedAtIndex, 500, 'a FULL fresh 8 hours from the second breach')
  assert.strictEqual(r.minutesToFirstCure, 10)
  assert.strictEqual(r.breaches, 2, 'two separate breaches')
})

test('a grid that ends inside an unresolved window SELLS — the conservative reading', () => {
  const r = cureWalk({ ...walkBase, debtUsd: 810, collateralUsd: 1000, ratios: flatAfter(1, 60) })
  assert.strictEqual(r.outcome, 'sold-at-grid-end', 'no credit for time we cannot observe')
  assert.strictEqual(r.closedAtIndex, 60)
})

test('an oracle gap carries the last print forward and does not stop the clock', () => {
  const ratios: (number | null)[] = flatAfter(0.99, 600)
  for (let i = 100; i < 200; i++) ratios[i] = null
  const r = cureWalk({ ...walkBase, debtUsd: 810, collateralUsd: 1000, ratios })
  assert.strictEqual(r.outcome, 'sold-at-expiry')
  assert.strictEqual(r.closedAtIndex, 480, 'the delay is wall time, not tick time')
})

// ============== the NO-DELAY class (curePath.ts clause vii, LiquidationEngine.sol:1572)
test('a no-delay timer never arms: it sells over the line and not AT the line', () => {
  const t = new DelayTimer({ line: 0.9, band: 0.04, delaySteps: 480, noDelay: true })
  assert.deepStrictEqual(
    t.step(0, 0.9),
    { kind: 'none' },
    'ltv == line is not over it (strict >, :1576)',
  )
  assert.deepStrictEqual(t.step(1, 0.85), { kind: 'none' }, 'under the line: nothing')
  assert.deepStrictEqual(
    t.step(2, 0.9001),
    { kind: 'sell', reason: 'instant' },
    'over the line by a hair: sold at once, inside what would have been the band',
  )
  assert.strictEqual(t.armed, false, 'no timer exists in instant mode (:1708-1710)')
  assert.deepStrictEqual(
    t.step(3, 0.95),
    { kind: 'sell', reason: 'instant' },
    'still over: sell again',
  )
  assert.strictEqual(t.breaches, 1, 'one crossing, however many minutes it stays over')
  t.clearAfterSale()
  assert.deepStrictEqual(
    t.step(4, 0.91),
    { kind: 'sell', reason: 'instant' },
    'after a sale, a new breach',
  )
  assert.strictEqual(t.breaches, 2, 'counted as a second crossing')
  assert.strictEqual(t.firstCureIndex, null, 'and nothing is ever a cure — there is no window')
  // The same LTVs on a delayed timer arm a window instead.
  const d = new DelayTimer({ line: 0.9, band: 0.04, delaySteps: 480 })
  assert.deepStrictEqual(d.step(0, 0.9001), { kind: 'arm' }, 'the delayed class arms')
})

test('cureWalk no-delay: sold at t0, then sold again on a later breach', () => {
  // 81% at t0 on an 80% line — INSIDE the 83.2% break line, so the delayed class would
  // open a window. No-delay sells at t0, walks on, and sells again when the price falls
  // far enough to put the post-sale position back over its line.
  const ratios = [1, ...new Array(30).fill(1), ...new Array(30).fill(0.9)]
  const r = cureWalk({
    ...walkBase,
    debtUsd: 810_000,
    collateralUsd: 1_000_000,
    ratios,
    noDelay: true,
  })
  assert.strictEqual(r.outcome, 'sold-no-delay')
  assert.strictEqual(r.closedAtIndex, 0, 'the first sale is at t0, not at minute 480')
  assert.strictEqual(r.minutesToFirstCure, null, 'no window, so no cure')
  assert.strictEqual(r.sales, 2, 'the walk went on and sold the later breach')
  assert.strictEqual(r.breaches, 2)
  const first = membraneRepayValue(810_000, 1_000_000, 0.77)
  const debt1 = 810_000 - first
  const coll1 = 1_000_000 - first
  const second = membraneRepayValue(debt1, coll1 * 0.9, 0.77)
  close(r.closedUsd, first + second, 'repay to cap at t0, then repay to cap at minute 31', 1e-6)
  // The delayed class on the same path: armed at t0 inside the band, and only sold when
  // the drop at minute 31 takes it to 0.81 / 0.9 = 90%, past the 83.2% break line.
  const delayed = cureWalk({ ...walkBase, debtUsd: 810_000, collateralUsd: 1_000_000, ratios })
  assert.strictEqual(delayed.outcome, 'sold-at-band', 'the delayed class waits for the band')
  assert.strictEqual(delayed.closedAtIndex, 31, 'and does not sell at t0')
})

test('cureWalk no-delay: a stable/stable flat path closes exactly one repay', () => {
  // USDC collateral, USDT debt: both legs held at $1, so the ratio is flat 1.0.
  const ratios = flatAfter(1, 600)
  const r = cureWalk({
    ...walkBase,
    line: 0.92,
    debtUsd: 930_000,
    collateralUsd: 1_000_000,
    ratios,
    noDelay: true,
  })
  assert.strictEqual(r.outcome, 'sold-no-delay')
  assert.strictEqual(r.sales, 1, 'restored to the cap once, the flat path never re-breaches')
  close(r.closedUsd, membraneRepayValue(930_000, 1_000_000, 0.89), 'one repay to cap', 1e-6)
})

test('cureWalk no-delay: no series is one repay, unlocated is unlocated', () => {
  const none = cureWalk({
    ...walkBase,
    debtUsd: 810,
    collateralUsd: 1000,
    ratios: null,
    noDelay: true,
  })
  assert.strictEqual(none.outcome, 'sold-immediately-no-series', 'as for any row with no series')
  close(none.closedUsd, membraneRepayValue(810, 1000, 0.77), 'one repay to cap', 1e-9)
  const under = cureWalk({
    ...walkBase,
    debtUsd: 700,
    collateralUsd: 1000,
    ratios: flatAfter(1, 10),
    noDelay: true,
  })
  assert.strictEqual(under.outcome, 'sold-immediately-unlocated-line', 'no breach to sell on')
})

test('cureWalk no-delay ignores the band: past it at t0 is still sold-no-delay', () => {
  const r = cureWalk({
    ...walkBase,
    debtUsd: 900,
    collateralUsd: 1000,
    ratios: flatAfter(2, 60),
    noDelay: true,
  })
  assert.strictEqual(r.outcome, 'sold-no-delay', 'not sold-at-t0: there is no band to be past')
  close(r.closedUsd, membraneRepayValue(900, 1000, 0.77), 'and the dollars are the one repay', 1e-9)
})

// ========================= the simulator runs the SAME window as the census
function bandPosition(): ProtocolPosition {
  // One WETH leg, one USDC debt leg. Modelled Membrane line for WETH is 0.80, so the
  // break line is 0.832 and the borrow cap is 0.77.
  const price = 4000
  const amount = 100
  return {
    protocol: 'aave-v3',
    label: 'band test',
    collateral: [
      {
        symbol: 'WETH',
        address: '0x' + '1'.repeat(40),
        decimals: 18,
        amount,
        priceUsd: price,
        valueUsd: amount * price,
        liquidationThreshold: 0.83,
        maxLtv: 0.805,
        liquidationBonus: 0.05,
      },
    ],
    debt: [
      {
        symbol: 'USDC',
        address: '0x' + '2'.repeat(40),
        decimals: 6,
        amount: 300_000,
        priceUsd: 1,
        valueUsd: 300_000,
        borrowApr: 0.05,
      },
    ],
    totalCollateralUsd: amount * price,
    totalDebtUsd: 300_000,
    ltv: 0.75,
    liquidationLtv: 0.83,
    healthFactor: 0.83 / 0.75,
    provenance: { kind: 'mock', label: 'test', at: 0, detail: 'test' },
  }
}
/** A path that drops WETH by `drop`, holds for `hold` minutes, then recovers. */
function bandPath(drop: number, hold: number, recover: boolean) {
  const count = 2 + hold + (recover ? 60 : 0)
  const eth: number[] = []
  for (let i = 0; i < count; i++) {
    eth.push(i < 2 ? 4000 : i < 2 + hold ? 4000 * (1 - drop) : 4200)
  }
  return buildPricePath(
    {
      startTs: 1_760_054_400,
      stepSeconds: 60,
      count,
      columns: { ethOracle: eth, btcOracle: eth.map(() => 100_000) },
      carried: {},
    },
    fakeManifest,
    ['WETH', 'USDC'],
  )
}

test('the simulator holds a breach that stays in band — a cure by PRICE counts', () => {
  // 300k / (100 x 3800) = 78.9% — over the 80%? no: 0.789 < 0.80. Drop 7%: 0.806 — in
  // band (< 0.832). Held for 60 minutes, then the price comes back.
  const { path, unpriced } = bandPath(0.07, 60, true)
  const cmp = runComparison(bandPosition(), path, unpriced, { ...baseOpts, venue: null })
  const sales = cmp.membrane.events.filter((e) => e.kind === 'liquidation')
  assert.strictEqual(sales.length, 0, 'nothing sold: in band, inside the window, price recovered')
  assert.ok(
    cmp.membrane.events.some((e) => e.kind === 'breach'),
    'the window is reported, not silent',
  )
  close(cmp.membrane.penaltyPaidUsd, 0, 'and no penalty was paid')
})

test('the simulator still sells at once when the band breaks', () => {
  // Drop 12%: 300k / 352k = 85.2%, past the 83.2% break line.
  const { path, unpriced } = bandPath(0.12, 60, true)
  const cmp = runComparison(bandPosition(), path, unpriced, { ...baseOpts, venue: null })
  const sales = cmp.membrane.events.filter((e) => e.kind === 'liquidation')
  assert.ok(sales.length > 0, 'past the band the window protects nothing')
  assert.strictEqual(sales[0].minute, 2, 'and the sale is immediate, not at hour 8')
})

test('the simulator sells at expiry when the price never comes back', () => {
  const { path, unpriced } = bandPath(0.07, 600, false)
  const cmp = runComparison(bandPosition(), path, unpriced, { ...baseOpts, venue: null })
  const sales = cmp.membrane.events.filter((e) => e.kind === 'liquidation')
  assert.ok(sales.length > 0, 'the window is not a reprieve')
  assert.strictEqual(
    sales[0].minute,
    2 + Math.round(CURE_WINDOW_SECONDS / 60),
    'exactly 8h after the breach',
  )
})

// ===================== the delay class in the simulator (collateralClass.ts, compare.ts)
// ONE definition of stable collateral, read by the census and the simulator alike.
test('the stable definition is the single source for the simulator and the census', () => {
  assert.deepStrictEqual(
    [...HELD_AT_ONE],
    STABLE_SYMBOLS.filter(heldAtOne),
    'scenario.ts HELD_AT_ONE is derived from collateralClass.ts, not a second list',
  )
  for (const sym of [
    'USDC',
    'USDT',
    'USD₮0',
    'USDT0',
    'DAI',
    'GHO',
    'LUSD',
    'USDS',
    'FRAX',
    'USDC.e',
    'crvUSD',
    'MAI',
    'USDbC',
  ]) {
    assert.ok(heldAtOne(sym) && isNoDelayCollateral(sym), `${sym}: stable, held at $1, no-delay`)
  }
  assert.deepStrictEqual([...YIELD_BEARING_STABLES], ['sDAI', 'sUSDS', 'syrupUSDC', 'scrvUSD'])
  for (const sym of YIELD_BEARING_STABLES) {
    assert.ok(isNoDelayCollateral(sym), `${sym} is stable for the delay class`)
    assert.ok(
      !heldAtOne(sym) && !HELD_AT_ONE.includes(sym) && heldAtReadPrice(sym),
      `${sym} accrues above $1: held at its read price, NOT at $1`,
    )
    assert.ok(heldFlat(sym), `${sym} is still a flat series for the census's ratios`)
  }
  assert.deepStrictEqual([...MEASURED_STABLES], ['USDe', 'sUSDe'])
  for (const sym of MEASURED_STABLES) {
    assert.ok(isNoDelayCollateral(sym), `${sym} is stable for the delay class`)
    assert.ok(!heldAtOne(sym) && !HELD_AT_ONE.includes(sym), `${sym} is measured, NOT held at $1`)
  }
  assert.ok(
    isNoDelayCollateral('sUSD') && !heldAtOne('sUSD') && !HELD_AT_ONE.includes('sUSD'),
    'sUSD is stable for the class but traded off its peg, so it is never pinned at $1',
  )
  assert.ok(!isNoDelayCollateral('WETH') && !isNoDelayCollateral('wstETH'), 'volatile is delayed')
  // The census publishes the list it ran on; it must be this one.
  const evidence = JSON.parse(fs.readFileSync('public/data/oct10-2025/evidence.json', 'utf8'))
  assert.deepStrictEqual(
    evidence.meta.delayClass.stableSymbols,
    [...STABLE_SYMBOLS],
    'evidence.json used it',
  )
  // And neither engine carries a private copy any more.
  for (const f of ['scripts/build-evidence.ts', 'lib/position-sim/scenario.ts']) {
    const src = fs.readFileSync(f, 'utf8')
    assert.ok(!/'USDbC'|'crvUSD'|'sUSDS'/.test(src), `${f} has no stable list of its own`)
    assert.ok(src.includes('collateralClass'), `${f} reads collateralClass.ts`)
  }
})

test('a syrupUSDC position is held at its read price, not $1 — no false minute-0 sale', () => {
  // The review run: Morpho syrupUSDC/USDC, LTV 0.857 against LLTV 0.915, syrupUSDC read at
  // $1.12. Pinned at $1.00 the collateral lost ~11% at minute 0 (LTV 0.96 > 0.915) and
  // BOTH sides "liquidated at 10 Oct 00:00". Held at its read price on a flat path, it
  // survives on both sides.
  const read = 1.12
  const collUsd = 1_000_000
  const debtUsd = 857_000
  const pos: ProtocolPosition = {
    protocol: 'morpho-blue',
    label: 'syrupUSDC/USDC',
    collateral: [
      {
        symbol: 'syrupUSDC',
        address: '0x' + '8'.repeat(40),
        decimals: 6,
        amount: collUsd / read,
        priceUsd: read,
        valueUsd: collUsd,
        liquidationThreshold: 0.915,
        maxLtv: 0.915,
        liquidationBonus: 0.0264,
      },
    ],
    debt: [
      {
        symbol: 'USDC',
        address: '0x' + '9'.repeat(40),
        decimals: 6,
        amount: debtUsd,
        priceUsd: 1,
        valueUsd: debtUsd,
        borrowApr: null,
      },
    ],
    totalCollateralUsd: collUsd,
    totalDebtUsd: debtUsd,
    ltv: debtUsd / collUsd,
    liquidationLtv: 0.915,
    healthFactor: (0.915 * collUsd) / debtUsd,
    provenance: { kind: 'mock', label: 'test', at: 0, detail: 'test' },
  }
  const {
    path,
    unpriced,
    heldAtReadPrice: readPriced,
  } = buildPricePath(
    {
      startTs: 1_760_054_400,
      stepSeconds: 60,
      count: 120,
      columns: { ethOracle: new Array(120).fill(4000), btcOracle: new Array(120).fill(100_000) },
      carried: {},
    },
    fakeManifest,
    ['syrupUSDC', 'USDC'],
  )
  assert.deepStrictEqual(readPriced, ['syrupUSDC'], 'listed as held at its read price')
  assert.deepStrictEqual(unpriced, [], 'and NOT as unpriced')
  assert.strictEqual(path.series.syrupUSDC, undefined, 'no $1 series: the run reads priceUsd')
  assert.ok(path.series.USDC, 'USDC keeps its flat $1.00 series')
  assert.ok(debtUsd / (collUsd / read) > 0.915, 'a $1.00 pin would have put it over the LLTV')

  const cmp = runComparison(pos, path, unpriced, {
    ...baseOpts,
    membraneMaxLtv: 0.915,
    venue: null,
  })
  assert.deepStrictEqual(cmp.source.events, [], 'Morpho: no liquidation on a flat path')
  assert.deepStrictEqual(cmp.membrane.events, [], 'Membrane: no liquidation on a flat path')
  close(cmp.source.endEquityUsd, collUsd - debtUsd, 'source equity intact', 1e-6)
  close(cmp.membrane.endEquityUsd, collUsd - debtUsd, 'Membrane equity intact', 1e-6)
  assert.deepStrictEqual(cmp.heldAtReadPriceSymbols, ['syrupUSDC'])
  assert.deepStrictEqual(cmp.unpricedSymbols, [])
  for (const run of [cmp.source, cmp.membrane]) {
    assert.ok(
      run.caveats.some((c) =>
        c.startsWith('Held flat at the price read for this position, not at $1.00: syrupUSDC.'),
      ),
      `${run.engine} run says so`,
    )
  }
  // And at the PAGE's default line, with no override: syrupUSDC now has the deploy's own
  // bootstrap max LTV, 86% (DeployFullSystem.s.sol:247), so the position is judged at 86%,
  // not at line 0 — and at LTV 0.857 it survives on both sides there too.
  const pageLine = weightedMembraneLine(pos.collateral).maxLtv
  close(pageLine, 0.86, 'the page default is the deploy value', 1e-12)
  const atDefault = runComparison(pos, path, unpriced, {
    ...baseOpts,
    membraneMaxLtv: pageLine,
    venue: null,
  })
  assert.deepStrictEqual(atDefault.membrane.events, [], 'Membrane at 86%: nothing sold')
  assert.deepStrictEqual(atDefault.source.events, [], 'Morpho: nothing sold')
  assert.ok(
    atDefault.membrane.caveats.some((c) =>
      c.includes('the deploy script’s own bootstrap value (syrupUSDC 86%)'),
    ),
    'and the run says where the line comes from',
  )
})

test('the launch stables carry the deploy script’s own max LTV; GHO stays unknown', () => {
  // REAL deploy values, membrane-solidity 16e12329 script/DeployFullSystem.s.sol:243-251.
  assert.deepStrictEqual({ ...DEPLOY_LAUNCH_LTV }, { sUSDS: 0.88, syrupUSDC: 0.86, scrvUSD: 0.86 })
  for (const [sym, v] of Object.entries(DEPLOY_LAUNCH_LTV)) {
    close(membraneMaxLtv(sym)!, v, `${sym} runs at the deploy's ${v}`, 1e-12)
    assert.ok(isDeployListedLtv(sym), `${sym} is deploy-listed`)
  }
  assert.ok(!isDeployListedLtv('USDC'), 'USDC is still our assumption')
  assert.notStrictEqual(MEMBRANE_DEPLOY_LTV_PROVENANCE.kind, 'modelled', 'stamped as a source')
  assert.ok(MEMBRANE_DEPLOY_LTV_PROVENANCE.detail!.includes('DeployFullSystem.s.sol:243'))
  assert.strictEqual(membraneMaxLtv('GHO'), null, 'GHO: nothing invented')
  assert.strictEqual(hasMembraneLine(['GHO']), false, 'an all-GHO position has no line')
  assert.strictEqual(hasMembraneLine(['GHO', 'WETH']), true, 'one known leg is enough')
  assert.strictEqual(hasMembraneLine([]), false)
})

test('a user line is clamped to the position’s class cap (slider and URL ?ltv)', () => {
  close(positionLtvCap(['USDC', 'sUSDS']), NO_DELAY_LTV_HARD_CAP, 'all stable: 96%', 1e-12)
  close(positionLtvCap(['WETH']), MAX_LTV_HARD_CAP, 'delayed: 90%', 1e-12)
  close(positionLtvCap(['USDC', 'WETH']), MAX_LTV_HARD_CAP, 'mixed: 90%', 1e-12)
  close(positionLtvCap([]), MAX_LTV_HARD_CAP, 'no legs: 90%', 1e-12)
  close(clampMembraneLtv(0.95, ['USDC']), 0.95, 'a stable position may run at 95%', 1e-12)
  close(clampMembraneLtv(0.99, ['USDC']), 0.96, 'but not past 96%', 1e-12)
  close(clampMembraneLtv(0.95, ['WETH']), 0.9, 'a WETH position stops at 90%', 1e-12)
  close(clampMembraneLtv(0.95, ['USDC', 'WETH']), 0.9, 'so does a mixed one', 1e-12)
  close(
    clampMembraneLtv(0, ['WETH']),
    MEMBRANE_LTV_INPUT_MIN,
    'and the floor is the slider’s',
    1e-12,
  )
  close(clampMembraneLtv(NaN, ['USDC']), 0.96, 'garbage reads as the cap', 1e-12)
  // The URL round-trip: ?ltv=0.95 reads back as 0.95 and is clamped at use, per position.
  const back = readUrlState(
    Object.fromEntries(new URLSearchParams(writeUrlState({ membraneMaxLtv: 0.95 }).slice(1))),
  )
  close(clampMembraneLtv(back.membraneMaxLtv!, ['WETH']), 0.9, '?ltv=0.95 on WETH -> 90%', 1e-12)
  close(clampMembraneLtv(back.membraneMaxLtv!, ['USDC']), 0.95, '?ltv=0.95 on USDC stays', 1e-12)
  // Unclamped, a 95% line would have made a WETH position no-delay by the line rule.
  assert.strictEqual(delayClassOf(['WETH'], clampMembraneLtv(0.95, ['WETH'])), 'delayed')
  // The slider's rendered max is the cap it is given (Controls.tsx `ltvMax`).
  const sliderMax = (ltvMax: number) => {
    const html = renderToStaticMarkup(
      React.createElement(
        ChakraProvider,
        null,
        React.createElement(Controls, {
          values: {
            membraneMaxLtv: 0.87,
            membraneLiqFee: 0,
            recallRate: 0,
            fastRate: 0,
            deployedUsd: 0,
          },
          onChange: () => {},
          onReset: () => {},
          unknownLtvSymbols: [],
          venueDetected: false,
          ltvProvenance: MEMBRANE_LTV_PROVENANCE,
          venueProvenance: MEMBRANE_LTV_PROVENANCE,
          ltvMax,
        }),
      ),
    )
    const input = html.match(/<input[^>]*id="sim-membrane-ltv"[^>]*>/)?.[0] ?? ''
    return input.match(/max="([^"]+)"/)?.[1]
  }
  assert.strictEqual(sliderMax(positionLtvCap(['USDC', 'sUSDS'])), '0.96', 'stable: to 96%')
  assert.strictEqual(sliderMax(positionLtvCap(['WETH'])), '0.9', 'otherwise: to 90%')
})

test('lineIsNoDelay is strict at 90%, exactly like Collateral.sol:425', () => {
  assert.strictEqual(lineIsNoDelay(0.9), false, '90% itself is the delayed class')
  assert.strictEqual(lineIsNoDelay(0.9000001), true, 'anything above it is no-delay')
  assert.strictEqual(lineIsNoDelay(0.8), false)
})

test('delayClassOf: no-delay, delayed, mixed', () => {
  assert.strictEqual(delayClassOf(['USDC']), 'no-delay')
  assert.strictEqual(delayClassOf(['USDC', 'USDT', 'USDC']), 'no-delay', 'duplicates do not matter')
  assert.strictEqual(delayClassOf(['USDe'], 0.8), 'no-delay', 'a measured stable is still no-delay')
  assert.strictEqual(delayClassOf(['WETH'], 0.8), 'delayed')
  assert.strictEqual(delayClassOf(['WETH'], 0.9), 'delayed', 'a 90% line is still delayed')
  assert.strictEqual(
    delayClassOf(['WETH'], 0.95),
    'no-delay',
    'a line above 90% is only possible no-delay',
  )
  assert.strictEqual(
    delayClassOf(['WETH', 'USDC']),
    'mixed',
    'Cdp.sol:1650-1651 refuses this position',
  )
  assert.strictEqual(
    delayClassOf(['WETH', 'USDC'], 0.95),
    'mixed',
    'mixed is decided before the line',
  )
  assert.strictEqual(delayClassOf([], 0.92), 'no-delay', 'no symbols: the line alone')
  assert.strictEqual(delayClassOf([], 0.8), 'delayed')
})

/** One collateral leg / one debt leg position, for the class tests below. */
function legPosition(
  coll: { symbol: string; amount: number; price: number }[],
  debt: { symbol: string; amount: number; price: number },
): ProtocolPosition {
  const collateral = coll.map((c, k) => ({
    symbol: c.symbol,
    address: '0x' + String(k + 3).repeat(40),
    decimals: 18,
    amount: c.amount,
    priceUsd: c.price,
    valueUsd: c.amount * c.price,
    liquidationThreshold: 0.9,
    maxLtv: 0.87,
    liquidationBonus: 0.05,
  }))
  const totalCollateralUsd = collateral.reduce((a, c) => a + c.valueUsd, 0)
  const totalDebtUsd = debt.amount * debt.price
  return {
    protocol: 'aave-v3',
    label: 'class test',
    collateral,
    debt: [
      {
        symbol: debt.symbol,
        address: '0x' + '9'.repeat(40),
        decimals: 18,
        amount: debt.amount,
        priceUsd: debt.price,
        valueUsd: totalDebtUsd,
        borrowApr: null,
      },
    ],
    totalCollateralUsd,
    totalDebtUsd,
    ltv: totalDebtUsd / totalCollateralUsd,
    liquidationLtv: 0.9,
    healthFactor: (0.9 * totalCollateralUsd) / totalDebtUsd,
    provenance: { kind: 'mock', label: 'test', at: 0, detail: 'test' },
  }
}
/** ETH on a ramp: flat for `flat` minutes, then up 0.5% a minute. */
function ethRamp(count: number, flat: number) {
  const eth = Array.from(
    { length: count },
    (_, i) => 4000 * (i < flat ? 1 : 1 + 0.005 * (i - flat + 1)),
  )
  return buildPricePath(
    {
      startTs: 1_760_054_400,
      stepSeconds: 60,
      count,
      columns: { ethOracle: eth, btcOracle: eth.map(() => 100_000) },
      carried: {},
    },
    fakeManifest,
    ['USDC', 'WETH'],
  )
}

test('the simulator sells stable collateral the first minute it is over its line — no window', () => {
  // $100k USDC against 21 WETH of debt ($84k): 84% LTV under the modelled 87% USDC line.
  // ETH rises, the DEBT grows, and the LTV crosses the line at minute 3 (88.2%) — inside
  // what would have been the 4% band (90.48%), so a delayed position would open a window.
  const pos = legPosition([{ symbol: 'USDC', amount: 100_000, price: 1 }], {
    symbol: 'WETH',
    amount: 21,
    price: 4000,
  })
  const { path, unpriced } = ethRamp(40, 2)
  const cmp = runComparison(pos, path, unpriced, { ...baseOpts, venue: null })
  const ev = cmp.membrane.events
  assert.ok(!ev.some((e) => e.kind === 'breach'), 'no breach/window event: the class has no window')
  const first = ev[0]
  assert.ok(first && first.kind === 'liquidation', 'the first event is the sale')
  const line = membraneMaxLtv('USDC')!
  const crossed = path.series.WETH!.findIndex((p) => (21 * (p as number)) / 100_000 > line)
  assert.strictEqual(
    first.minute,
    crossed,
    `sold at the first minute over the ${line} line (minute ${crossed})`,
  )
  assert.ok(
    first.why.startsWith('No 8-hour window for this collateral — sold the minute LTV crossed'),
    'and says why',
  )
  assert.ok(
    cmp.membrane.caveats.some((c) => c.startsWith('Stablecoin collateral: no 8-hour window')),
    'the run states the class as a caveat',
  )
  assert.ok(
    !cmp.membrane.caveats.some((c) => c.startsWith('The cure window is conditional')),
    'and does not claim a window it does not have',
  )
})

/** ETH flat at 4000, then a step to `to` at minute `at` that holds. */
function ethStep(count: number, at: number, to: number) {
  const eth = Array.from({ length: count }, (_, i) => (i < at ? 4000 : to))
  return buildPricePath(
    {
      startTs: 1_760_054_400,
      stepSeconds: 60,
      count,
      columns: { ethOracle: eth, btcOracle: eth.map(() => 100_000) },
      carried: {},
    },
    fakeManifest,
    ['USDC', 'WETH'],
  )
}
const venueOf = (deployedUsd: number, recallRate = 1, fastRate = 1) => ({
  recallRate,
  fastRate,
  deployedUsd,
  provenance: {} as never,
})

test('Run D: a no-window position that the venue brings under its line sells nothing', () => {
  // $100k USDC against 21 WETH of debt. ETH steps 4000 -> 4200 at minute 3: debt $88.2k,
  // LTV 88.2% over the 87% USDC line. The venue returns $12.5k: LTV 75.7%, under the line.
  // Contract: Step 1.5 recalls, Step 2.5 sees LTV <= line -> recall-only lane. Paid, unsold.
  const pos = legPosition([{ symbol: 'USDC', amount: 100_000, price: 1 }], {
    symbol: 'WETH',
    amount: 21,
    price: 4000,
  })
  const { path, unpriced } = ethStep(30, 3, 4200)
  const cmp = runComparison(pos, path, unpriced, { ...baseOpts, venue: venueOf(12_500) })
  const ev = cmp.membrane.events
  assert.strictEqual(ev.length, 1, 'one call')
  assert.strictEqual(ev[0].kind, 'recall')
  assert.strictEqual(ev[0].minute, 3, 'at the minute the line was crossed')
  close(ev[0].ltv, (88_200 - 12_500) / (100_000 - ev[0].penaltyUsd), 'LTV ~75.7% afterwards', 1e-9)
  const targetPre = membraneRepayValue(88_200, 100_000, 0.84, LIQ_DEBT_MINIMUM_USD)
  close(
    ev[0].penaltyUsd,
    baseOpts.membraneLiqFee * Math.min(targetPre, 12_500),
    'fee on min(target at the pre-recall state, recalled)',
    1e-6,
  )
  close(ev[0].seizedUsd, ev[0].penaltyUsd, 'the fee is the only collateral that leaves', 1e-9)
  assert.ok(
    cmp.membrane.caveats.some((c) => c.includes('higher than before')),
    'the un-modelled post-check is a stated caveat',
  )
})

test('Run E: a delayed position the venue cures at the breach never opens a window', () => {
  // 100 WETH at $4,000 against $300k: ETH -7% at minute 2 puts LTV at 80.6%, over the 80%
  // line. The breach call recalls $20k first: LTV 75.3%, under the line -> recall-only lane
  // at that minute. No timer, no 8-hour hold, nothing sold.
  const { path, unpriced } = bandPath(0.07, 600, false)
  const cmp = runComparison(bandPosition(), path, unpriced, { ...baseOpts, venue: venueOf(20_000) })
  const ev = cmp.membrane.events
  assert.strictEqual(ev.length, 1, 'one call')
  assert.strictEqual(ev[0].kind, 'recall')
  assert.strictEqual(ev[0].minute, 2, 'at the first breach')
  assert.ok(!ev.some((e) => e.kind === 'breach'), 'no window was opened')
  const targetPre = membraneRepayValue(300_000, 372_000, 0.77, LIQ_DEBT_MINIMUM_USD)
  close(ev[0].penaltyUsd, baseOpts.membraneLiqFee * Math.min(targetPre, 20_000), 'the fee', 1e-6)
})

test('Run F: an underwater position and a deep venue take the lane ONCE, with one fee', () => {
  // ETH halves at minute 3: $300k of debt against $200k of collateral, 150% LTV. The venue
  // repays the whole debt in the one call, so the lane fires once — never a second fee.
  const { path, unpriced } = bandPath(0.5, 60, false)
  const cmp = runComparison(bandPosition(), path, unpriced, {
    ...baseOpts,
    venue: venueOf(1_000_000),
  })
  const ev = cmp.membrane.events
  assert.strictEqual(ev.length, 1, 'one call')
  assert.strictEqual(ev[0].kind, 'recall')
  close(ev[0].recalledUsd, 300_000, 'the whole debt', 1e-6)
  close(cmp.membrane.endDebtUsd, 0, 'repaid', 1e-6)
  const targetPre = membraneRepayValue(300_000, 200_000, 0.77, LIQ_DEBT_MINIMUM_USD)
  close(
    cmp.membrane.penaltyPaidUsd,
    baseOpts.membraneLiqFee * Math.min(targetPre, 300_000),
    'one fee, on the target',
    1e-6,
  )
})

// Venue inputs below are ones the page can produce: fastRate <= recallRate
// (components/Simulator/Controls.tsx:301-313).
test('a cooldown venue (sUSDe: recall 0.3, fast 0) returns nothing at the breach and charges nothing', () => {
  // The review run: a price-cured breach. Nothing is there to recall at the breach (fast 0),
  // so no recall, no fee — the window opens and the price cures it in 30 minutes. It used to
  // recall $12,000 at the breach minute and charge $600.
  const { path, unpriced } = bandPath(0.07, 30, true)
  const sUSDe = venueOf(40_000, 0.3, 0)
  const withVenue = runComparison(bandPosition(), path, unpriced, { ...baseOpts, venue: sUSDe })
  const without = runComparison(bandPosition(), path, unpriced, { ...baseOpts, venue: null })
  assert.deepStrictEqual(
    withVenue.membrane.events.map((e) => e.kind),
    ['breach'],
    'the window opens; nothing is recalled, sold or charged',
  )
  close(withVenue.membrane.penaltyPaidUsd, 0, 'no fee', 1e-12)
  close(withVenue.membrane.endDeployedUsd, 40_000, 'the venue is untouched', 1e-9)
  close(
    withVenue.membrane.endEquityUsd,
    without.membrane.endEquityUsd + 40_000,
    'the run is the no-venue run plus the capital still deployed',
    1e-6,
  )
})

test('a sale after a partial recall is sized the contract’s way (Step 2 on the pre-recall loan)', () => {
  // The review example: debt $100k, collateral $110k, line 87% (cap 84%), $2k recalled.
  // _getRepayQuantities reads the PRE-recall totalDebt (LiquidationEngine.sol:1311, :2671)
  // and the POST-recall LTV (:1554); the sell wall covers target - totalRepaid (:2261).
  const lPost = 98_000 / 110_000
  const target = ((lPost - 0.84) / lPost / (1 - 0.84)) * 100_000
  const sold = membraneSaleAfterRecall(100_000, 110_000, 0.84, 2_000, LIQ_DEBT_MINIMUM_USD)
  close(
    sold,
    target - 2_000,
    'target at the post-recall LTV on the pre-recall loan, less the recall',
    1e-6,
  )
  close(
    sold,
    33_714.2857142857,
    '$33,714 — not the $35,000 a restore-to-cap on the reduced loan gives',
    1e-6,
  )
  close(
    membraneRepayValue(98_000, 110_000, 0.84, LIQ_DEBT_MINIMUM_USD),
    35_000,
    'the old sizing',
    1e-6,
  )
  // Nothing recalled: exactly the ordinary repay.
  close(
    membraneSaleAfterRecall(100_000, 110_000, 0.84, 0, LIQ_DEBT_MINIMUM_USD),
    membraneRepayValue(100_000, 110_000, 0.84, LIQ_DEBT_MINIMUM_USD),
    'no recall: the ordinary repay-to-cap',
    1e-9,
  )
  // Still underwater after the recall: the whole loan is the target (:2673-2688).
  close(membraneSaleAfterRecall(100_000, 80_000, 0.84, 5_000, 0), 95_000, 'underwater', 1e-9)
})

test('the breach draws only the fast share; the sale that ends the window draws up to the recall rate', () => {
  // 7% drop: 300k / 372k = 80.6% over the 80% line. Fast share $500 at the breach:
  // 299.5k / 372k is still over the line, so the recall stays and the window opens. At
  // expiry the window ends and the slower capital is there: up to $1,000 in all.
  const { path, unpriced } = bandPath(0.07, 600, false)
  const cmp = runComparison(bandPosition(), path, unpriced, {
    ...baseOpts,
    venue: venueOf(1_000, 1, 0.5),
  })
  const ev = cmp.membrane.events
  const expiry = 2 + Math.round(CURE_WINDOW_SECONDS / 60)
  assert.deepStrictEqual(
    ev.map((e) => [e.minute, e.kind]),
    [
      [2, 'recall'],
      [2, 'breach'],
      [expiry, 'liquidation'],
    ],
    'recall, window, sale at expiry',
  )
  close(ev[0].recalledUsd, 500, 'the fast share at the breach', 1e-9)
  assert.strictEqual(ev[0].penaltyUsd, 0, 'no fee for the timer-start call')
  close(ev[2].recalledUsd, 500, 'the rest of the recall rate at the window-ending sale', 1e-9)
  // And what that sale took from collateral is the contract's remainder on the debt it
  // found at expiry ($299,500 after the breach recall), not a restore-to-cap on $299,000.
  const fromColl = ev[2].repaidUsd - ev[2].recalledUsd
  close(
    fromColl,
    membraneSaleAfterRecall(299_500, 372_000, 0.77, 500, LIQ_DEBT_MINIMUM_USD),
    'sold from collateral = target(post-recall LTV, pre-recall loan) - recalled',
    1e-6,
  )
  close(cmp.membrane.endDeployedUsd, 0, 'the venue is drawn to its recall rate', 1e-9)
})

test('a band break minutes after the breach draws only the fast share, not the recall rate', () => {
  // The common Oct 10 shape: breach in band at minute 2 (ETH 4000 -> 3720, LTV 80.6%), band
  // broken at minute 3 (ETH 3500, LTV 85.7% > 83.2%). A cooldown venue (recall 0.3, fast 0,
  // $40k) has had one minute, not the window: it returns nothing, and the band sale runs
  // exactly as with no venue at all. Only a sale at EXPIRY may draw the recall rate.
  const eth = [4000, 4000, 3720, ...new Array(60).fill(3500)]
  const { path, unpriced } = buildPricePath(
    {
      startTs: 1_760_054_400,
      stepSeconds: 60,
      count: eth.length,
      columns: { ethOracle: eth, btcOracle: eth.map(() => 100_000) },
      carried: {},
    },
    fakeManifest,
    ['WETH', 'USDC'],
  )
  const withVenue = runComparison(bandPosition(), path, unpriced, {
    ...baseOpts,
    venue: venueOf(40_000, 0.3, 0),
  })
  const noVenue = runComparison(bandPosition(), path, unpriced, { ...baseOpts, venue: null })
  const ev = withVenue.membrane.events
  assert.deepStrictEqual(
    ev.map((e) => [e.minute, e.kind]),
    [
      [2, 'breach'],
      [3, 'liquidation'],
    ],
    'breach, then the band sale — no recall, no recall-only lane',
  )
  assert.strictEqual(ev[1].recalledUsd, 0, 'nothing recalled at a band break one minute in')
  close(
    ev[1].seizedUsd,
    noVenue.membrane.events.find((e) => e.kind === 'liquidation')!.seizedUsd,
    'the band sale sells what it sells with no venue',
    1e-9,
  )
  close(withVenue.membrane.endDeployedUsd, 40_000, 'the cooldown capital stays deployed', 1e-9)
})

test('collateral wiped with debt left and no venue: no $0 events, never a "recall"', () => {
  // $100k USDC against 21 WETH; ETH goes 4000 -> 40000 at minute 3: debt $840k. The sale
  // takes all the collateral and debt is left. Every later minute is still over the line
  // with nothing to sell and nothing to recall — the walk must stay silent.
  const pos = legPosition([{ symbol: 'USDC', amount: 100_000, price: 1 }], {
    symbol: 'WETH',
    amount: 21,
    price: 4000,
  })
  const { path, unpriced } = ethStep(40, 3, 40_000)
  const cmp = runComparison(pos, path, unpriced, { ...baseOpts, venue: null })
  const ev = cmp.membrane.events
  assert.deepStrictEqual(
    ev.map((e) => [e.minute, e.kind]),
    [[3, 'liquidation']],
    'one sale, then nothing',
  )
  close(cmp.membrane.endCollateralUsd, 0, 'the collateral is gone', 1e-6)
  assert.ok(cmp.membrane.endDebtUsd > 0, 'debt is left')
  assert.ok(
    !ev.some((e) => e.repaidUsd === 0 && e.seizedUsd === 0 && e.penaltyUsd === 0),
    'no $0 event',
  )
  assert.ok(!ev.some((e) => e.kind === 'recall'), 'no recall without a venue')
})

test('fastRate is not inert: at the page’s fast = recall the breach call can cure', () => {
  // Same drop, $20k deployed. fast 0 -> the window runs and the recall cures it only when
  // the window ends; fast = recall -> the recall-only lane at the breach.
  const { path, unpriced } = bandPath(0.07, 600, false)
  const slow = runComparison(bandPosition(), path, unpriced, {
    ...baseOpts,
    venue: venueOf(20_000, 1, 0),
  })
  const fast = runComparison(bandPosition(), path, unpriced, {
    ...baseOpts,
    venue: venueOf(20_000, 1, 1),
  })
  assert.deepStrictEqual(
    fast.membrane.events.map((e) => e.kind),
    ['recall'],
    'cured at the breach',
  )
  const expiry = 2 + Math.round(CURE_WINDOW_SECONDS / 60)
  assert.deepStrictEqual(
    slow.membrane.events.map((e) => [e.minute, e.kind]),
    [
      [2, 'breach'],
      [expiry, 'recall'],
    ],
    'the slow venue waits out the window and cures at its end',
  )
})

test('a mixed position is split into the two positions Membrane would hold', () => {
  // $200k WETH + $100k USDC against $210k USDC debt: 70% LTV. Membrane refuses one
  // position holding both classes (Cdp.sol:1650-1651), so it is modelled as two.
  const pos = legPosition(
    [
      { symbol: 'WETH', amount: 50, price: 4000 },
      { symbol: 'USDC', amount: 100_000, price: 1 },
    ],
    { symbol: 'USDC', amount: 210_000, price: 1 },
  )
  const flat = ethRamp(30, 30)
  const { subs, shares } = splitByDelayClass(pos, flat.path, { ...baseOpts, venue: null })
  assert.strictEqual(subs.length, 2, 'two isolated positions')
  close(shares[0] + shares[1], 1, 'the shares are a partition')
  close(
    subs.reduce((a, s) => a + s.debt[0].amount, 0),
    210_000,
    'and the two debts sum to the original',
    1e-6,
  )
  assert.deepStrictEqual(
    subs.map((s) => s.noDelay),
    [true, false],
    'stable half no-delay, volatile half delayed',
  )
  for (const s of subs) {
    const c = s.collateral.reduce((a, l) => a + l.amount * l.priceUsd, 0)
    close(s.debt[0].amount / c, 0.7, `${s.label} opens at the position's own LTV`, 1e-9)
  }
  close(subs[0].line, membraneMaxLtv('USDC')!, 'each half takes its own line', 1e-12)
  close(subs[1].line, membraneMaxLtv('WETH')!, 'each half takes its own line', 1e-12)

  // On a calm path nothing happens and the halves recombine exactly.
  const calm = runComparison(pos, flat.path, flat.unpriced, { ...baseOpts, venue: null })
  assert.strictEqual(calm.membrane.events.length, 0)
  close(calm.membrane.endDebtUsd, 210_000, 'the split loses no debt', 1e-6)
  close(calm.membrane.startEquityUsd, calm.source.startEquityUsd, 'nor any equity', 1e-6)
  assert.ok(
    calm.membrane.caveats.some((c) => c.startsWith('Two positions (modelled)')),
    'the split is stated as modelled',
  )
  assert.ok(
    !calm.membrane.caveats.some(
      (c) => /no-delay|MixedDelayClass|class/i.test(c) && c.includes('Two'),
    ),
    'in the reader’s words, not the contract’s',
  )

  // A crash sells only the volatile half; the stable half never crosses its line.
  const { path, unpriced } = crashPath()
  const crash = runComparison(pos, path, unpriced, { ...baseOpts, venue: null })
  const sales = crash.membrane.events.filter((e) => e.kind === 'liquidation')
  assert.ok(sales.length > 0, 'the WETH half is sold')
  assert.ok(
    sales.every((e) => e.why.startsWith('WETH (8-hour window within 4%)')),
    'and only the WETH half',
  )
  assert.ok(
    crash.membrane.events.some((e) => e.kind === 'breach'),
    'the WETH half had its window',
  )
})

test('the page’s call shape runs each half at its OWN line, not the blend', () => {
  // components/Simulator/Simulator.tsx and scripts/select-demo-borrower.ts ALWAYS pass a
  // line override: the blended whole-position line by default. Both halves must still run
  // at their own modelled lines (USDC 87%, WETH 80%), not at the ~82% blend.
  const pos = legPosition(
    [
      { symbol: 'WETH', amount: 50, price: 4000 },
      { symbol: 'USDC', amount: 100_000, price: 1 },
    ],
    { symbol: 'USDC', amount: 210_000, price: 1 },
  )
  const flat = ethRamp(30, 30)
  const blended = weightedMembraneLine(pos.collateral).maxLtv
  assert.ok(blended > 0.8 && blended < 0.87, `the blend is between the two (${blended})`)
  const pageCall = { ...baseOpts, venue: null, membraneMaxLtv: blended }
  const { subs } = splitByDelayClass(pos, flat.path, pageCall)
  close(subs[0].line, 0.87, 'the USDC half runs at its own 87%', 1e-12)
  close(subs[1].line, 0.8, 'the WETH half runs at its own 80%', 1e-12)
  // A user edit moves both halves by the same factor.
  const edited = splitByDelayClass(pos, flat.path, { ...pageCall, membraneMaxLtv: blended * 1.05 })
  close(edited.subs[0].line, 0.87 * 1.05, 'USDC half scaled', 1e-12)
  close(edited.subs[1].line, 0.8 * 1.05, 'WETH half scaled', 1e-12)
  // A URL ?ltv above 90% cannot lift the WETH half past its class cap — and its label is
  // read off the class it actually runs in.
  const url = splitByDelayClass(pos, flat.path, { ...pageCall, membraneMaxLtv: 0.95 })
  close(url.subs[1].line, MAX_LTV_HARD_CAP, 'the WETH half stops at 90%', 1e-12)
  assert.strictEqual(url.subs[1].noDelay, false, 'so it keeps its window')
  assert.ok(url.subs[1].label!.startsWith('WETH (8-hour window'), 'and is labelled so')
  assert.ok(url.subs[0].line <= NO_DELAY_LTV_HARD_CAP, 'the stable half stops at 96%')
  // And the run itself uses those lines.
  const cmp = runComparison(pos, crashPath().path, crashPath().unpriced, pageCall)
  const wethEvents = cmp.membrane.events.filter((e) => e.why.startsWith('WETH'))
  assert.ok(wethEvents.length > 0 && wethEvents.every((e) => Math.abs(e.line - 0.8) < 1e-12))
})

test('a half with no modelled LTV runs at the whole line and says so (WETH + GHO)', () => {
  // GHO is a stable with no MEMBRANE_ASSET_LTV entry. Its half used to get line 0 and be
  // sold at minute 0.
  const pos = legPosition(
    [
      { symbol: 'WETH', amount: 50, price: 4000 },
      { symbol: 'GHO', amount: 100_000, price: 1 },
    ],
    { symbol: 'USDC', amount: 210_000, price: 1 },
  )
  const symbols = ['WETH', 'GHO', 'USDC']
  const flat = buildPricePath(
    {
      startTs: 0,
      stepSeconds: 60,
      count: 30,
      columns: { ethOracle: new Array(30).fill(4000), btcOracle: new Array(30).fill(100_000) },
      carried: {},
    },
    fakeManifest,
    symbols,
  )
  const blended = weightedMembraneLine(pos.collateral).maxLtv
  const opts = { ...baseOpts, venue: null, membraneMaxLtv: blended }
  const { subs } = splitByDelayClass(pos, flat.path, opts)
  const gho = subs.find((x) => x.collateral[0].symbol === 'GHO')!
  assert.strictEqual(gho.lineFromWhole, true, 'GHO has no line of its own')
  close(gho.line, blended, 'so it runs at the whole position’s line', 1e-12)
  const cmp = runComparison(pos, flat.path, flat.unpriced, opts)
  assert.strictEqual(cmp.membrane.events.length, 0, 'and is not sold at minute 0 on a calm path')
  assert.ok(
    cmp.membrane.caveats.some((c) => c.startsWith('No modelled max LTV exists for GHO')),
    'the fallback is stated',
  )
})

// ================================================== adapter parsing helpers
test('parseAddress accepts only real addresses', () => {
  assert.strictEqual(parseAddress('0x' + 'a'.repeat(40)), '0x' + 'a'.repeat(40))
  assert.strictEqual(
    parseAddress('  0x' + 'A'.repeat(40) + ' '),
    '0x' + 'a'.repeat(40),
    'trimmed and lowercased',
  )
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
  assert.strictEqual(
    ratio(100, 0),
    Number.POSITIVE_INFINITY,
    'no debt -> infinite health, not 1e59',
  )
  close(ratio(50, 100), 0.5, 'ordinary ratio')
})

test('decimalsFromScale rejects a scale that is not a power of ten', () => {
  assert.strictEqual(decimalsFromScale(10n ** 18n, 'x'), 18)
  assert.strictEqual(decimalsFromScale(10n ** 6n, 'x'), 6)
  assert.strictEqual(decimalsFromScale(1n, 'x'), 0)
  assert.throws(
    () => decimalsFromScale(3n, 'WEIRD'),
    /WEIRD/,
    'throws naming the asset rather than guessing',
  )
})

test('mulDivUp rounds up — Morpho debt must never round in the borrower’s favour', () => {
  assert.strictEqual(mulDivUp(10n, 10n, 3n), 34n, '100/3 rounds up to 34')
  assert.strictEqual(mulDivUp(10n, 10n, 5n), 20n, 'exact division does not round up')
  assert.strictEqual(mulDivUp(0n, 10n, 3n), 0n, 'zero stays zero')
})

test('unwrap throws with the failing call named; optional swallows it', () => {
  assert.strictEqual(unwrap({ status: 'success', result: 7 }, 'x'), 7)
  assert.throws(
    () => unwrap({ status: 'failure', error: new Error('rpc down') }, 'Pool.getUserAccountData()'),
    /getUserAccountData/,
  )
  assert.throws(() => unwrap(undefined, 'MissingCall()'), /MissingCall/)
  assert.strictEqual(
    optional({ status: 'failure', error: new Error('x') }),
    null,
    'optional returns null',
  )
  assert.strictEqual(optional({ status: 'success', result: 9 }), 9)
})

test('UnsupportedError is distinguishable so a stub is not reported as a failure', () => {
  const e = new UnsupportedError('fluid enumeration not implemented')
  assert.ok(e instanceof UnsupportedError)
  assert.ok(e instanceof Error)
  assert.ok(e.message.includes('fluid'))
})

// ============================ the liqDebtMinimum floor, LiquidationEngine.sol:2241-2269
test('the debt floor escalates a sub-minimum chunk exactly as the contract does', () => {
  // repay >= dMin and a healthy remainder: untouched.
  close(applyDebtMinimum(5_000, 100_000, 2_000), 5_000, 'a normal chunk passes through')
  // repay < dMin, loan >= 2 x dMin: the chunk is lifted to dMin, remainder stays >= dMin.
  close(applyDebtMinimum(500, 100_000, 2_000), 2_000, 'sub-minimum chunk lifts to the floor')
  // loan < dMin: the whole loan goes.
  close(applyDebtMinimum(500, 1_500, 2_000), 1_500, 'a loan under the floor is closed whole')
  // dMin <= loan < 2 x dMin: lifting to dMin would strand a sub-minimum remainder.
  close(applyDebtMinimum(500, 3_000, 2_000), 3_000, 'a stranded remainder escalates to full')
  // The remainder guard: the chunk was already >= dMin but leaves too little behind.
  close(applyDebtMinimum(9_000, 10_000, 2_000), 10_000, 'remainder guard escalates to full')
  // Disabled.
  close(applyDebtMinimum(500, 100_000, 0), 500, 'liqDebtMinimum == 0 disables the floor')
  // The comparisons are strict `<`: a remainder EXACTLY at the minimum survives.
  close(applyDebtMinimum(8_000, 10_000, 2_000), 8_000, 'a remainder exactly at the floor stands')
})

test('membraneRepayValue routes its result through the floor', () => {
  // A tiny position: repay-to-cap would be a few dollars, so the floor closes it whole.
  const tiny = membraneRepayValue(1_000, 1_190, 0.77, LIQ_DEBT_MINIMUM_USD)
  close(tiny, 1_000, 'a $1,000 loan is closed whole under a $2,000 floor')
  // A solvent position is never escalated — the contract never reaches the floor there.
  close(membraneRepayValue(700, 10_000, 0.77, LIQ_DEBT_MINIMUM_USD), 0, 'solvent stays zero')
})

// ==================================== repeat sales: the contract re-arms after a repay
test('a repay restores the cap, so the walk can sell the same position again', () => {
  // Down 12%, back over the line, down again: one sale is not the whole episode.
  const ratios: number[] = []
  for (let i = 0; i < 1200; i++) {
    ratios.push(i < 20 ? 1 - i * 0.004 : i < 600 ? 0.93 : 0.93 - (i - 600) * 0.0004)
  }
  const common = {
    debtUsd: 1_000_000,
    collateralUsd: 1_250_000,
    line: 0.8,
    band: 0.04,
    delaySeconds: CURE_WINDOW_SECONDS,
    stepSeconds: 60,
    gap: BORROW_LTV_GAP,
    ratios,
  }
  const once = cureWalk({ ...common, maxSales: 1 })
  const many = cureWalk({ ...common, maxSales: 20 })
  assert.ok(many.sales >= once.sales, 'the cap only ever reduces the number of sales')
  assert.ok(many.closedUsd >= once.closedUsd - 1e-6, 'more sales never close less')
  assert.strictEqual(many.closedAtIndex, once.closedAtIndex, 'the FIRST sale is the same sale')
  assert.strictEqual(many.outcome, once.outcome, 'the outcome names the first sale either way')
})

// ============== the timer needs a CALL: the corner where nobody ever makes one
test('noEarlyClear never closes less than the instant-clear model', () => {
  const ratios: number[] = []
  for (let i = 0; i < 700; i++)
    ratios.push(i < 5 ? 1 - i * 0.008 : i < 60 ? 0.96 + i * 0.0006 : 1.01)
  const common = {
    debtUsd: 1_000_000,
    collateralUsd: 1_250_000,
    line: 0.8,
    band: 0.04,
    delaySeconds: 3600,
    stepSeconds: 60,
    gap: BORROW_LTV_GAP,
    ratios,
  }
  const instant = cureWalk(common)
  const never = cureWalk({ ...common, noEarlyClear: true })
  assert.ok(
    never.closedUsd >= instant.closedUsd - 1e-6,
    `an uncleared timer cannot help the borrower (${never.closedUsd} vs ${instant.closedUsd})`,
  )
})

// ================== ONE WALK: compare.ts and the census must agree on a real account
//
// compare.ts no longer reimplements the delay window — it drives the SAME DelayTimer
// state machine from curePath.ts, with recall and the fee layered on top. Set the
// deployed venue share to 0 and the fee to 0 and the two engines are the same engine,
// so a pasted address must land on its census row. These two accounts are the two
// branches that matter: one sold when it broke the band, one cured and was never sold.
const EVIDENCE = JSON.parse(fs.readFileSync('public/data/oct10-2025/evidence.json', 'utf8'))
const PRICES = JSON.parse(fs.readFileSync('public/data/oct10-2025/prices-1m.json', 'utf8'))

function replayCensusRow(row: any) {
  /**
   * UPDATED 2026-09-14: the census no longer prices every volatile leg off ethOracle.
   * wstETH has its own composite column (stETH/ETH x ETH/USD) and BTC-likes have
   * btcOracle, so the replay must read the SAME column the census read or the two engines
   * are being handed different prices. SYMBOL_TO_SERIES is that mapping, shared.
   */
  const column = SYMBOL_TO_SERIES[row.collSymbol]
  const eth: number[] = PRICES.columns[column] ?? PRICES.columns.ethOracle
  const i0: number = row.t0Index
  const count = eth.length - i0
  // ANCHOR: the census no longer opens on the grid cell at t0 — it opens on `pLiqColl`,
  // the round that was in force IN THE LIQUIDATING BLOCK, and reads grid minutes (each
  // the round in force at that minute's START) from t0+1. Feed the live engine the same
  // path or the two engines are being asked different questions at minute 0.
  const p0: number = row.pLiqColl ?? eth[i0]
  const path: PricePath = {
    startTs: PRICES.startTs + i0 * PRICES.stepSeconds,
    stepSeconds: PRICES.stepSeconds,
    count,
    // The census prices this account's collateral leg off its own oracle column and holds
    // its stable debt at 1. Feed the live engine exactly that, nothing else.
    series: {
      [row.collSymbol]: [p0, ...eth.slice(i0 + 1)],
      [row.debtSymbol]: new Array<number | null>(count).fill(1),
    },
    provenance: stamp('dataset', 'oct10 census replay', 'test'),
  }
  const position: ProtocolPosition = {
    protocol: 'aave-v3',
    label: 'Aave V3',
    collateral: [
      {
        symbol: row.collSymbol,
        address: '0x0',
        decimals: 18,
        amount: row.collateralUsd / p0,
        priceUsd: p0,
        valueUsd: row.collateralUsd,
        liquidationThreshold: row.liqLine,
        maxLtv: row.liqLine - BORROW_LTV_GAP,
        liquidationBonus: 0,
      },
    ],
    debt: [
      {
        symbol: row.debtSymbol,
        address: '0x1',
        decimals: 6,
        amount: row.debtUsd,
        priceUsd: 1,
        valueUsd: row.debtUsd,
        borrowApr: null,
      },
    ],
    totalCollateralUsd: row.collateralUsd,
    totalDebtUsd: row.debtUsd,
    ltv: row.ltv0,
    liquidationLtv: row.liqLine,
    healthFactor: row.liqLine / row.ltv0,
    provenance: stamp('onchain', 'oct10 census row', row.user),
  }
  const cmp = runComparison(position, path, [], {
    membraneMaxLtv: row.liqLine,
    membraneLiqFee: 0, // fee off: the census charges none
    venue: null, // deployedShare 0: no recall in the census either
    sourceRepayFraction: 0.578,
    sourceRepayFractionLabel: '57.8%',
    scenarioLabel: 'oct10',
    debtMinimumUsd: LIQ_DEBT_MINIMUM_USD,
  })
  const sales = cmp.membrane.events.filter((e) => e.repaidUsd > 0)
  return {
    closedUsd: sales.reduce((s, e) => s + e.repaidUsd, 0),
    firstSaleMinute: sales.length ? sales[0].minute : null,
    saleCount: sales.length,
    breaches: cmp.membrane.events.filter((e) => e.kind === 'breach').length,
  }
}

test('0x4d43aa… is EXCLUDED: Aave priced wstETH off the wrap rate, not the depeg', () => {
  // UPDATED twice, and the second update reverses the first.
  //
  // (a) While wstETH was ETH-proxied this account (wstETH/USDC, $31M debt) was EXCLUDED:
  //     the ETH round in its liquidating block was 4.06% ABOVE the snapshot round, which
  //     rebased its LTV from 0.826 to 0.794 - under its own 0.81 line - while Aave was
  //     liquidating it in that very block.
  // (b) Pricing it through the STETH/ETH MARKET feed shrank that up-move to ~1.3% and let
  //     the row back in. That looked like a fix and was not one: Aave never priced wstETH
  //     through that feed. Aave's own per-block prices give wstETH/WETH = 1.21598891 to 8
  //     decimals across blocks over which the market feed moved 0.99960 -> 0.96171, so
  //     Aave's wstETH path IS the ETH path times a constant.
  // (c) So the up-move is 4.06% again and the row is excluded again - and this time the
  //     exclusion is the measured answer rather than a proxy artefact. The census cannot
  //     locate a breach for it, and says so instead of crediting Membrane with $0 closed.
  const row = EVIDENCE.cohort.find((r: any) => r.user.startsWith('0x4d43aa'))
  assert.ok(row, 'the account is still in the cohort')
  assert.strictEqual(row.collSymbol, 'wstETH', 'it is the wstETH exemplar')
  assert.strictEqual(row.collClass, 'exact', 'and it is priced exactly, not proxied')
  assert.strictEqual(row.excluded, true, 'its breach is not locatable, so it is excluded')
  assert.ok(
    row.rebaseColl > 1.04 && row.rebaseColl < 1.05,
    `the up-move is the ETH one (${row.rebaseColl}), because the wrap rate is a constant`,
  )
  assert.ok(row.ltv0Snapshot > row.liqLine, 'the raw snapshot had it breached')
  assert.ok(row.ltv0 < row.liqLine, 'and the rebase takes it back under its own line')
  // The market-feed reading is not deleted, it is PRICED - and it is worth eight figures.
  const sens = EVIDENCE.meta.sensitivity.wstethMarketFeedMembraneClosedUsd
  assert.ok(sens, 'the market-feed sensitivity is published')
  assert.ok(
    sens.pricedDeltaUsd > 25_000_000,
    `pricing wstETH off the market feed adds $${(sens.pricedDeltaUsd / 1e6).toFixed(1)}M to the priced total`,
  )
})

test('compare.ts reproduces a census sold-at-band row within 1%', () => {
  // EXEMPLAR CHANGED (2026-09-14). This used to be 0x53996878. Once breach is decided at
  // BLOCK level rather than from a minute cell, that account is excluded: its health
  // factor at block N-1 is 1.0015 and no Chainlink round landed in its liquidating block,
  // so no breach can be located for it at all. 0x2b5fe212 is the largest INCLUDED
  // sold-at-band row (mainnet, WETH/USDT, $2.5M debt) and exercises the same branch.
  const row = EVIDENCE.cohort.find((r: any) => r.user.startsWith('0x2b5fe212') && !r.excluded)
  assert.ok(row, 'the account is in the census')
  assert.strictEqual(row.outcome, 'sold-at-band', 'the census says it broke the band')
  const live = replayCensusRow(row)
  assert.strictEqual(
    live.firstSaleMinute,
    row.closedAtIndex,
    `same sale minute (live ${live.firstSaleMinute}, census ${row.closedAtIndex})`,
  )
  const rel = Math.abs(live.closedUsd - row.membraneClosedUsd) / row.membraneClosedUsd
  assert.ok(
    rel < 0.01,
    `closed USD within 1%: live ${live.closedUsd.toFixed(0)} vs census ${row.membraneClosedUsd} (${(100 * rel).toFixed(3)}%)`,
  )
  console.log(
    `        [agreement] 0x2b5fe212 sold-at-band: live $${live.closedUsd.toFixed(0)} vs census $${row.membraneClosedUsd} (${(100 * rel).toFixed(4)}%), minute ${live.firstSaleMinute}`,
  )
})

test('compare.ts reproduces a census row that was sold TWICE', () => {
  // The repeat-sale path is the one the old compare.ts throttle and the old one-sale
  // cap both got wrong, so it gets its own agreement check.
  // EXEMPLAR CHANGED (2026-09-14): 0x588f9674 is excluded once a round in the liquidating
  // block only counts when its log_index precedes the LiquidationCall's. 0xf83d2d61 is the
  // largest INCLUDED two-sale row (mainnet, WETH/USDC, $410k debt) and exercises the same
  // re-arm branch.
  const row = EVIDENCE.cohort.find((r: any) => r.user.startsWith('0xf83d2d61') && !r.excluded)
  assert.ok(row, 'the account is in the census')
  assert.strictEqual(row.sales, 2, 'the census sold it twice')
  const live = replayCensusRow(row)
  assert.strictEqual(live.saleCount, row.sales, `same number of sales (${live.saleCount})`)
  assert.strictEqual(live.firstSaleMinute, row.closedAtIndex, 'same first sale minute')
  const rel = Math.abs(live.closedUsd - row.membraneClosedUsd) / row.membraneClosedUsd
  assert.ok(
    rel < 0.01,
    `closed USD within 1%: live ${live.closedUsd.toFixed(0)} vs census ${row.membraneClosedUsd} (${(100 * rel).toFixed(3)}%)`,
  )
  console.log(
    `        [agreement] 0xf83d2d61 two sales: live $${live.closedUsd.toFixed(0)} vs census $${row.membraneClosedUsd} (${(100 * rel).toFixed(4)}%), ${live.saleCount} sales`,
  )
})

test('compare.ts reproduces a census cured-then-held row (0xa740c1…, wstETH)', () => {
  // EXEMPLAR RESTORED (2026-09-14). This was 0xa740c1, then moved to 0x4d43aa while
  // wstETH was priced through the STETH/ETH market feed (which broke 0xa740c1 out of the
  // 4% band), and is 0xa740c1 again now that wstETH is priced through the measured wrap
  // rate - which is what Aave actually did. It is the largest row that opens a window and
  // never sells, and it is a wstETH row, so it doubles as the check that the wstETH column
  // reaches the live engine.
  const row = EVIDENCE.cohort.find(
    (r: any) => r.user.startsWith('0xa740c1') && r.outcome === 'cured-then-held',
  )
  assert.ok(row, 'the account is in the census')
  assert.ok(!row.excluded, 'the account is not one of the excluded rows')
  assert.strictEqual(row.collSymbol, 'wstETH', 'and it is the wstETH exemplar')
  assert.strictEqual(row.membraneClosedUsd, 0, 'the census closed nothing on it')
  const live = replayCensusRow(row)
  assert.strictEqual(
    live.saleCount,
    0,
    `the live engine sold nothing too (sold ${live.saleCount}x)`,
  )
  close(live.closedUsd, 0, 'closed USD agrees at zero')
  assert.ok(live.breaches > 0, 'it did open a window — it just never sold')
})

// ============ THE DEMO FIXTURE MUST BE THE POSITION THE WALLET ACTUALLY HELD
//
// public/data/demo-borrower.json is what the borrower hero opens on, and the hero walks
// it from minute 0 of the two-day path. So the token amounts in it are load-bearing: the
// price at which the collateral crosses the line is debt / (amount x line), and that is
// the only thing that decides WHEN the hero's wallet breaks.
//
// THE BUG THIS PINS (fixed 2026-09-14). The selector used to derive the amount as the
// measured USD over the MINUTE-0 oracle price. Those dollars were not read at minute 0 —
// the census reads each account at its own liquidating block, so `collateralUsd` is
// already `snapshot x pLiqColl / pStateColl`. Dividing by the midnight price back-solved
// an amount that reproduced the LIQUIDATING LTV AT MIDNIGHT: the fixture opened breached,
// 21 hours before the wallet breached, and the live engine sold it three times across the
// day where its census row records one sale. The anchor is pLiqColl and nothing else.
const DEMO = JSON.parse(fs.readFileSync('public/data/demo-borrower.json', 'utf8'))
const MANIFEST = JSON.parse(fs.readFileSync('public/data/oct10-2025/manifest.json', 'utf8'))
const PROTOCOLS = JSON.parse(fs.readFileSync('public/data/oct10-2025/protocols.json', 'utf8'))

/**
 * The demo fixture's own census row, matched by address. 2026-10-16: the fixture is
 * selected from the FULL on-chain census (scripts/select-demo-borrower.ts), so its row is
 * read from the served census, public/data/oct10-2025/evidence-census.json — the mainnet
 * Aave V3 Core position of that owner. The census publishes dollars, not the prices they
 * were read at, so pLiqColl / pLiqDebt come from the fixture's own row, and the fixture's
 * dollars are checked against the census's to the cent below.
 */
const CENSUS_FILE = JSON.parse(
  fs.readFileSync('public/data/oct10-2025/evidence-census.json', 'utf8'),
)
const CENSUS_ROW: Record<string, any> | null = (() => {
  const cols: string[] = CENSUS_FILE.cohort.columns
  const at = (k: string) => cols.indexOf(k)
  const v = (CENSUS_FILE.cohort.rows as any[][]).find(
    (x) =>
      x[at('protocol')] === 'aave' &&
      x[at('chain')] === 'mainnet' &&
      x[at('market')] === 'core' &&
      x[at('owner')] === String(DEMO.address).toLowerCase(),
  )
  return v ? Object.fromEntries(cols.map((k, i) => [k, v[i]])) : null
})()
const demoRow: any = CENSUS_ROW && {
  user: CENSUS_ROW.owner as string,
  t0Index: CENSUS_ROW.t0Minute as number,
  outcome: CENSUS_ROW.outcome as string,
  aaveClosedUsd: CENSUS_ROW.realRepaidUsd as number,
  membraneClosedUsd: CENSUS_ROW.memRepaidUsd as number,
  closedAtIndex:
    CENSUS_ROW.firstSaleMinute == null
      ? null
      : (CENSUS_ROW.firstSaleMinute as number) - (CENSUS_ROW.t0Minute as number),
  liqLine: CENSUS_ROW.line as number,
  /** Membrane's line-sized t0 debt over the real one (memLine / protocolLine). */
  debtScale: (CENSUS_ROW.memDebtUsd as number) / (CENSUS_ROW.debtUsd as number),
  sales: CENSUS_ROW.sales as number,
  collateralUsd: DEMO.row.collateralUsd as number,
  debtUsd: DEMO.row.debtUsd as number,
  pLiqColl: DEMO.row.pLiqColl as number,
  pLiqDebt: DEMO.row.pLiqDebt as number,
}

test('the demo fixture row carries the census dollars, to the cent', () => {
  assert.ok(CENSUS_ROW, 'the fixture address is a mainnet Aave V3 Core position in the census')
  assert.strictEqual(
    Math.round(DEMO.row.collateralUsd * 100) / 100,
    CENSUS_ROW!.collUsd,
    'collateral USD',
  )
  assert.strictEqual(Math.round(DEMO.row.debtUsd * 100) / 100, CENSUS_ROW!.debtUsd, 'debt USD')
  assert.strictEqual(CENSUS_ROW!.coll.length, 1, 'one collateral leg, as the fixture has')
  assert.strictEqual(CENSUS_ROW!.debt.length, 1, 'one debt leg, as the fixture has')
})

/**
 * The fixture position run through the page's own engine over the FULL path, from minute
 * 0 — which is what the hero does — with the census's own settings: no venue, no fee, and
 * Membrane held at the account's measured line. Those are the only three knobs that make
 * the two engines the same engine, so anything left over is the fixture, not the model.
 */
function runDemoFixture(membraneMaxLtv: number, debtScale = 1) {
  // debtScale: the census walks Membrane on the debt sized to its line (debt0 x memLine /
  // protocolLine, owner ruling 2026-10-18). Only Membrane's side reads the scaled run.
  const base = DEMO.position as ProtocolPosition
  const position: ProtocolPosition =
    debtScale === 1
      ? base
      : {
          ...base,
          debt: base.debt.map((d) => ({
            ...d,
            amount: d.amount * debtScale,
            valueUsd: d.valueUsd * debtScale,
          })),
          totalDebtUsd: base.totalDebtUsd * debtScale,
          ltv: base.ltv * debtScale,
          healthFactor: base.liquidationLtv / (base.ltv * debtScale),
        }
  const symbols = [
    ...position.collateral.map((c) => c.symbol),
    ...position.debt.map((d) => d.symbol),
  ]
  const { path, unpriced } = buildPricePath(
    PRICES as Oct10Series,
    MANIFEST as Oct10Manifest,
    symbols,
  )
  const repay = measuredRepayFraction(position.protocol, PROTOCOLS.measuredLiquidations)
  const cmp = runComparison(position, path, unpriced, {
    membraneMaxLtv,
    membraneLiqFee: 0,
    venue: null,
    sourceRepayFraction: repay.fraction,
    sourceRepayFractionLabel: repay.label,
    scenarioLabel: 'oct10',
  })
  const sales = cmp.membrane.events.filter((e) => e.repaidUsd > 0)
  const srcLiq = cmp.source.events.filter((e) => e.kind === 'liquidation')
  return {
    cmp,
    path,
    closedUsd: sales.reduce((a, e) => a + e.repaidUsd, 0),
    firstSaleMinute: sales.length ? sales[0].minute : null,
    saleCount: sales.length,
    sourceFirstMinute: srcLiq.length ? srcLiq[0].minute : null,
  }
}

test('the demo fixture carries the REAL token amount, anchored at pLiqColl', () => {
  assert.ok(demoRow, 'the fixture address is in the census')
  const c = DEMO.position.collateral[0]
  const d = DEMO.position.debt[0]
  close(c.amount, demoRow.collateralUsd / demoRow.pLiqColl, 'collateral amount', 1e-9)
  close(d.amount, demoRow.debtUsd / demoRow.pLiqDebt, 'debt amount', 1e-6)
  // …and it is NOT the old back-solve, which is what planted the breach at midnight.
  const oldBackSolve = demoRow.collateralUsd / c.priceUsd
  assert.ok(
    Math.abs(c.amount - oldBackSolve) / c.amount > 0.01,
    'and it is measurably not the minute-0 back-solve',
  )
  // The whole point: at minute 0 the wallet is healthy, exactly as it was at midnight.
  assert.ok(
    DEMO.position.ltv < DEMO.position.liquidationLtv,
    `LTV at 00:00 (${DEMO.position.ltv.toFixed(4)}) is under the line (${DEMO.position.liquidationLtv})`,
  )
  close(
    DEMO.position.ltv,
    (d.amount * d.priceUsd) / (c.amount * c.priceUsd),
    'LTV is the 00:00 valuation',
    1e-12,
  )
})

test('the demo fixture republishes its census row verbatim', () => {
  // The served census publishes dollars to the cent; the fixture keeps the census row's own
  // sums, so the two are compared on the cent.
  const c = (x: number) => Math.round(x * 100) / 100
  assert.strictEqual(DEMO.censusT0Index, demoRow.t0Index, 'censusT0Index')
  assert.strictEqual(DEMO.censusOutcome, demoRow.outcome, 'censusOutcome')
  assert.strictEqual(c(DEMO.censusAaveClosedUsd), demoRow.aaveClosedUsd, 'censusAaveClosedUsd')
  assert.strictEqual(
    c(DEMO.censusMembraneClosedUsd),
    demoRow.membraneClosedUsd,
    'censusMembraneClosedUsd',
  )
  assert.strictEqual(DEMO.censusClosedAtIndex, demoRow.closedAtIndex, 'censusClosedAtIndex')
  // the fixture's debt scale is the census row's (memDebtUsd is published to the cent)
  assert.ok(
    Math.abs(DEMO.censusMembraneDebtScale - demoRow.debtScale) < 1e-6,
    `debt scale ${DEMO.censusMembraneDebtScale} vs ${demoRow.debtScale}`,
  )
  close(
    DEMO.censusMembraneDebtScale,
    DEMO.row.memLine / (CENSUS_ROW!.protocolLine as number),
    'memLine / protocolLine',
    1e-12,
  )
  // and the census says Membrane closes a smaller SHARE of its own debt than Aave of the real
  assert.ok(DEMO.censusMembraneClosedFrac < DEMO.censusAaveClosedFrac, 'a smaller share')
  close(DEMO.censusMembraneClosedFrac, CENSUS_ROW!.memFrac as number, 'Membrane share', 1e-5)
})

test('the live engine walking the fixture from minute 0 lands on its census sale', () => {
  // The census counts minutes from t0; the live engine counts them from midnight. The
  // census sale is therefore at path minute t0Index + closedAtIndex.
  const expected = demoRow.t0Index + demoRow.closedAtIndex
  const live = runDemoFixture(demoRow.liqLine, demoRow.debtScale)
  assert.ok(live.firstSaleMinute !== null, 'the live engine sold it too')
  assert.ok(
    Math.abs((live.firstSaleMinute as number) - expected) <= 2,
    `first sale within 2 minutes of the census (live ${live.firstSaleMinute}, census ${expected})`,
  )
  const rel = Math.abs(live.closedUsd - demoRow.membraneClosedUsd) / demoRow.membraneClosedUsd
  assert.ok(
    rel < 0.01,
    `closed USD within 1%: live ${live.closedUsd.toFixed(0)} vs census ${demoRow.membraneClosedUsd} (${(100 * rel).toFixed(3)}%)`,
  )
  assert.strictEqual(live.saleCount, demoRow.sales, `same number of sales (${live.saleCount})`)
  console.log(
    `        [fixture] ${String(DEMO.address).slice(0, 10)} ${demoRow.outcome}: live $${live.closedUsd.toFixed(0)} vs census $${demoRow.membraneClosedUsd} (${(100 * rel).toFixed(4)}%), minute ${live.firstSaleMinute} vs ${expected}`,
  )
})

test('and Aave breaks it at the census t0, not 21 hours early', () => {
  const live = runDemoFixture(demoRow.liqLine)
  assert.ok(live.sourceFirstMinute !== null, 'Aave liquidated it')
  assert.ok(
    Math.abs((live.sourceFirstMinute as number) - demoRow.t0Index) <= 2,
    `Aave's first liquidation is the census t0 (live ${live.sourceFirstMinute}, census ${demoRow.t0Index})`,
  )
})

test('the SHIPPED Membrane line is the only thing between the hero and its census row', () => {
  // The hero does not run the census line — it runs the modelled per-asset Membrane line
  // (WETH 80% vs Aave's 83%), which breaches earlier and repays less. That divergence is
  // a MODELLING choice and is stated in the run's own caveats; it is recorded here so it
  // can never be mistaken for the fixture drifting again.
  const shipped = weightedMembraneLine(DEMO.position.collateral).maxLtv
  const live = runDemoFixture(shipped)
  const rel = Math.abs(live.closedUsd - demoRow.membraneClosedUsd) / demoRow.membraneClosedUsd
  assert.ok(live.firstSaleMinute !== null, 'it still sells')
  console.log(
    `        [fixture] shipped line ${shipped.toFixed(2)} vs census line ${demoRow.liqLine}: closed $${live.closedUsd.toFixed(0)} (${(100 * rel).toFixed(2)}% off the census), minute ${live.firstSaleMinute}, equity delta $${live.cmp.equityDeltaUsd.toFixed(0)}`,
  )
  assert.ok(live.saleCount <= demoRow.sales + 1, 'and it does not fragment into a day of sales')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
