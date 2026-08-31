/**
 * Builds public/data/oct10-2025/evidence.json — the dataset behind /[chain]/evidence.
 *
 * SINGLE SOURCE OF TRUTH: this imports membraneRepayValue, BORROW_LTV_GAP and
 * CURE_WINDOW_SECONDS from lib/position-sim/membrane.ts — the SAME engine the
 * per-address wallet simulator runs. An earlier version of this builder was a
 * hand-written Python port of that formula; two implementations of one claim is
 * how a marketing number silently drifts from the contract. Do not reintroduce one.
 *
 * Source: 3,111 real Aave liquidation events from 10-11 Oct 2025, enriched with
 * pre-liquidation account state read at block_number-1.
 *
 * Method note: each account is judged against ITS OWN liquidation line, inverted
 * from its measured health factor (LT = hf * debt / coll). The modelled per-asset
 * MEMBRANE_ASSET_LTV is deliberately NOT used — it is an assumption about a
 * protocol with no mainnet deployment, and leaning on it would make this a claim
 * about our guess rather than about our mechanism.
 *
 * Run: ./node_modules/.bin/tsx scripts/build-evidence.ts
 */
import fs from 'node:fs'
import path from 'node:path'

import {
  BORROW_LTV_GAP,
  CURE_WINDOW_SECONDS,
  membraneRepayValue,
} from '../lib/position-sim/membrane'

const CSV = '/Users/EBmic/Downloads/oct10_data/aave_liquidations_enriched.csv'
const DATA_DIR = path.join(process.cwd(), 'public/data/oct10-2025')
const OUT = path.join(DATA_DIR, 'evidence.json')

const STABLES = new Set([
  'USDC', 'USDT', 'USD₮0', 'USDT0', 'DAI', 'GHO', 'LUSD', 'USDS',
  'sUSD', 'FRAX', 'USDC.e', 'crvUSD', 'MAI', 'USDbC',
])
const ETH_LIKE = new Set(['WETH', 'ETH', 'wstETH', 'weETH', 'rETH', 'cbETH', 'ETHx', 'osETH'])
const BTC_LIKE = new Set(['WBTC', 'BTC', 'cbBTC', 'tBTC', 'LBTC'])

// ---- price series --------------------------------------------------------
const px = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'prices-1m.json'), 'utf8'))
const P0: number = px.startTs
const STEP: number = px.stepSeconds
const ETH: number[] = px.columns.ethOracle
const BTC: number[] = px.columns.btcOracle
const NP = ETH.length

const idx = (ts: number) => Math.max(0, Math.min(NP - 1, Math.floor((ts - P0) / STEP)))
const seriesFor = (s: string): number[] | null =>
  ETH_LIKE.has(s) ? ETH : BTC_LIKE.has(s) ? BTC : null
const priceAt = (sym: string, ts: number): number | null => {
  if (STABLES.has(sym)) return 1
  const s = seriesFor(sym)
  return s ? s[idx(ts)] : null
}

// ---- csv -----------------------------------------------------------------
const lines = fs.readFileSync(CSV, 'utf8').trim().split('\n')
const header = lines[0].split(',')
const col = (name: string) => {
  const i = header.indexOf(name)
  if (i < 0) throw new Error(`missing column: ${name}`)
  return i
}
const C = {
  ts: col('ts'), seq: col('intra_block_seq'), chain: col('chain'), user: col('user'),
  coll: col('total_collateral_base_usd'), debt: col('total_debt_base_usd'),
  hf: col('health_factor'), cover: col('debt_to_cover_normalized'),
  csym: col('collateral_symbol'), dsym: col('debt_symbol'),
}

interface Ev {
  ts: number; seq: number; coll: number; debt: number; hf: number
  csym: string; dsym: string; repaidUsd: number
}
const accounts = new Map<string, Ev[]>()
let unpriced = 0

