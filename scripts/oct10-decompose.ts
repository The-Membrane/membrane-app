/**
 * EXPLORATORY. Decomposes the Oct-10 census by mechanism. Read this before quoting it:
 *
 *   config P reproduces the shipped $105.0M to the cent (scripts/build-evidence.ts:107)
 *   and is PARTIAL REPAY-TO-CAP ONLY. The shipped census applies no cure window and no
 *   recall to closed debt.
 *
 *   configs PC / PCR model a PRICE-RECOVERY cure that the shipped engine does not
 *   implement: lib/position-sim/compare.ts:256 cures only when fast venue capital covers
 *   the call (membrane.ts:191-197). The cure here is also one-shot (never re-armed) and
 *   89% of its credit comes from accounts back under the line within two minutes.
 *   Refuted 2026-09-14; do not put a PC/PCR dollar figure on a page.
 *
 *   599 of 2,350 accounts carry a snapshot health factor >= 1 (under their own line at
 *   t0) and are still repaid to cap because membraneRepayValue guards on the borrow cap,
 *   not the line (membrane.ts:16). That is $20.1M counted against Membrane in the
 *   shipped number.
 */
/**
 * DECOMPOSES the Oct-10 counterfactual saving by MECHANISM.
 *
 * The landing page says Membrane would have closed $105.0M where Aave closed $144.2M
 * across 2,350 real accounts. That single number hides which mechanism bought the
 * saving. This script replays the SAME cohort under several engine configurations and
 * prints the totals side by side, so "partial repay" and "cure window" can be told
 * apart.
 *
 * It is a READ-ONLY variant: it writes nothing into public/ and does not touch
 * evidence.json. Config P reproduces the shipped $105.0M exactly, which is the check
 * that this replay and the shipped builder are the same engine.
 *
 * Inputs (identical to scripts/build-evidence.ts):
 *   - /Users/EBmic/Downloads/oct10_data/aave_liquidations_enriched.csv  (3,111 events)
 *   - public/data/oct10-2025/prices-1m.json                             (1-minute oracle grid)
 *
 * Engine parameters, all imported (never re-implemented) from lib/position-sim/membrane.ts:
 *   BORROW_LTV_GAP          membrane.ts:28   0.03    the 3pp cap the repay restores to
 *   CURE_WINDOW_SECONDS     membrane.ts:35   28800   the 8h delay
 *   MAX_THRESHOLD_TO_DELAY  membrane.ts:55   0.04    the band that BREAKS the delay
 *   membraneRepayValue      membrane.ts:131          repay-to-cap size
 *   applyRecall             membrane.ts:183          venue recall before collateral
 *
 * Run: ./node_modules/.bin/tsx scripts/oct10-decompose.ts
 */
import fs from 'node:fs'
import path from 'node:path'

import {
  BORROW_LTV_GAP,
  CURE_WINDOW_SECONDS,
  MAX_THRESHOLD_TO_DELAY,
  membraneRepayValue,
} from '../lib/position-sim/membrane'

const CSV = '/Users/EBmic/Downloads/oct10_data/aave_liquidations_enriched.csv'
const DATA_DIR = path.join(process.cwd(), 'public/data/oct10-2025')

const STABLES = new Set([
  'USDC', 'USDT', 'USD₮0', 'USDT0', 'DAI', 'GHO', 'LUSD', 'USDS',
  'sUSD', 'FRAX', 'USDC.e', 'crvUSD', 'MAI', 'USDbC',
])
const ETH_LIKE = new Set(['WETH', 'ETH', 'wstETH', 'weETH', 'rETH', 'cbETH', 'ETHx', 'osETH'])
const BTC_LIKE = new Set(['WBTC', 'BTC', 'cbBTC', 'tBTC', 'LBTC'])

// ---- price series (same grid the shipped builder uses) --------------------
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

// ---- cohort (identical filter to the shipped builder) ---------------------
interface Row {
  key: string
  ts: number
  coll: number
  debt: number
  lt: number       // this account's OWN liquidation line, inverted from its HF
  cap: number      // the borrow cap the repay restores to
  ltv0: number
  csym: string
  dsym: string
  aaveUsd: number
  /** Collateral price series, or null when Oct-10 does not price this asset. */
  cs: number[] | null
  /** Debt price series; null means a stable (constant 1). */
  ds: number[] | null
  /** True when the whole 8h path can be evaluated for this account. */
  pathed: boolean
}
const cohort: Row[] = []
for (const [key, evs] of accounts) {
  evs.sort((a, b) => a.ts - b.ts || a.seq - b.seq)
  const f = evs[0]
  const lt = (f.hf * f.debt) / f.coll
  if (!(lt >= 0.3 && lt <= 0.95)) continue
  const cs = seriesFor(f.csym)
  const ds = STABLES.has(f.dsym) ? null : seriesFor(f.dsym)
  cohort.push({
    key, ts: f.ts, coll: f.coll, debt: f.debt, lt,
    cap: Math.max(0, lt - BORROW_LTV_GAP),
    ltv0: f.debt / f.coll,
    csym: f.csym, dsym: f.dsym,
    aaveUsd: Math.min(evs.reduce((s, e) => s + e.repaidUsd, 0), f.debt),
    cs, ds,
    pathed: !!cs && (STABLES.has(f.dsym) || !!ds),
  })
}

// ---- the engine configurations -------------------------------------------

export interface Cfg {
  id: string
  label: string
  /** Hours the delay is granted. 0 = no cure window. */
  cureHours: number
  /** The band above the line past which the delay is BROKEN (immediate sale). */
  band: number
  /** Share of collateral value modelled as deployed to venues. 0 = no recall. */
  deployedShare: number
  /** Share of deployed value that comes back when called. */
  recallRate: number
}

interface AcctResult {
  closedUsd: number
  /** Collateral value that had to be SOLD to close it (recall covers the rest). */
  soldUsd: number
  /** Repaid out of recalled venue capital. */
  recalledUsd: number
  /** True when the account healed inside the window and nothing at all happened. */
  cured: boolean
  /** True when the 4% band was already broken at the breach minute. */
  brokeAtT0: boolean
  /** True when the window was granted but the account was still unhealthy at 8h. */
  soldAfterWindow: boolean
  /** True when the account could not be path-evaluated and fell back to t0. */
  unpathed: boolean
  /** True when the delay was granted but the LTV climbed past the band before healing. */
  brokeMidWindow: boolean
}

function replay(r: Row, cfg: Cfg): AcctResult {
  const out: AcctResult = {
    closedUsd: 0, soldUsd: 0, recalledUsd: 0,
    cured: false, brokeAtT0: false, soldAfterWindow: false, unpathed: false,
    brokeMidWindow: false,
  }
  const breakLine = r.lt * (1 + cfg.band)

  // How much is closed, and at which minute's prices.
  let coll = r.coll
  let debt = r.debt

  if (cfg.cureHours > 0) {
    if (r.ltv0 > breakLine) {
      // Window broken on arrival — LiquidationEngine.sol:1357 BrokeWindow. Sell now.
      out.brokeAtT0 = true
    } else if (!r.pathed) {
      // No Oct-10 oracle series for this collateral: the window cannot be evaluated.
      // Fall back to the immediate repay so the config never flatters itself.
      out.unpathed = true
    } else {
      const i0 = idx(r.ts)
      const i1 = Math.min(NP - 1, i0 + Math.round((cfg.cureHours * 3600) / STEP))
      const cp0 = r.cs![i0]
      const dp0 = r.ds ? r.ds[i0] : 1
      let resolved = false
      for (let i = i0 + 1; i <= i1; i++) {
        const cMul = r.cs![i] / cp0
        const dMul = r.ds ? r.ds[i] / dp0 : 1
        const ltv = (r.ltv0 * dMul) / cMul
        if (ltv <= r.lt) {
          // Healed inside the delay. Nothing is ever sold; the call is dropped.
          out.cured = true
          resolved = true
          break
        }
        if (ltv > breakLine) {
          // Climbed past the band mid-window: the timer is broken, sale is immediate.
          coll = r.coll * cMul
          debt = r.debt * dMul
          out.brokeMidWindow = true
          resolved = true
          break
        }
      }
      if (!resolved) {
        // Still unhealthy, still inside the band, 8 hours elapsed: sale at the 8h mark.
        const cMul = r.cs![i1] / cp0
        const dMul = r.ds ? r.ds[i1] / dp0 : 1
        coll = r.coll * cMul
        debt = r.debt * dMul
        out.soldAfterWindow = true
      }
    }
  }

  if (out.cured) return out

  // The repay-to-cap size, from the shared engine (membrane.ts:131).
  const needed = membraneRepayValue(debt, coll, r.cap)
  out.closedUsd = needed

  // Recall answers the call BEFORE collateral is touched (LiquidationEngine.sol:924-928).
  const available = r.coll * cfg.deployedShare * cfg.recallRate
  out.recalledUsd = Math.min(available, needed)
  out.soldUsd = Math.max(0, needed - out.recalledUsd)
  return out
}