for (let i = 1; i < lines.length; i++) {
  const f = lines[i].split(',')
  const ts = +f[C.ts]
  const coll = +f[C.coll]
  const debt = +f[C.debt]
  const hf = +f[C.hf]
  const dsym = f[C.dsym]
  if (!(coll > 0 && debt > 0 && hf > 0)) continue
  const p = priceAt(dsym, ts)
  if (p == null) { unpriced++; continue }
  const key = `${f[C.chain]}:${f[C.user]}`
  if (!accounts.has(key)) accounts.set(key, [])
  accounts.get(key)!.push({
    ts, seq: +f[C.seq], coll, debt, hf, csym: f[C.csym], dsym, repaidUsd: +f[C.cover] * p,
  })
}

// ---- per-account counterfactual -----------------------------------------
const cohort: any[] = []
for (const [key, evs] of accounts) {
  evs.sort((a, b) => a.ts - b.ts || a.seq - b.seq)
  const f = evs[0]
  const lt = (f.hf * f.debt) / f.coll // invert the measured health factor
  if (!(lt >= 0.3 && lt <= 0.95)) continue

  const aaveUsd = Math.min(evs.reduce((s, e) => s + e.repaidUsd, 0), f.debt)
  // the shared engine, not a reimplementation
  const memUsd = membraneRepayValue(f.debt, f.coll, Math.max(0, lt - BORROW_LTV_GAP))

  let cure: any = null
  const cs = seriesFor(f.csym)
  const ds = STABLES.has(f.dsym) ? null : seriesFor(f.dsym)
  if (cs && (STABLES.has(f.dsym) || ds)) {
    const i0 = idx(f.ts)
    const i1 = Math.min(NP - 1, i0 + Math.round(CURE_WINDOW_SECONDS / STEP))
    if (i1 > i0) {
      const cp0 = cs[i0]
      const dp0 = ds ? ds[i0] : 1
      const ltv0 = f.debt / f.coll
      let best = Infinity
      let bestMin = 0
      for (let i = i0; i <= i1; i++) {
        const ltv = (ltv0 * (ds ? ds[i] / dp0 : 1)) / (cs[i] / cp0)
        if (ltv < best) { best = ltv; bestMin = ((i - i0) * STEP) / 60 }
      }
      const end = (ltv0 * (ds ? ds[i1] / dp0 : 1)) / (cs[i1] / cp0)
      cure = {
        curedInWindow: best <= lt,
        healthyAt8h: end <= lt,
        minutesToCure: best <= lt ? bestMin : null,
        bestLtv: +best.toFixed(5),
        endLtv: +end.toFixed(5),
      }
    }
  }

  const [chain, user] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]
  cohort.push({
    chain, user, events: evs.length,
    collateralUsd: +f.coll.toFixed(2), debtUsd: +f.debt.toFixed(2),
    healthFactor: +f.hf.toFixed(6), liqLine: +lt.toFixed(5),
    ltv0: +(f.debt / f.coll).toFixed(5),
    collSymbol: f.csym, debtSymbol: f.dsym,
    aaveClosedUsd: +aaveUsd.toFixed(2), membraneClosedUsd: +memUsd.toFixed(2),
    aaveClosedFrac: +(aaveUsd / f.debt).toFixed(5),
    membraneClosedFrac: +(memUsd / f.debt).toFixed(5),
    cure,
  })
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const n = cohort.length
const aU = cohort.reduce((s, r) => s + r.aaveClosedUsd, 0)
const mU = cohort.reduce((s, r) => s + r.membraneClosedUsd, 0)
const cur = cohort.filter((r) => r.cure)
const cured = cur.filter((r) => r.cure.curedInWindow)
const healthy = cur.filter((r) => r.cure.healthyAt8h)