// ---- aggregation ----------------------------------------------------------

const median = (xs: number[]) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const usd = (n: number) => `$${(n / 1e6).toFixed(1)}M`
const pad = (s: string, n: number) => s.padEnd(n)
const padL = (s: string, n: number) => s.padStart(n)

interface Agg {
  cfg: Cfg
  closed: number
  sold: number
  recalled: number
  less: number
  more: number
  equal: number
  notLiquidated: number
  cured: number
  brokeAtT0: number
  soldAfterWindow: number
  unpathed: number
  brokeMidWindow: number
  unpathedUsd: number
  nothingSold: number
  medianFrac: number
}

function run(cfg: Cfg): Agg {
  const a: Agg = {
    cfg, closed: 0, sold: 0, recalled: 0, less: 0, more: 0, equal: 0,
    notLiquidated: 0, cured: 0, brokeAtT0: 0, soldAfterWindow: 0, unpathed: 0,
    brokeMidWindow: 0, unpathedUsd: 0, nothingSold: 0, medianFrac: 0,
  }
  const fracs: number[] = []
  for (const r of cohort) {
    const o = replay(r, cfg)
    a.closed += o.closedUsd
    a.sold += o.soldUsd
    a.recalled += o.recalledUsd
    const mf = o.closedUsd / r.debt
    const af = r.aaveUsd / r.debt
    fracs.push(mf)
    if (mf < af) a.less++
    else if (mf > af) a.more++
    else a.equal++
    if (o.closedUsd <= 0) a.notLiquidated++
    if (o.soldUsd <= 0) a.nothingSold++
    if (o.cured) a.cured++
    if (o.brokeAtT0) a.brokeAtT0++
    if (o.soldAfterWindow) a.soldAfterWindow++
    if (o.unpathed) { a.unpathed++; a.unpathedUsd += o.closedUsd }
    if (o.brokeMidWindow) a.brokeMidWindow++
  }
  a.medianFrac = median(fracs)
  return a
}

// A — the measured baseline, for the table's first row.
const aaveTotal = cohort.reduce((s, r) => s + r.aaveUsd, 0)
const aaveMedianFrac = median(cohort.map((r) => r.aaveUsd / r.debt))

const CONFIGS: Cfg[] = [
  { id: 'P',   label: 'Partial repay only (0h cure, no recall) = the shipped $105.0M', cureHours: 0, band: MAX_THRESHOLD_TO_DELAY, deployedShare: 0,   recallRate: 0 },
  { id: 'PC',  label: 'Partial + 8h cure inside the 4% band, no recall',               cureHours: CURE_WINDOW_SECONDS / 3600, band: MAX_THRESHOLD_TO_DELAY, deployedShare: 0, recallRate: 0 },
  { id: 'PR',  label: 'Partial + recall (25% of collateral deployed, 100% returns), 0h cure', cureHours: 0, band: MAX_THRESHOLD_TO_DELAY, deployedShare: 0.25, recallRate: 1 },
  { id: 'PCR', label: 'Partial + 8h cure + recall — the full Membrane engine',          cureHours: CURE_WINDOW_SECONDS / 3600, band: MAX_THRESHOLD_TO_DELAY, deployedShare: 0.25, recallRate: 1 },
  { id: 'B2',  label: 'Sensitivity: 8h cure, 2% band, no recall',                       cureHours: 8, band: 0.02, deployedShare: 0, recallRate: 0 },
  { id: 'B8',  label: 'Sensitivity: 8h cure, 8% band, no recall',                       cureHours: 8, band: 0.08, deployedShare: 0, recallRate: 0 },
  { id: 'B95', label: 'Sensitivity: 8h cure, 95% band (permissionless onboarding), no recall', cureHours: 8, band: 0.95, deployedShare: 0, recallRate: 0 },
]