const byAsset: Record<string, any> = {}
for (const r of cohort) (byAsset[r.collSymbol] ??= []).push(r)
const byAssetOut: Record<string, any> = {}
for (const [sym, g] of Object.entries(byAsset) as [string, any[]][]) {
  if (g.length < 20) continue
  const gc = g.filter((r) => r.cure)
  byAssetOut[sym] = {
    accounts: g.length,
    aaveMedianFrac: +median(g.map((r) => r.aaveClosedFrac)).toFixed(5),
    membraneMedianFrac: +median(g.map((r) => r.membraneClosedFrac)).toFixed(5),
    curedPct: gc.length
      ? +((100 * gc.filter((r) => r.cure.curedInWindow).length) / gc.length).toFixed(2)
      : null,
  }
}

const doc = {
  meta: {
    window: '2025-10-10T00:00Z to 2025-10-11T23:59Z',
    sourceEvents: lines.length - 1,
    accounts: n,
    unpricedEventsDropped: unpriced,
    provenance: 'onchain',
    method:
      'Each account is judged against its OWN liquidation line, inverted from its ' +
      'measured health factor (LT = hf x debt / coll). No modelled per-asset LTV is ' +
      "used anywhere. Aave's side is its ENTIRE multi-hit episode; Membrane's is a " +
      'single repay-to-cap. The comparison is tilted toward Aave on purpose.',
    realConstants: {
      borrowLtvGap: BORROW_LTV_GAP,
      borrowLtvGapSource: 'lib/Constants.sol:30',
      repayFormulaSource: 'LiquidationEngine.sol:2204-2238',
      cureWindowSeconds: CURE_WINDOW_SECONDS,
      cureWindowSource: 'liquidation-engine/src/contract.rs:52',
    },
    engine: 'lib/position-sim/membrane.ts — shared with the per-address simulator',
    caveats: [
      'Account state is read at block_number-1 (genuine pre-liquidation).',
      'debt_fraction_repaid is per-RESERVE; Aave’s USD figure is valued from ' +
        'debt_to_cover_normalized x price instead.',
      'Cure analysis covers only ETH-like and BTC-like collateral - the assets the ' +
        'Oct 10 oracle series prices. It treats the account as moving with the ' +
        'liquidated leg, an approximation for mixed-collateral accounts.',
      'The cure result is PATH-DEPENDENT. Oct 10 was a sharp wick with partial ' +
        'recovery. A window that keeps falling would not cure.',
      'Membrane has no mainnet deployment. This models a protocol that is not live, ' +
        'run against real prices.',
    ],
  },
  debt: {
    accounts: n,
    aaveClosedUsd: +aU.toFixed(2),
    membraneClosedUsd: +mU.toFixed(2),
    differenceUsd: +(aU - mU).toFixed(2),
    differencePct: +((100 * (aU - mU)) / aU).toFixed(2),
    aaveMedianFrac: +median(cohort.map((r) => r.aaveClosedFrac)).toFixed(5),
    membraneMedianFrac: +median(cohort.map((r) => r.membraneClosedFrac)).toFixed(5),
    membraneClosesLess: cohort.filter((r) => r.membraneClosedFrac < r.aaveClosedFrac).length,
    membraneClosesMore: cohort.filter((r) => r.membraneClosedFrac >= r.aaveClosedFrac).length,
  },
  time: {
    accountsAnalysed: cur.length,
    curedInWindow: cured.length,
    curedPct: +((100 * cured.length) / cur.length).toFixed(2),
    healthyAt8h: healthy.length,
    healthyAt8hPct: +((100 * healthy.length) / cur.length).toFixed(2),
    medianMinutesToCure: median(cured.map((r) => r.cure.minutesToCure)),
    aaveSecondsGranted: 0,
    membraneSecondsGranted: CURE_WINDOW_SECONDS,
  },
  byAsset: byAssetOut,
  cohort: cohort.sort((a, b) => b.debtUsd - a.debtUsd),
}

fs.writeFileSync(OUT, JSON.stringify(doc))
console.log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`)
console.log(`  accounts ${n}  debt delta $${(aU - mU).toLocaleString()} (${doc.debt.differencePct}%)`)
console.log(`  cure ${doc.time.curedPct}%  healthy@8h ${doc.time.healthyAt8hPct}%  median ${doc.time.medianMinutesToCure} min`)