const results = CONFIGS.map(run)
const P = results.find((r) => r.cfg.id === 'P')!
const PC = results.find((r) => r.cfg.id === 'PC')!

// ---- output ---------------------------------------------------------------

console.log('')
console.log(`COHORT  ${cohort.length} accounts · ${lines.length - 1} source events · ${unpriced} unpriced events dropped`)
console.log(`        ${cohort.filter((r) => r.pathed).length} path-evaluable (ETH/BTC-like collateral), ${cohort.filter((r) => !r.pathed).length} not`)
console.log('')

console.log(pad('CFG', 5) + pad('CLOSED', 10) + padL('LESS', 6) + padL('MORE', 6) + padL('EQ', 5) + padL('MED%', 7) + padL('NOTLIQ', 8) + padL('CURED', 7) + padL('SOLD$', 9) + '  LABEL')
console.log(pad('A', 5) + pad(usd(aaveTotal), 10) + padL('—', 6) + padL('—', 6) + padL('—', 5) + padL((100 * aaveMedianFrac).toFixed(1), 7) + padL('0', 8) + padL('—', 7) + padL(usd(aaveTotal), 9) + '  Aave actual (measured)')
for (const a of results) {
  console.log(
    pad(a.cfg.id, 5) +
    pad(usd(a.closed), 10) +
    padL(String(a.less), 6) +
    padL(String(a.more), 6) +
    padL(String(a.equal), 5) +
    padL((100 * a.medianFrac).toFixed(1), 7) +
    padL(String(a.notLiquidated), 8) +
    padL(String(a.cured), 7) +
    padL(usd(a.sold), 9) +
    '  ' + a.cfg.label,
  )
}

console.log('')
console.log('DECOMPOSITION of the $' + ((aaveTotal - P.closed) / 1e6).toFixed(1) + 'M headline saving (A − P):')
console.log(`  partial repay-to-cap     A − P   = ${usd(aaveTotal - P.closed)}  (${(100 * (aaveTotal - P.closed) / aaveTotal).toFixed(1)}% of what Aave closed)`)
console.log(`  8h cure inside 4% band   P − PC  = ${usd(P.closed - PC.closed)}  (a FURTHER ${(100 * (P.closed - PC.closed) / aaveTotal).toFixed(1)}% of what Aave closed)`)
console.log(`  recall                   0 on this metric — it changes WHO pays, not how much debt closes.`)
console.log(`                           measured as collateral NOT sold: ${usd(P.sold - results.find((r) => r.cfg.id === 'PR')!.sold)} at 25% deployed / 100% returned`)
console.log(`  total A − PC             = ${usd(aaveTotal - PC.closed)}  (${(100 * (aaveTotal - PC.closed) / aaveTotal).toFixed(1)}%)`)
console.log('')

// ---- reader questions, answered from the same rows ------------------------

const PCrows = cohort.map((r) => ({ r, o: replay(r, CONFIGS[1]) }))
const stillSold = PCrows.filter((x) => x.o.closedUsd > 0)
const held = PCrows.filter((x) => x.o.closedUsd <= 0)
const heldByCure = PCrows.filter((x) => x.o.cured)
const heldByCap = PCrows.filter((x) => !x.o.cured && x.o.closedUsd <= 0)

console.log('READER QUESTIONS (config PC — cure + band, no recall):')
console.log(`  still sold on Membrane            ${stillSold.length} of ${cohort.length} (${(100 * stillSold.length / cohort.length).toFixed(1)}%)`)
console.log(`  held the whole day               ${held.length} — ${heldByCure.length} by the cure window, ${heldByCap.length} already inside the borrow cap`)
console.log(`  broke the 4% band on arrival     ${PC.brokeAtT0} (sold immediately, no delay)`)
console.log(`  granted the delay, broke the band later ${PC.brokeMidWindow} (sold mid-window, at that minute's prices)`)
console.log(`  granted the delay, still unhealthy at 8h ${PC.soldAfterWindow}`)
console.log(`  delay not evaluable (no series)  ${PC.unpathed} — fall back to the immediate sale, carrying ${usd(PC.unpathedUsd)} of the ${usd(PC.closed)}`)

const keptUsd = cohort.map((r, i) => r.aaveUsd - PCrows[i].o.closedUsd)
const keptPct = cohort.map((r, i) => (r.aaveUsd - PCrows[i].o.closedUsd) / r.debt)
console.log(`  median account keeps             $${Math.round(median(keptUsd)).toLocaleString('en-US')} of debt not closed (${(100 * median(keptPct)).toFixed(1)}% of its loan)`)
console.log(`  median debt closed               Aave ${(100 * aaveMedianFrac).toFixed(1)}% · Membrane ${(100 * PC.medianFrac).toFixed(1)}%`)

const worse = PCrows.filter((x) => x.o.closedUsd / x.r.debt > x.r.aaveUsd / x.r.debt)
const worseAaveFracMed = median(worse.map((x) => x.r.aaveUsd / x.r.debt))
const worseOverMed = median(worse.map((x) => x.r.ltv0 / x.r.lt))
console.log(`  Membrane closes MORE             ${worse.length} accounts · Aave closed a median ${(100 * worseAaveFracMed).toFixed(1)}% of their loan · they were a median ${((worseOverMed - 1) * 100).toFixed(1)}% past their line`)
console.log(`                                   Σ Aave ${usd(worse.reduce((s, x) => s + x.r.aaveUsd, 0))} vs Σ Membrane ${usd(worse.reduce((s, x) => s + x.o.closedUsd, 0))}`)
console.log('')

console.log('BAND SENSITIVITY (8h cure, no recall):')
for (const id of ['B2', 'PC', 'B8', 'B95']) {
  const a = results.find((r) => r.cfg.id === id)!
  console.log(`  band ${padL((100 * a.cfg.band).toFixed(0) + '%', 4)}  closed ${usd(a.closed)}  cured ${padL(String(a.cured), 4)}  broke-on-arrival ${padL(String(a.brokeAtT0), 4)}  saving vs Aave ${usd(aaveTotal - a.closed)} (${(100 * (aaveTotal - a.closed) / aaveTotal).toFixed(1)}%)`)
}
console.log('')

console.log('RECALL SENSITIVITY (config PC + recall; debt closed is unchanged by construction):')
for (const share of [0.1, 0.25, 0.5, 1.0]) {
  const a = run({ ...CONFIGS[3], deployedShare: share, label: '' })
  console.log(`  deployed ${padL((100 * share).toFixed(0) + '%', 4)} of collateral  →  collateral sold ${usd(a.sold)}  repaid from venues ${usd(a.recalled)}  accounts selling nothing ${a.nothingSold}`)
}
console.log('')

// The reproduction check: P must equal the shipped evidence.json figure.
const shipped = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'evidence.json'), 'utf8'))
const dA = Math.abs(aaveTotal - shipped.debt.aaveClosedUsd)
const dP = Math.abs(P.closed - shipped.debt.membraneClosedUsd)
console.log('REPRODUCTION CHECK vs public/data/oct10-2025/evidence.json')
console.log(`  accounts   ${cohort.length} vs ${shipped.debt.accounts}   ${cohort.length === shipped.debt.accounts ? 'OK' : 'MISMATCH'}`)
console.log(`  Aave       $${aaveTotal.toFixed(2)} vs $${shipped.debt.aaveClosedUsd}   delta $${dA.toFixed(2)}  ${dA < 1000 ? 'OK' : 'MISMATCH'}`)
console.log(`  config P   $${P.closed.toFixed(2)} vs $${shipped.debt.membraneClosedUsd}   delta $${dP.toFixed(2)}  ${dP < 1000 ? 'OK' : 'MISMATCH'}`)
console.log(`  less/more  ${P.less}/${P.more + P.equal} vs ${shipped.debt.membraneClosesLess}/${shipped.debt.membraneClosesMore}`)
console.log('')
