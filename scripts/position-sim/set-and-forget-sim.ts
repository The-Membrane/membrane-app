/**
 * set-and-forget-sim — the highest start LTV per asset that a position opened at ANY
 * historical start hour and left untouched for 30 / 90 / 365 days never sees sold, plus the
 * start LTV sold in at most 1 % / 5 % of start hours. Owner ask 2026-10-04 ("what LTV per
 * asset will be profitable to set and forget with our recall mech"). Write-up:
 * docs/research/SET-AND-FORGET-LTV.md.
 *
 * Run (from the repo root):
 *   ./node_modules/.bin/tsx scripts/position-sim/set-and-forget-sim.ts --path=ETH [--stride=1]
 *   ./node_modules/.bin/tsx scripts/position-sim/set-and-forget-sim.ts --report
 * `--path` takes one or more comma-separated ids from PATHS (default: every id, in series —
 * run one process per path to parallelise). Each path writes a partial to
 * data/price-history/cache/set-and-forget/<id>.json (gitignored); `--report` merges every
 * partial into public/data/price-history/set-and-forget-ltv.json and prints the tables.
 * Other flags: --horizons=30d,90d,365d  --cases=<case ids>  --stride=<hours>
 * --classes=delayed|no-delay (a class shard, merged by --report)  --shard=<name> (with
 * --cases: a case shard, merged by --report; without --shard a case subset is a probe)
 * --collateral=<usd> (a position-size probe for the $2,000 debt floor; written as '.partial',
 * never merged).
 *   ./node_modules/.bin/tsx scripts/position-sim/set-and-forget-sim.ts --seed=<case ids>
 * copies those cases' rows from the PUBLISHED set-and-forget-ltv.json into '#seed' shards,
 * for cases a code-version bump cannot move: levered_long by id, and carry BY STOCK — a cell
 * is seeded from the published row whose case then had the venue stock (mult, lock) this case
 * has now, else left to be solved (`seed`). Each seeded row keeps `seededFrom` (the code
 * version that solved it) and `seededAs` (the case it was solved under, when another); re-run
 * one path as a probe and compare before trusting a seed.
 *
 * EXIT CAPACITY (owner instruction 2026-10-06, ruling 2026-10-07): carry runs at MEASURED
 * venue analogs (stressGrid EXIT_CAPACITY_PRESETS, exitCapacityAnalogs.ts) in two models:
 *   CASH VS BOOK (the headline): m = min(1, the venue's idle cash ÷ Membrane's whole book at
 *     it). Aave USDC at every book ($10M / $50M / $250M) × typical / bad / worst on ETH, both
 *     classes; the default (Aave USDC typical, $50M book) on every main path and class; the
 *     $50M typical of Steakhouse USDC, Spark USDS and Aave USDT on ETH, delayed class.
 *   PRO-RATA FLOOR (everyone exits at once): Aave USDC typical / bad / worst on every main
 *     path and class, every other stable venue's three floor levels on ETH, delayed class.
 * plus the bounds 'frozen' (×0) and 'optimistic' (×1, upper bound only). Carry cases that
 * resolve to the same venue stock (same mult and lock, or mult 0 whatever the lock: nothing to
 * recall) are solved once per cell and copied (`aliasOf`) — and `--seed` copies a published
 * row of the same stock, so a cash-vs-book level whose idle cash covered the whole book (×1)
 * is the published 'optimistic' row, and a floor level is its published row under its old id.
 *   ./node_modules/.bin/tsx scripts/position-sim/set-and-forget-sim.ts --claims [--horizons=90d]
 * measures each COPY CLAIM (CLAIMS below) directly, per position size; written to
 * data/price-history/cache/set-and-forget/claims/ and merged by --report as `claims`.
 *
 *   ./node_modules/.bin/tsx scripts/position-sim/set-and-forget-sim.ts --returns [--horizons=90d]
 * the RETURN STATEMENT (board Q20, the return half): for each A1 case, every start hour whose
 * window the measured rate series cover — what the deployed debt earned, the borrow cost, the
 * collateral sold on Membrane and on the incumbent (Aave v3, compare.ts `runIncumbent`), and
 * the yield the recalled capital gave up (lib/position-sim/returnStatement.ts). Venue yield is
 * the net-APY history (private datasets repo, net-apy-history/aave-v3-usdc-1h.json, built by
 * build-net-apy-history.ts from lib/netApy's pinned reads; board rule N18); a window it does
 * not cover is counted as unavailable, never priced. Writes the canonical
 * set-and-forget-returns/set-and-forget-returns.json in the datasets repo and the copy the UI
 * serves, public/data/price-history/set-and-forget-returns.json.
 *
 * EVERY "is it sold?" IS ONE stressGrid `runStress` CALL (lib/position-sim/setAndForget.ts
 * header): the measured window becomes a `replay` shape; the start LTV is bisected with
 * frontier.ts's `bisectEdge`. Nothing here re-implements a mechanic.
 *
 * STRIDE. Every start hour is a candidate (`--stride=1`, the default). The cost is held
 * down by PRUNING, not by skipping hours: a start whose proven lower bound (line × the
 * window's lowest ratio — under it nothing breaches) is at or above the k-th smallest solved
 * threshold cannot enter the low tail, so it is never solved (setAndForget.ts
 * `solveLowTail`; exact for the lowest k). Cases with recall (carry with mult > 0) prune
 * poorly — their thresholds sit well above the bound — and are the slow ones.
 */
import fs from 'node:fs'
import path from 'node:path'

import {
  gridFromFile,
  primaryGrid,
  type PriceGrid,
  type PriceHistoryFile,
} from '../../lib/position-sim/drawdowns'
import {
  BORROW_LTV_GAP,
  CURE_WINDOW_SECONDS,
  LIQ_DEBT_MINIMUM_USD,
  MEMBRANE_CLASS_PARAMS,
  MAX_THRESHOLD_TO_DELAY,
  membraneAssetClass,
  membraneAssetLtvCap,
  membraneMaxLtv,
  type MembraneClass,
} from '../../lib/position-sim/membrane'
import {
  SET_AND_FORGET_COLLATERAL_USD,
  SET_AND_FORGET_HORIZONS,
  SET_AND_FORGET_LTV_TOL,
  TAIL_FRACTIONS,
  caseBorrowCap,
  dailyToHourly,
  floorTo,
  healthFactor,
  hourlyPathFromGrid,
  isSold,
  LOWER_BOUND_SLACK,
  loopLeverage,
  multiplyPath,
  noBreachBound,
  pathCoverage,
  runCase,
  solveLowTail,
  solveStartLtv,
  tallyAtLtv,
  tailK,
  tailQuantile,
  windowMinRatios,
  windowReplay,
  windowTrough,
  type HourlyPath,
  type LtvTally,
  type PathResolution,
  type SetAndForgetCase,
  type StartSolve,
} from '../../lib/position-sim/setAndForget'
import {
  EXIT_CAPACITY_ANALOG_DATA_THROUGH,
  EXIT_CAPACITY_ANALOG_ROWS,
  EXIT_CAPACITY_ANALOG_SOURCE,
  EXIT_CAPACITY_ANALOG_WINDOW_COUNT,
  EXIT_CAPACITY_BOOKS,
  EXIT_CAPACITY_DEFAULT_BOOK,
} from '../../lib/position-sim/exitCapacityAnalogs'
import {
  EXIT_CAPACITY_DEFAULT_PRESET,
  EXIT_CAPACITY_PRESETS,
  EXIT_CAPACITY_VENUES,
  STRESS_CODE_VERSION,
  exitCapacityPresetId,
  type ExitCapacityPresetId,
  type TradeShape,
} from '../../lib/position-sim/stressGrid'
import { measuredRepayFraction } from '../../lib/position-sim/compare'
import { datasetsDir } from '../lib/datasetsDir.mjs'
import {
  covers,
  distOf,
  historySeries,
  NET_APY_HISTORY_DIR,
  netApyHistoryFileName,
  incumbentReturn,
  incumbentWindow,
  membraneWindow,
  netCarry,
  rateSeries,
  windowTimes,
  type IncumbentParams,
  type IncumbentReturn,
  type Line,
  type MembraneReturn,
  type NetApyHistoryFile,
  type RateSeries,
} from '../../lib/position-sim/returnStatement'

const ROOT = process.cwd()
const DATA = path.join(ROOT, 'public/data/price-history')
const PARTIAL_DIR = path.join(ROOT, 'data/price-history/cache/set-and-forget')
const OUT = path.join(DATA, 'set-and-forget-ltv.json')
const CLAIM_DIR = path.join(PARTIAL_DIR, 'claims')

// ------------------------------------------------------------------ args

const args = new Map<string, string>()
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
  if (m) args.set(m[1], m[2] ?? 'true')
}

// ------------------------------------------------------------------ data

const files = new Map<string, PriceHistoryFile>()
function load(name: string): PriceHistoryFile {
  let f = files.get(name)
  if (!f) {
    f = JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8')) as PriceHistoryFile
    files.set(name, f)
  }
  return f
}

interface DailyFile {
  startTs: number
  stepSeconds: number
  count: number
  columns: Record<string, (number | null)[]>
}
function loadRates(): DailyFile {
  return JSON.parse(fs.readFileSync(path.join(DATA, 'lst-rates-1d.json'), 'utf8')) as DailyFile
}

function ethPrimary(): HourlyPath {
  return hourlyPathFromGrid('eth-primary', primaryGrid(load('eth-usd-1h.json')))
}

function rateFactor(column: string, base: HourlyPath): Float64Array {
  const r = loadRates()
  return dailyToHourly(r.columns[column], r.startTs, base.startTs, base.close.length)
}

/** stETH/ETH market feed on the hourly grid: close and low columns (NaN = none). */
function stethEthFactor(): { close: Float64Array; low: Float64Array } {
  const g: PriceGrid = gridFromFile(load('steth-eth-1h.json'), 'oracle')
  const p = hourlyPathFromGrid('steth-eth', g)
  return { close: p.close, low: p.low }
}

interface PathDef {
  /** Line lookup symbol in MEMBRANE_ASSET_LTV. */
  symbol: string
  label: string
  resolution: PathResolution
  /** Run only these case ids (default: every case). */
  cases?: readonly string[]
  sensitivity?: boolean
  build: () => HourlyPath
  source: string
}

const LL_ONLY = ['levered_long'] as const

const PATHS: Record<string, PathDef> = {
  ETH: {
    symbol: 'WETH',
    label: 'ETH',
    resolution: 'low-close',
    build: ethPrimary,
    source:
      'eth-usd-1h.json primary: Chainlink ETH/USD from 2020-04-08 21:00 UTC, Coinbase before (the feed was silent)',
  },
  BTC: {
    symbol: 'WBTC',
    label: 'BTC',
    resolution: 'low-close',
    build: () => hourlyPathFromGrid('btc-primary', primaryGrid(load('btc-usd-1h.json'))),
    source: 'btc-usd-1h.json primary: Chainlink BTC/USD, whole span',
  },
  wstETH: {
    symbol: 'wstETH',
    label: 'wstETH (ETH × stEthPerToken)',
    resolution: 'low-close',
    build: () => {
      const eth = ethPrimary()
      return multiplyPath('wsteth-rate', eth, { close: rateFactor('wstethStEthPerToken', eth) })
    },
    source:
      'ETH primary × wstETH.stEthPerToken (daily archive reads from 2021-02-20) — exchange-rate pricing, stETH/ETH market peg assumed 1',
  },
  weETH: {
    symbol: 'weETH',
    label: 'weETH (ETH × getRate)',
    resolution: 'low-close',
    build: () => {
      const eth = ethPrimary()
      return multiplyPath('weeth-rate', eth, { close: rateFactor('weethRate', eth) })
    },
    source:
      'ETH primary × weETH.getRate (daily archive reads from 2023-11-10) — exchange-rate pricing',
  },
  'wstETH-mkt': {
    symbol: 'wstETH',
    label: 'wstETH (ETH × stETH/ETH market × stEthPerToken)',
    resolution: 'low-close',
    cases: ['levered_long', 'carry:aave-usdc-floor-typical'],
    sensitivity: true,
    build: () => {
      const eth = ethPrimary()
      const rate = rateFactor('wstethStEthPerToken', eth)
      const peg = stethEthFactor()
      const n = eth.close.length
      const close = new Float64Array(n)
      const low = new Float64Array(n)
      for (let i = 0; i < n; i++) {
        close[i] = peg.close[i] * rate[i]
        low[i] = peg.low[i] * rate[i]
      }
      return multiplyPath('wsteth-market', eth, { close, low })
    },
    source:
      'ETH primary × Chainlink stETH/ETH market feed (from 2021-08-25; low × low, conservative) × stEthPerToken — prices the Jun-2022 depeg in',
  },
  'wstETH-rate-2108': {
    symbol: 'wstETH',
    label: 'wstETH (ETH × stEthPerToken) on the market-feed span, from 2021-08-25',
    resolution: 'low-close',
    cases: ['levered_long', 'carry:aave-usdc-floor-typical'],
    sensitivity: true,
    build: () => {
      // The exchange-rate path cut to the span the stETH/ETH market feed covers, so the
      // market-priced row has a like-for-like comparator.
      const eth = ethPrimary()
      const out = multiplyPath('wsteth-rate-2108', eth, {
        close: rateFactor('wstethStEthPerToken', eth),
      })
      const peg = stethEthFactor()
      for (let i = 0; i < out.close.length; i++) {
        if (!Number.isFinite(peg.close[i])) {
          out.close[i] = NaN
          out.low[i] = NaN
        }
      }
      return out
    },
    source: 'as wstETH, restricted to the hours the stETH/ETH market feed covers (2021-08-25 on)',
  },
  'ETH-oracle': {
    symbol: 'WETH',
    label: 'ETH (oracle only, from 2020-04-08 21:00 UTC — no Mar-2020)',
    resolution: 'low-close',
    cases: LL_ONLY,
    sensitivity: true,
    build: () => {
      // The primary series from its oracle segment on: the oracle column alone also holds a
      // few test rounds on 2020-01-15 followed by 2,017 silent hours, which a replay would
      // forward-fill across.
      const g = primaryGrid(load('eth-usd-1h.json'))
      const seg = g.segments.find((x) => x.source === 'oracle')
      if (!seg) throw new Error('eth-usd-1h.json: no oracle segment')
      const pth = hourlyPathFromGrid('eth-oracle', g)
      for (let i = 0; i < seg.fromIndex; i++) {
        pth.close[i] = NaN
        pth.low[i] = NaN
      }
      return pth
    },
    source:
      'eth-usd-1h.json oracle column alone: Chainlink ETH/USD; starts after the Mar-2020 crash',
  },
  'ETH-coinbase': {
    symbol: 'WETH',
    label: 'ETH (Coinbase market path)',
    resolution: 'low-close',
    cases: LL_ONLY,
    sensitivity: true,
    build: () =>
      hourlyPathFromGrid('eth-coinbase', gridFromFile(load('eth-usd-1h.json'), 'coinbase')),
    source: 'eth-usd-1h.json coinbase column: market klines (deeper wicks than the oracle)',
  },
  'BTC-coinbase': {
    symbol: 'WBTC',
    label: 'BTC (Coinbase market path)',
    resolution: 'low-close',
    cases: LL_ONLY,
    sensitivity: true,
    build: () =>
      hourlyPathFromGrid('btc-coinbase', gridFromFile(load('btc-usd-1h.json'), 'coinbase')),
    source: 'btc-usd-1h.json coinbase column: market klines',
  },
  'ETH-close': {
    symbol: 'WETH',
    label: 'ETH (hourly closes only, no intra-hour lows)',
    resolution: 'close',
    cases: LL_ONLY,
    sensitivity: true,
    build: ethPrimary,
    source: 'ETH primary, closes only',
  },
}

// ------------------------------------------------------------------ cases

interface CaseDef {
  id: string
  tradeShape: TradeShape
  preset?: ExitCapacityPresetId
  /** Run only on these paths / classes (default: every one the path runs). */
  paths?: readonly string[]
  classes?: readonly MembraneClass[]
}

const venueOf = (slug: string) => {
  const v = EXIT_CAPACITY_VENUES.find((x) => x.slug === slug)
  if (!v) throw new Error(`no exit-capacity venue ${slug}`)
  return v
}

/** The owner's benchmark venue (instruction 2026-10-06: "typical Aave capacity during
 *  stress"). The pro-rata FLOOR runs on every main path and class. */
const AAVE_USDC_FLOOR: readonly ExitCapacityPresetId[] = venueOf('aave-usdc').floor

/** The cash-vs-book HEADLINE at Aave USDC, every book × level (ETH, both classes); the default
 *  ($50M typical) is its own case, on every main path and class. */
const AAVE_USDC_BOOKS: readonly ExitCapacityPresetId[] = EXIT_CAPACITY_BOOKS.flatMap(
  (b) => venueOf('aave-usdc').books[b.id],
).filter((id) => id !== EXIT_CAPACITY_DEFAULT_PRESET)

/** The $50M-book typical level at the other venues the memo quotes (ETH, delayed class). */
const VENUE_SWEEP_HEADLINE: readonly ExitCapacityPresetId[] = [
  'steakhouse-usdc',
  'spark-usds',
  'aave-usdt',
].map((slug) => exitCapacityPresetId(slug as never, EXIT_CAPACITY_DEFAULT_BOOK, 'typical'))

/** Every other STABLE venue's floor levels: the per-venue table, ETH, delayed class. ETH supply
 *  markets (Aave/Spark WETH) are left out: carry deploys CDT debt as a stable. */
const VENUE_SWEEP_FLOOR: readonly ExitCapacityPresetId[] = EXIT_CAPACITY_VENUES.filter(
  (v) => v.asset === 'stable' && v.slug !== 'aave-usdc',
).flatMap((v) => v.floor)

// (`Partial` is this file's partial-result type, so the restriction is spelled out.)
const carryCase = (
  preset: ExitCapacityPresetId,
  extra: Pick<CaseDef, 'paths' | 'classes'> = {},
): CaseDef => ({
  id: `carry:${preset}`,
  tradeShape: 'carry',
  preset,
  ...extra,
})

const ETH_DELAYED: Pick<CaseDef, 'paths' | 'classes'> = { paths: ['ETH'], classes: ['delayed'] }

const CASES: readonly CaseDef[] = [
  { id: 'levered_long', tradeShape: 'levered_long' },
  carryCase('optimistic'),
  carryCase('frozen'),
  carryCase(EXIT_CAPACITY_DEFAULT_PRESET),
  ...AAVE_USDC_BOOKS.map((p) => carryCase(p, { paths: ['ETH'] })),
  ...AAVE_USDC_FLOOR.map((p) => carryCase(p)),
  ...VENUE_SWEEP_HEADLINE.map((p) => carryCase(p, ETH_DELAYED)),
  ...VENUE_SWEEP_FLOOR.map((p) => carryCase(p, ETH_DELAYED)),
]

/** Carry cases with this key resolve to the same venue stock, so the same answer. */
function stockKey(preset: ExitCapacityPresetId): string {
  const x = EXIT_CAPACITY_PRESETS[preset]
  return x.mult === 0 ? 'none' : `${x.mult}@${x.freezeHours}h`
}

const CLASSES: readonly MembraneClass[] = ['delayed', 'no-delay']

/** Reference start LTVs the A10 question needs (levered_long only): 2x and HF 2. */
function referenceLtvs(line: number): { label: string; ltv: number }[] {
  return [
    { label: '2x leverage (LTV 50%)', ltv: 0.5 },
    { label: `HF 2 (LTV ${(line * 50).toFixed(1)}%)`, ltv: line / 2 },
  ]
}

// ------------------------------------------------------------------ run

const iso = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 16) + 'Z'

interface ResultRow {
  pathId: string
  caseId: string
  membraneClass: MembraneClass
  horizon: string
  hours: number
  /** Start hours in the population. */
  n: number
  k: number
  solvedStarts: number
  runs: number
  seconds: number
  /** ℓ* tail, raw (bisection low end). */
  neverSold: number
  p1: number
  p5: number
  /** True when the value is the borrow cap (no sale even at the cap). */
  neverSoldCapBound: boolean
  p1CapBound: boolean
  p5CapBound: boolean
  /** Share of start hours whose path crosses the line at the never-sold LTV (a call fires). */
  breachShareAtNeverSold: number
  worst: {
    startIndex: number
    startTs: string
    troughTs: string
    troughDrawdown: number
    safe: number
    triggersAt: number | null
    saleReason: string | null
    hoursToSale: number | null
    peakLtvAtTrigger: number | null
  } | null
  soldShareAt?: { label: string; ltv: number; share: number; sold: number }[]
  check: { windows: number; probes: number; violations: number; boundViolations: number }
  /** Copied from this case's row in the same cell: the same venue stock (`stockKey`). */
  aliasOf?: string
  /** Copied from a published run solved under this code version (`--seed`). */
  seededFrom?: string
  /** `--seed` by stock: the published case the row was solved under (the same stock). */
  seededAs?: string
}

function runPath(
  pathId: string,
  horizons: readonly { label: string; hours: number }[],
  stride: number,
  caseFilter?: Set<string>,
  classes: readonly MembraneClass[] = CLASSES,
  collateralUsd: number = SET_AND_FORGET_COLLATERAL_USD,
  caseShard?: string,
) {
  const def = PATHS[pathId]
  if (!def) throw new Error(`unknown --path ${pathId}; one of ${Object.keys(PATHS).join(', ')}`)
  const line = membraneMaxLtv(def.symbol)
  const cls = membraneAssetClass(def.symbol)
  if (line === null || cls === null) throw new Error(`${def.symbol}: no Membrane line`)
  const p = def.build()
  const cov = pathCoverage(p)
  if (!cov) throw new Error(`${pathId}: empty path`)
  const rows: ResultRow[] = []
  const cases = CASES.filter(
    (c) =>
      (def.cases ? def.cases.includes(c.id) : true) &&
      (caseFilter ? caseFilter.has(c.id) : true) &&
      (c.paths ? c.paths.includes(pathId) : true),
  )
  for (const h of horizons) {
    const minr = windowMinRatios(p, h.hours, def.resolution)
    const starts: number[] = []
    for (let s = cov.fromIndex; s + h.hours <= cov.toIndex; s++) {
      if ((s - cov.fromIndex) % stride === 0 && Number.isFinite(minr[s])) starts.push(s)
    }
    const n = starts.length
    if (n === 0) {
      console.log(`${pathId} ${h.label}: no complete window`)
      continue
    }
    const k = tailK(n)
    for (const membraneClass of classes) {
      const band = MEMBRANE_CLASS_PARAMS[membraneClass].band
      const solvedByStock = new Map<string, ResultRow>()
      for (const cd of cases) {
        if (cd.classes && !cd.classes.includes(membraneClass)) continue
        const key = cd.preset ? stockKey(cd.preset) : null
        const same = key ? solvedByStock.get(key) : undefined
        if (same) {
          const copy: ResultRow = {
            ...same,
            caseId: cd.id,
            runs: 0,
            seconds: 0,
            aliasOf: same.aliasOf ?? same.caseId,
          }
          rows.push(copy)
          console.log(`${pathId} ${membraneClass} ${cd.id} ${h.label}: = ${copy.aliasOf}`)
          continue
        }
        const t0 = Date.now()
        const c: SetAndForgetCase = {
          line,
          membraneClass,
          tradeShape: cd.tradeShape,
          exitCapacityPreset: cd.preset,
          collateralUsd,
        }
        const cap = caseBorrowCap(c)
        // Nothing (or, behind a measured lock, at most 1% of the deployed debt) to recall: the
        // levered-long bracket is a good first guess. A HINT only (below).
        const noRecall =
          cd.tradeShape === 'levered_long' ||
          EXIT_CAPACITY_PRESETS[cd.preset!].mult <= EXIT_CAPACITY_ANALOG_SOURCE.lockF
        const lb = (s: number) => noBreachBound(line, minr[s])
        let runs = 0
        let boundViolations = 0
        const tail = solveLowTail<StartSolve>(starts, lb, k, (s) => {
          const shape = windowReplay(p, s, h.hours, def.resolution)!
          // With nothing to recall the trough LTV past the break line is an immediate sale:
          // a bracket HINT only — the engine verifies it before bisection uses it (a tiny
          // recall that cures at the hint fails the check, costing one run).
          const hint = noRecall ? line * (1 + band) * minr[s] * (1 + LOWER_BOUND_SLACK) : undefined
          const sol = solveStartLtv(c, shape, {
            lowerBound: lb(s),
            upperHint: hint,
            tol: SET_AND_FORGET_LTV_TOL,
          })
          runs += sol.runs
          if (sol.boundViolated) boundViolations++
          return { safe: sol.safe, result: sol }
        })
        const [f0, f1, f5] = TAIL_FRACTIONS
        const neverSold = tailQuantile(tail.lowest, n, f0)
        const p1 = tailQuantile(tail.lowest, n, f1)
        const p5 = tailQuantile(tail.lowest, n, f5)
        // Worst window: the solved start with the smallest safe value (earliest on a tie).
        let worstKey = -1
        let worstSafe = Infinity
        for (const [key, sol] of tail.solved) {
          if (sol.safe < worstSafe || (sol.safe === worstSafe && key < worstKey)) {
            worstSafe = sol.safe
            worstKey = key
          }
        }
        const ws = tail.solved.get(worstKey)!
        const trough = windowTrough(p, worstKey, h.hours, def.resolution)
        let breach = 0
        for (const s of starts) if (lb(s) < neverSold) breach++

        // Monotonicity spot-check on the 10 worst windows: every whole-% LTV between the
        // proven bound and the solved edge must not sell (a sold island there would be a
        // missed earlier edge).
        const worstKeys = [...tail.solved.entries()]
          .sort((a, b) => a[1].safe - b[1].safe)
          .slice(0, 10)
          .map(([key]) => key)
        let probes = 0
        let violations = 0
        for (const s of worstKeys) {
          const sol = tail.solved.get(s)!
          const shape = windowReplay(p, s, h.hours, def.resolution)!
          for (let pct = Math.ceil(lb(s) * 100); pct / 100 <= sol.safe; pct++) {
            probes++
            runs++
            if (isSold(runCase(c, shape, pct / 100))) violations++
          }
        }

        // A10 reference LTVs (levered_long only): share of start hours sold.
        let soldShareAt: ResultRow['soldShareAt']
        if (cd.tradeShape === 'levered_long') {
          soldShareAt = referenceLtvs(line).map(({ label, ltv }) => {
            let sold = 0
            for (const s of starts) {
              if (lb(s) >= ltv) continue // never crosses the line: nothing calls
              const sol = tail.solved.get(s)
              if (sol) {
                if (ltv <= sol.safe) continue // tested clean at or above this LTV
                if (sol.triggersAt !== null && ltv >= sol.triggersAt) {
                  sold++ // levered_long is monotone in the start LTV (setAndForget.ts header)
                  continue
                }
              }
              const shape = windowReplay(p, s, h.hours, def.resolution)!
              runs++
              if (isSold(runCase(c, shape, ltv))) sold++
            }
            return { label, ltv, share: sold / n, sold }
          })
        }

        const row: ResultRow = {
          pathId,
          caseId: cd.id,
          membraneClass,
          horizon: h.label,
          hours: h.hours,
          n,
          k,
          solvedStarts: tail.solvedCount,
          runs,
          seconds: (Date.now() - t0) / 1000,
          neverSold,
          p1,
          p5,
          neverSoldCapBound: neverSold >= cap,
          p1CapBound: p1 >= cap,
          p5CapBound: p5 >= cap,
          breachShareAtNeverSold: breach / n,
          // A cap-bound tail has no worst window: no start sold even at the cap.
          worst:
            neverSold >= cap
              ? null
              : {
                  startIndex: worstKey,
                  startTs: iso(p.startTs + worstKey * 3600),
                  troughTs: trough ? iso(p.startTs + trough.index * 3600) : '',
                  troughDrawdown: trough ? 1 - trough.ratio : NaN,
                  safe: ws.safe,
                  triggersAt: ws.triggersAt,
                  saleReason: ws.at?.saleReason ?? null,
                  hoursToSale:
                    ws.at?.timeToSaleSeconds != null ? ws.at.timeToSaleSeconds / 3600 : null,
                  peakLtvAtTrigger: ws.at ? ws.at.peakLtv : null,
                },
          soldShareAt,
          check: { windows: worstKeys.length, probes, violations, boundViolations },
        }
        rows.push(row)
        if (key) solvedByStock.set(key, row)
        console.log(
          `${pathId} ${membraneClass} ${cd.id} ${h.label}: n=${n} solved=${tail.solvedCount} runs=${runs} ` +
            `${row.seconds.toFixed(1)}s | never ${(neverSold * 100).toFixed(2)}% p1 ${(p1 * 100).toFixed(2)}% ` +
            `p5 ${(p5 * 100).toFixed(2)}% (cap ${(cap * 100).toFixed(0)}%) worst ${row.worst?.startTs ?? 'none (cap-bound)'} ` +
            `dd ${row.worst ? (row.worst.troughDrawdown * 100).toFixed(1) : '-'}% ${row.worst?.saleReason ?? ''} | check ${violations}/${probes}`,
        )
      }
    }
  }
  const partial = {
    pathId,
    label: def.label,
    symbol: def.symbol,
    source: def.source,
    sensitivity: def.sensitivity ?? false,
    resolution: def.resolution,
    line,
    listingCap: membraneAssetLtvCap(def.symbol),
    listingClass: cls,
    borrowCap: line - BORROW_LTV_GAP,
    coverage: {
      from: iso(p.startTs + cov.fromIndex * 3600),
      to: iso(p.startTs + cov.toIndex * 3600),
    },
    stride,
    collateralUsd,
    debtMinimumUsd: LIQ_DEBT_MINIMUM_USD,
    tol: SET_AND_FORGET_LTV_TOL,
    codeVersion: STRESS_CODE_VERSION,
    rows,
  }
  fs.mkdirSync(PARTIAL_DIR, { recursive: true })
  // A run over a subset of cases or horizons is a probe ('.partial', ignored by --report); a
  // run over a subset of classes is a shard ('@<class>', merged by --report).
  const probe =
    (caseFilter && !caseShard) ||
    horizons.length !== SET_AND_FORGET_HORIZONS.length ||
    collateralUsd !== SET_AND_FORGET_COLLATERAL_USD
      ? '.partial'
      : ''
  const shard =
    (classes.length === CLASSES.length ? '' : `@${classes.join('+')}`) +
    (caseShard ? `#${caseShard}` : '')
  fs.writeFileSync(
    path.join(PARTIAL_DIR, `${pathId}${shard}${probe}.json`),
    JSON.stringify(partial),
  )
}

// ------------------------------------------------------------------ copy claims

/**
 * COPY CLAIMS (refuter finding 2026-10-06). The doc's A1 line quotes ONE cell at ONE start
 * LTV, and the ℓ* table it reads from holds for LARGE positions only: at $100,000 of
 * collateral the $2,000 debt floor never decides whether a sale happens, but under ~2 × that
 * floor in debt a carry position's first recall closes the whole loan (setAndForget.ts
 * MONOTONICITY). So each claim is measured directly with `tallyAtLtv` — one plain engine run
 * per start hour at the claimed LTV, no bisection — at several position sizes, with a
 * levered long at the same LTV and sizes as the reference row.
 */
interface ClaimDef {
  id: string
  label: string
  pathId: string
  membraneClass: MembraneClass
  /** The claimed start LTV from the path's line. */
  ltv: (line: number) => number
  ltvLabel: string
  caseIds: readonly string[]
  horizons: readonly string[]
  collateralUsd: readonly number[]
}

const CLAIMS: readonly ClaimDef[] = [
  {
    id: 'A1',
    label:
      'ETH carry, the deployed debt at Aave USDC stress capacity (cash vs book at $10M / $50M / $250M, and the everyone-exits floor; typical and bad events), at HF 2 — "set it and forget it"',
    pathId: 'ETH',
    membraneClass: 'delayed',
    ltv: (line) => line / 2,
    ltvLabel: 'HF 2 (line / 2)',
    caseIds: [
      ...EXIT_CAPACITY_BOOKS.flatMap((b) =>
        (['typical', 'bad'] as const).map(
          (l) => `carry:${exitCapacityPresetId('aave-usdc', b.id, l)}`,
        ),
      ),
      'carry:aave-usdc-floor-typical',
      'carry:aave-usdc-floor-bad',
      'levered_long',
    ],
    horizons: ['90d', '365d'],
    // Debt at 40% LTV: $2,000 (= the floor), $3,999.60 and $4,000 (either side of
    // 2 × the floor), $8,000, $40,000 (the table's size).
    collateralUsd: [5_000, 9_999, 10_000, 20_000, SET_AND_FORGET_COLLATERAL_USD],
  },
]

interface ClaimRow extends LtvTally {
  /** `--claims --cases`: copied from the published run under this code version (case not re-run). */
  seededFrom?: string
  /** Copied from the published case it was measured under (the same venue stock). */
  seededAs?: string
  /** Copied from this case in the same run: the same venue stock. */
  aliasOf?: string
  claimId: string
  pathId: string
  caseId: string
  membraneClass: MembraneClass
  horizon: string
  collateralUsd: number
  debtUsd: number
  share: number
  seconds: number
}

/**
 * `--claims [--horizons] [--cases]`. With `--cases`, only those cases are measured; every other
 * case's rows are copied from the PUBLISHED claims (`seededFrom`) of a case with the SAME venue
 * stock (`stockKey`; `seededAs` names it when its id differs) — levered_long by id — and a
 * missing one throws. Cases of one stock are measured once per run (`aliasOf`).
 */
function runClaims(horizonFilter?: readonly string[], caseFilter?: ReadonlySet<string>) {
  fs.mkdirSync(CLAIM_DIR, { recursive: true })
  const pubFile = caseFilter
    ? (JSON.parse(fs.readFileSync(OUT, 'utf8')) as {
        codeVersion: string
        mechanics?: {
          exitCapacity?: { presets?: Record<string, { mult: number; freezeHours: number }> }
        }
        claims?: { claimId: string; horizon: string; rows: ClaimRow[] }[]
      })
    : null
  const published = pubFile?.claims ?? []
  const publishedVersion = pubFile?.codeVersion ?? ''
  const pubStock = pubFile ? publishedStock(pubFile) : () => null
  const keyOf = (caseId: string) => {
    const cd = CASES.find((x) => x.id === caseId)
    if (!cd) throw new Error(`claims: unknown case ${caseId}`)
    return cd.preset ? stockKey(cd.preset) : caseId
  }
  for (const cl of CLAIMS) {
    const def = PATHS[cl.pathId]
    const line = membraneMaxLtv(def.symbol)
    if (line === null) throw new Error(`${def.symbol}: no Membrane line`)
    const ltv = cl.ltv(line)
    const p = def.build()
    const cov = pathCoverage(p)
    if (!cov) throw new Error(`${cl.pathId}: empty path`)
    for (const hz of cl.horizons) {
      if (horizonFilter && !horizonFilter.includes(hz)) continue
      const h = SET_AND_FORGET_HORIZONS.find((x) => x.label === hz)!
      const minr = windowMinRatios(p, h.hours, def.resolution)
      // The SAME start population as the table (runPath, stride 1).
      const starts: number[] = []
      for (let s = cov.fromIndex; s + h.hours <= cov.toIndex; s++) {
        if (Number.isFinite(minr[s])) starts.push(s)
      }
      const rows: ClaimRow[] = []
      const measured = new Map<string, string>() // stock → the case measured under it
      for (const caseId of cl.caseIds) {
        const cd = CASES.find((x) => x.id === caseId)!
        const key = keyOf(caseId)
        const same = measured.get(key)
        if (same) {
          for (const r of rows.filter((x) => x.caseId === same)) {
            const { seededAs: _as, ...rest } = r
            rows.push({ ...rest, caseId, seconds: 0, aliasOf: same })
          }
          console.log(`claim ${cl.id} ${caseId} ${hz}: = ${same}`)
          continue
        }
        if (caseFilter && !caseFilter.has(caseId)) {
          const pub = published.find((c) => c.claimId === cl.id && c.horizon === hz)
          const pubRows = pub?.rows ?? []
          const srcCase =
            pubRows.find(
              (r) => r.caseId === caseId && (cd.preset ? pubStock(r.caseId) === key : true),
            )?.caseId ??
            (cd.preset ? pubRows.find((r) => pubStock(r.caseId) === key)?.caseId : undefined)
          const copied = srcCase ? pubRows.filter((r) => r.caseId === srcCase) : []
          if (copied.length !== cl.collateralUsd.length)
            throw new Error(
              `--claims --cases: no published ${cl.id} ${hz} rows at ${caseId}'s stock`,
            )
          for (const r of copied) {
            const { aliasOf: _alias, ...rest } = r
            rows.push({
              ...rest,
              caseId,
              seededFrom: r.seededFrom ?? publishedVersion,
              ...(srcCase !== caseId ? { seededAs: srcCase } : {}),
            })
          }
          measured.set(key, caseId)
          console.log(
            `claim ${cl.id} ${caseId} ${hz}: ${copied.length} rows copied (published${srcCase !== caseId ? ` as ${srcCase}` : ''})`,
          )
          continue
        }
        measured.set(key, caseId)
        for (const collateralUsd of cl.collateralUsd) {
          const t0 = Date.now()
          const c: SetAndForgetCase = {
            line,
            membraneClass: cl.membraneClass,
            tradeShape: cd.tradeShape,
            exitCapacityPreset: cd.preset,
            collateralUsd,
          }
          const t = tallyAtLtv(c, p, starts, h.hours, ltv, def.resolution, minr)
          const row: ClaimRow = {
            claimId: cl.id,
            pathId: cl.pathId,
            caseId,
            membraneClass: cl.membraneClass,
            horizon: hz,
            collateralUsd,
            debtUsd: ltv * collateralUsd,
            ...t,
            share: t.sold / t.n,
            seconds: (Date.now() - t0) / 1000,
          }
          rows.push(row)
          console.log(
            `claim ${cl.id} ${caseId} ${hz} $${collateralUsd} (debt $${row.debtUsd.toFixed(2)}): ` +
              `sold ${t.sold}/${t.n} = ${(row.share * 100).toFixed(2)}% ` +
              `${JSON.stringify(t.bySaleReason)} | recall drew in ${t.recalled}${drawnLabel(t)} | ` +
              `${t.runs} runs ${row.seconds.toFixed(1)}s`,
          )
        }
      }
      fs.writeFileSync(
        path.join(CLAIM_DIR, `${cl.id}@${hz}.json`),
        JSON.stringify({
          claimId: cl.id,
          label: cl.label,
          pathId: cl.pathId,
          line,
          ltv,
          ltvLabel: cl.ltvLabel,
          horizon: hz,
          coverage: {
            from: iso(p.startTs + cov.fromIndex * 3600),
            to: iso(p.startTs + cov.toIndex * 3600),
          },
          debtMinimumUsd: LIQ_DEBT_MINIMUM_USD,
          codeVersion: STRESS_CODE_VERSION,
          rows,
        }),
      )
    }
  }
}

/** ", unwinding a median X% (p95 Y%, max Z%) of the deployed debt" — or nothing. */
function drawnLabel(t: LtvTally): string {
  const d = t.recallDrawnShareOfDebt
  if (!d) return ''
  const p = (x: number) => `${(x * 100).toFixed(1)}%`
  return `, unwinding a median ${p(d.median)} (p95 ${p(d.p95)}, max ${p(d.max)}) of the deployed debt`
}

/** Every measured claim file, ordered by claim then horizon. */
function loadClaims(): { claimId: string; horizon: string; rows: ClaimRow[] }[] {
  if (!fs.existsSync(CLAIM_DIR)) return []
  const hz = SET_AND_FORGET_HORIZONS.map((h) => h.label as string)
  const ids = CLAIMS.map((c) => c.id)
  return fs
    .readdirSync(CLAIM_DIR)
    .filter((f) => f.endsWith('.json'))
    .map(
      (f) =>
        JSON.parse(fs.readFileSync(path.join(CLAIM_DIR, f), 'utf8')) as {
          claimId: string
          horizon: string
          rows: ClaimRow[]
        },
    )
    .sort(
      (a, b) =>
        ids.indexOf(a.claimId) - ids.indexOf(b.claimId) ||
        hz.indexOf(a.horizon) - hz.indexOf(b.horizon),
    )
}

// ------------------------------------------------------------------ report

type Partial = {
  pathId: string
  label: string
  symbol: string
  source: string
  sensitivity: boolean
  resolution: PathResolution
  line: number
  listingCap: number | null
  listingClass: MembraneClass
  borrowCap: number
  coverage: { from: string; to: string }
  stride: number
  rows: ResultRow[]
}

const pct1 = (x: number, capBound = false) =>
  `${capBound ? '≥' : ''}${(floorTo(x, 3) * 100).toFixed(1)}%`

/** "never / ≤1% / ≤5%" in whole tenths of a percent, floored; "cap" when cap-bound. */
function tailCell(r: ResultRow | undefined): string {
  if (!r) return 'n/a'
  const v = (x: number, cb: boolean) => (cb ? 'cap' : (floorTo(x, 3) * 100).toFixed(1))
  return `${v(r.neverSold, r.neverSoldCapBound)} / ${v(r.p1, r.p1CapBound)} / ${v(r.p5, r.p5CapBound)}`
}

/** The doc's tables: delayed-class tails, the delay's value, and the A10 sold shares. */
function headline(partials: Partial[]) {
  const main = partials.filter((p) => !p.sensitivity)
  const find = (p: Partial, caseId: string, cls: MembraneClass, horizon: string) =>
    p.rows.find((r) => r.caseId === caseId && r.membraneClass === cls && r.horizon === horizon)
  const hz = SET_AND_FORGET_HORIZONS.map((h) => h.label)
  const presetCase = (id: ExitCapacityPresetId): [string, string] => {
    const x = EXIT_CAPACITY_PRESETS[id]
    return [
      `carry:${id}`,
      `carry, ${x.label} (×${x.mult}${x.freezeHours > 0 ? `, locked ${x.freezeHours} h` : ''})`,
    ]
  }
  const DEFAULT_CASE = `carry:${EXIT_CAPACITY_DEFAULT_PRESET}`
  const shapes: [string, string][] = [
    ['levered_long', 'levered long (= carry, frozen venue)'],
    presetCase('aave-usdc-floor-worst'),
    presetCase('aave-usdc-floor-bad'),
    presetCase('aave-usdc-floor-typical'),
    presetCase(EXIT_CAPACITY_DEFAULT_PRESET),
    presetCase('optimistic'),
  ]
  const eth = main.find((p) => p.pathId === 'ETH')
  if (eth) {
    console.log(
      '## HEADLINE — ETH, cash vs book at Aave USDC: start LTV % never / ≤1% / ≤5% of start hours sold',
    )
    console.log(`| book · level | ×mult (lock) | class | ${hz.join(' | ')} |`)
    console.log(`|---|---|---|${hz.map(() => '---').join('|')}|`)
    const ids = [
      ...EXIT_CAPACITY_BOOKS.flatMap((bk) => venueOf('aave-usdc').books[bk.id]),
      ...venueOf('aave-usdc').floor,
    ]
    for (const id of ids) {
      const x = EXIT_CAPACITY_PRESETS[id]
      for (const cls of CLASSES) {
        console.log(
          `| ${x.label} | ×${x.mult}${x.freezeHours > 0 ? ` (${x.freezeHours} h)` : ''} | ${cls} | ` +
            hz.map((h) => tailCell(find(eth, `carry:${id}`, cls, h))).join(' | ') +
            ' |',
        )
      }
    }
    for (const cls of CLASSES) {
      console.log(
        `| levered long | — | ${cls} | ` +
          hz.map((h) => tailCell(find(eth, 'levered_long', cls, h))).join(' | ') +
          ' |',
      )
    }
    console.log('')
  }
  console.log(
    '## EVERY MAIN PATH — delayed class, start LTV % never / ≤1% / ≤5% of start hours sold',
  )
  console.log(`| asset · line | shape | ${hz.join(' | ')} |`)
  console.log(`|---|---|${hz.map(() => '---').join('|')}|`)
  for (const p of main) {
    for (const [id, label] of shapes) {
      console.log(
        `| ${p.label.split(' ')[0]} · ${(p.line * 100).toFixed(0)}% | ${label} | ` +
          hz.map((h) => tailCell(find(p, id, 'delayed', h))).join(' | ') +
          ' |',
      )
    }
  }
  // frozen ≡ levered_long (nothing to recall): verify, cell by cell.
  let same = 0
  let total = 0
  for (const p of main) {
    for (const cls of CLASSES) {
      for (const h of hz) {
        const a = find(p, 'levered_long', cls, h)
        const b = find(p, 'carry:frozen', cls, h)
        if (!a || !b) continue
        total++
        if (a.neverSold === b.neverSold && a.p1 === b.p1 && a.p5 === b.p5) same++
      }
    }
  }
  console.log(`\ncarry:frozen == levered_long in ${same}/${total} cells`)

  console.log(
    '\n## PER VENUE — ETH, delayed class, carry at each stable venue: $50M-book typical (where run) and the floor: never / ≤1% / ≤5%',
  )
  if (eth) {
    console.log(`| venue · level | ×mult (lock) | ${hz.join(' | ')} |`)
    console.log(`|---|---|${hz.map(() => '---').join('|')}|`)
    for (const v of EXIT_CAPACITY_VENUES.filter((x) => x.asset === 'stable')) {
      const head = exitCapacityPresetId(v.slug, EXIT_CAPACITY_DEFAULT_BOOK, 'typical')
      for (const id of [head, ...v.floor]) {
        if (!eth.rows.some((r) => r.caseId === `carry:${id}`)) continue
        const x = EXIT_CAPACITY_PRESETS[id]
        console.log(
          `| ${x.label} | ×${x.mult}${x.freezeHours > 0 ? ` (${x.freezeHours} h)` : ''} | ` +
            hz.map((h) => tailCell(find(eth, `carry:${id}`, 'delayed', h))).join(' | ') +
            ' |',
        )
      }
    }
  }

  console.log(
    '\n## DELAY VALUE — never-sold start LTV %, delayed (8h, 4% band) vs instant at the line',
  )
  console.log(`| asset | shape | ${hz.join(' | ')} |`)
  console.log(`|---|---|${hz.map(() => '---').join('|')}|`)
  for (const p of main) {
    for (const id of [
      'levered_long',
      'carry:aave-usdc-floor-bad',
      'carry:aave-usdc-floor-typical',
      DEFAULT_CASE,
    ]) {
      const cells = hz.map((h) => {
        const d = find(p, id, 'delayed', h)
        const n = find(p, id, 'no-delay', h)
        if (!d || !n) return 'n/a'
        if (d.neverSoldCapBound) return n.neverSoldCapBound ? 'cap vs cap' : 'cap'
        const dv = floorTo(d.neverSold, 3) * 100
        const nv = floorTo(n.neverSold, 3) * 100
        return `${dv.toFixed(1)} vs ${nv.toFixed(1)} (+${(dv - nv).toFixed(1)}; ×${(d.neverSold / n.neverSold).toFixed(3)})`
      })
      console.log(`| ${p.label.split(' ')[0]} | ${id} | ${cells.join(' | ')} |`)
    }
  }

  console.log('\n## A10 — levered long: share of start hours sold, delayed vs instant')
  for (const p of main) {
    const refs = find(p, 'levered_long', 'delayed', hz[0])?.soldShareAt ?? []
    for (let i = 0; i < refs.length; i++) {
      const cells = hz.map((h) => {
        const d = find(p, 'levered_long', 'delayed', h)?.soldShareAt?.[i]
        const n = find(p, 'levered_long', 'no-delay', h)?.soldShareAt?.[i]
        return d && n ? `${(d.share * 100).toFixed(1)}% vs ${(n.share * 100).toFixed(1)}%` : 'n/a'
      })
      console.log(`| ${p.label.split(' ')[0]} | ${refs[i].label} | ${cells.join(' | ')} |`)
    }
  }

  console.log('\n## WORST WINDOWS — levered long, delayed')
  for (const p of partials) {
    const cells = hz.map((h) => {
      const w = find(p, 'levered_long', 'delayed', h)?.worst
      return w
        ? `${w.startTs.slice(0, 10)} → ${w.troughTs.slice(0, 10)} −${(w.troughDrawdown * 100).toFixed(1)}% (${w.saleReason})`
        : 'n/a'
    })
    console.log(`| ${p.label} | ${cells.join(' | ')} |`)
  }

  console.log('\n## SENSITIVITIES — levered long, delayed, never / ≤1% / ≤5%')
  for (const p of partials) {
    console.log(
      `| ${p.label} | ${p.coverage.from.slice(0, 10)} | ` +
        hz.map((h) => tailCell(find(p, 'levered_long', 'delayed', h))).join(' | ') +
        ' |',
    )
  }
  for (const p of partials.filter((x) => x.pathId.startsWith('wstETH'))) {
    console.log(
      `| ${p.label} carry:aave-usdc-floor-typical | ` +
        hz
          .map((h) => tailCell(find(p, 'carry:aave-usdc-floor-typical', 'delayed', h)))
          .join(' | ') +
        ' |',
    )
  }

  console.log(
    '\n## RECALL FIRED — carry: share of start hours whose path crosses the line at the never-sold LTV',
  )
  for (const p of main) {
    for (const id of [
      'carry:aave-usdc-floor-bad',
      'carry:aave-usdc-floor-typical',
      DEFAULT_CASE,
      'carry:optimistic',
    ]) {
      console.log(
        `| ${p.label.split(' ')[0]} | ${id} | ` +
          hz
            .map((h) => {
              const r = find(p, id, 'delayed', h)
              return r ? `${(r.breachShareAtNeverSold * 100).toFixed(1)}%` : 'n/a'
            })
            .join(' | ') +
          ' |',
      )
    }
  }
  console.log('')
}

/**
 * The stress windows the analogs were measured on, by trigger (summary.json episodes; the
 * util windows a venue without a summary stress level derives from its own series make up
 * the rest of EXIT_CAPACITY_ANALOG_WINDOW_COUNT).
 */
function analogWindowCounts() {
  const summary = JSON.parse(
    fs.readFileSync(path.join(ROOT, EXIT_CAPACITY_ANALOG_SOURCE.summary), 'utf8'),
  ) as { episodes: { trigger: string; venue?: string }[] }
  const byTrigger: Record<string, number> = {}
  const utilByVenue: Record<string, number> = {}
  for (const e of summary.episodes) {
    const t = e.trigger.startsWith('util') ? 'util' : e.trigger
    byTrigger[t] = (byTrigger[t] ?? 0) + 1
    if (t === 'util' && e.venue) utilByVenue[e.venue] = (utilByVenue[e.venue] ?? 0) + 1
  }
  return {
    total: EXIT_CAPACITY_ANALOG_WINDOW_COUNT,
    byTrigger,
    utilByVenue,
    utilDerivedFromSeries: EXIT_CAPACITY_ANALOG_WINDOW_COUNT - summary.episodes.length,
  }
}

function report() {
  const shards: Partial[] = fs
    .readdirSync(PARTIAL_DIR)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.partial.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(PARTIAL_DIR, f), 'utf8')) as Partial)
  // Merge class shards of one path; rows ordered horizon → class → case.
  const byPath = new Map<string, Partial>()
  for (const sh of shards) {
    const have = byPath.get(sh.pathId)
    if (have) have.rows.push(...sh.rows)
    else byPath.set(sh.pathId, { ...sh, rows: [...sh.rows] })
  }
  const partials = [...byPath.values()]
  const caseOrder = CASES.map((c) => c.id)
  for (const part of partials) {
    part.rows.sort(
      (a, b) =>
        a.hours - b.hours ||
        CLASSES.indexOf(a.membraneClass) - CLASSES.indexOf(b.membraneClass) ||
        caseOrder.indexOf(a.caseId) - caseOrder.indexOf(b.caseId),
    )
  }
  const order = Object.keys(PATHS)
  partials.sort((a, b) => order.indexOf(a.pathId) - order.indexOf(b.pathId))
  const merged = {
    generatedAt: new Date().toISOString(),
    codeVersion: STRESS_CODE_VERSION,
    label: 'historical replay — not a forecast, not a probability of the future',
    method:
      'per start hour: highest start LTV with no collateral sold over the horizon (stressGrid runStress on the measured window, bisected); tail over every start hour',
    mechanics: {
      delayedBand: MAX_THRESHOLD_TO_DELAY,
      windowSeconds: CURE_WINDOW_SECONDS,
      borrowLtvGap: BORROW_LTV_GAP,
      debtMinimumUsd: LIQ_DEBT_MINIMUM_USD,
      collateralUsd: SET_AND_FORGET_COLLATERAL_USD,
      exitCapacity: {
        assumption:
          'HEADLINE cash vs book (owner ruling 2026-10-07): a recall gets m = min(1, the venue’s idle cash ÷ Membrane’s whole book B at the venue) of the deployed debt, the idle cash being the lowest over the 8 h window (held basis) in one real stress event, at B = $10M / $50M / $250M; assumes (i) the whole book recalls at once, (ii) the observed cash is first come within the hour and already net of other withdrawers, (iii) the recall does not itself trigger a run, (iv) the stock never refills across the horizon. FLOOR pro-rata: every depositor exits at once and a recall gets the withdrawable fraction (cash / supply) of the deployed debt. Either model: a locked event (≤ 1%) also gives no recall for its measured lock from the first breach',
        books: EXIT_CAPACITY_BOOKS,
        windows: analogWindowCounts(),
        /** Every measured level (both models, every venue), so the memo's venue tables trace
         *  to this file. */
        analogs: EXIT_CAPACITY_ANALOG_ROWS.map((r) => ({
          id: r.id,
          model: r.model,
          bookUsd: r.bookUsd,
          venue: r.venueName,
          asset: r.asset,
          level: r.level,
          mult: r.mult,
          freezeHours: r.freezeHours,
          locked: r.locked,
          lockH: r.lockH,
          lockCensored: r.lockCensored,
          recover5H: r.recover5H,
          recoverLowerBoundH: r.recoverLowerBoundH,
          horizonCensored: r.horizonCensored,
          cashUsd8h: r.cashUsd8h,
          event: r.event,
          onset: r.onset,
          rank: r.rank,
          n: r.n,
          from: r.from,
          to: r.to,
          // A cash-vs-book level whose book is larger than the venue's whole supply in the
          // window, and that window's floor f: the memo's flagged list traces to this file
          // (claims refuter round 3, 2026-10-07).
          ...(r.model === 'cash-vs-book'
            ? { fWindow: r.fWindow, bookExceedsVenue: r.bookExceedsVenue }
            : {}),
        })),
        source: EXIT_CAPACITY_ANALOG_SOURCE,
        dataThrough: EXIT_CAPACITY_ANALOG_DATA_THROUGH,
        presets: Object.fromEntries(
          CASES.filter((c) => c.preset).map((c) => {
            const x = EXIT_CAPACITY_PRESETS[c.preset!]
            return [
              x.id,
              {
                mult: x.mult,
                freezeHours: x.freezeHours,
                kind: x.kind,
                model: x.model,
                bookUsd: x.bookUsd,
                cashUsd8h: x.source?.cashUsd8h ?? null,
                ...(x.source
                  ? {
                      venue: x.source.venueName,
                      event: x.source.event,
                      onset: x.source.onset,
                      windows: x.source.windows,
                      rank: x.source.rank,
                      n: x.source.n,
                      from: x.source.from,
                      to: x.source.to,
                    }
                  : {}),
              },
            ]
          }),
        ),
      },
    },
    paths: partials,
    claimsMethod:
      'per claim: share of start hours sold at the claimed start LTV — one stressGrid runStress per start hour, no bisection — at several position sizes (the $2,000 debt floor decides small positions)',
    claims: loadClaims(),
  }
  fs.writeFileSync(OUT, JSON.stringify(merged))
  console.log(`wrote ${path.relative(ROOT, OUT)} (${fs.statSync(OUT).size} bytes)\n`)

  headline(partials)

  for (const part of partials) {
    console.log(
      `\n### ${part.label} — line ${(part.line * 100).toFixed(0)}%, borrow cap ${(part.borrowCap * 100).toFixed(0)}%, ` +
        `${part.coverage.from} → ${part.coverage.to}, stride ${part.stride}h, ${part.resolution}`,
    )
    console.log(
      '| shape | class | horizon | never sold | ≤1% sold | ≤5% sold | starts | worst window (entry → trough, drawdown, sale) |',
    )
    console.log('|---|---|---|---|---|---|---|---|')
    for (const r of part.rows) {
      const w = r.worst
      console.log(
        `| ${r.caseId} | ${r.membraneClass} | ${r.horizon} | ${pct1(r.neverSold, r.neverSoldCapBound)} | ` +
          `${pct1(r.p1, r.p1CapBound)} | ${pct1(r.p5, r.p5CapBound)} | ${r.n} | ` +
          (w
            ? `${w.startTs.slice(0, 13)} → ${w.troughTs.slice(0, 13)}, −${(w.troughDrawdown * 100).toFixed(1)}%, ${w.saleReason ?? 'none'}${w.hoursToSale != null ? ` @${w.hoursToSale.toFixed(1)}h` : ''}`
            : '') +
          ' |',
      )
    }
    const ll = part.rows.filter((r) => r.soldShareAt)
    if (ll.length) {
      console.log(
        '\n| class | horizon | ' +
          ll[0].soldShareAt!.map((x) => `sold at ${x.label}`).join(' | ') +
          ' |',
      )
      console.log('|---|---|' + ll[0].soldShareAt!.map(() => '---').join('|') + '|')
      for (const r of ll) {
        console.log(
          `| ${r.membraneClass} | ${r.horizon} | ` +
            r
              .soldShareAt!.map((x) => `${(x.share * 100).toFixed(2)}% (${x.sold}/${r.n})`)
              .join(' | ') +
            ' |',
        )
      }
    }
    const checks = part.rows.reduce(
      (a, r) => ({
        probes: a.probes + r.check.probes,
        violations: a.violations + r.check.violations,
        bound: a.bound + r.check.boundViolations,
      }),
      { probes: 0, violations: 0, bound: 0 },
    )
    console.log(
      `\nchecks: ${checks.violations} sold islands in ${checks.probes} whole-% probes under the solved edge; ` +
        `${checks.bound} lower-bound violations`,
    )
  }
  console.log('\n## COPY CLAIMS — share of start hours sold at the claimed LTV, by position size')
  for (const f of merged.claims) {
    for (const r of f.rows) {
      console.log(
        `| ${r.claimId} | ${r.horizon} | ${r.caseId} | $${r.collateralUsd} (debt $${r.debtUsd.toFixed(0)}) | ` +
          `${(r.share * 100).toFixed(2)}% (${r.sold}/${r.n}) | ${JSON.stringify(r.bySaleReason)} | ` +
          `recall drew in ${((r.recalled / r.n) * 100).toFixed(1)}%${drawnLabel(r)} |`,
      )
    }
  }
  console.log(
    `\nleverage at start LTV: ${[0.3, 0.4, 0.5, 0.6].map((l) => `${l * 100}% → ${loopLeverage(l).toFixed(2)}x`).join(', ')}; ` +
      `HF at ETH line 80%: ${[0.4, 0.5].map((l) => `${l * 100}% → ${healthFactor(0.8, l).toFixed(2)}`).join(', ')}`,
  )
}

// ------------------------------------------------------------------ main

/**
 * The venue stock a PUBLISHED carry case had (`stockKey` on the published
 * mechanics.exitCapacity.presets, read by the published case's own preset id — so a case
 * renamed since, e.g. 'carry:aave-usdc-typical' → 'carry:aave-usdc-floor-typical', still
 * maps). Null for levered_long or an unknown preset.
 */
function publishedStock(pub: {
  mechanics?: { exitCapacity?: { presets?: Record<string, { mult: number; freezeHours: number }> } }
}): (caseId: string) => string | null {
  const was = pub.mechanics?.exitCapacity?.presets ?? {}
  return (caseId) => {
    const x = caseId.startsWith('carry:') ? was[caseId.slice('carry:'.length)] : undefined
    if (!x) return null
    return x.mult === 0 ? 'none' : `${x.mult}@${x.freezeHours}h`
  }
}

/**
 * `--seed`: published rows the engine cannot move, as '#seed' shards. A carry case is seeded
 * BY STOCK (`stockKey`): from the published row, in the same path × class × horizon cell, of a
 * case whose PUBLISHED preset had the stock this case has NOW (mechanics.exitCapacity.presets
 * of the published JSON) — the same stock is the same answer, whatever case it was solved
 * under (`seededAs`). A cell with no such row is left to be solved. Levered long has no stock
 * and is seeded by id.
 */
function seed(caseIds: readonly string[]) {
  for (const id of caseIds)
    if (!CASES.some((c) => c.id === id)) throw new Error(`--seed: unknown case ${id}`)
  const pub = JSON.parse(fs.readFileSync(OUT, 'utf8')) as {
    mechanics?: {
      exitCapacity?: { presets?: Record<string, { mult: number; freezeHours: number }> }
    }
    paths: (Partial & { codeVersion: string })[]
  }
  const pubStock = publishedStock(pub)
  fs.mkdirSync(PARTIAL_DIR, { recursive: true })
  for (const part of pub.paths) {
    const rows: ResultRow[] = []
    const def = PATHS[part.pathId]
    for (const id of caseIds) {
      const cd = CASES.find((c) => c.id === id)!
      // only the cells a fresh run would solve (runPath's case filter)
      if (def?.cases && !def.cases.includes(id)) continue
      if (cd.paths && !cd.paths.includes(part.pathId)) continue
      if (!cd.preset) {
        for (const r of part.rows)
          if (r.caseId === id) rows.push({ ...r, seededFrom: part.codeVersion })
        continue
      }
      const want = stockKey(cd.preset)
      const cells = new Set(part.rows.map((r) => `${r.hours}|${r.membraneClass}`))
      for (const cell of cells) {
        const [hours, cls] = cell.split('|')
        if (cd.classes && !cd.classes.includes(cls as MembraneClass)) continue
        const inCell = part.rows.filter((r) => String(r.hours) === hours && r.membraneClass === cls)
        // The case's own published row first, then any published row of the same stock;
        // levered_long and the bounds are skipped as sources only when their stock differs.
        const src =
          inCell.find((r) => r.caseId === id && pubStock(r.caseId) === want) ??
          inCell.find((r) => pubStock(r.caseId) === want)
        if (!src) {
          console.log(`seed ${part.pathId} ${cls} ${hours}h ${id}: no published row at ${want}`)
          continue
        }
        const { aliasOf: _alias, ...rest } = src
        rows.push({
          ...rest,
          caseId: id,
          seededFrom: part.codeVersion,
          ...(src.caseId !== id ? { seededAs: src.caseId } : {}),
        })
      }
    }
    if (!rows.length) continue
    fs.writeFileSync(
      path.join(PARTIAL_DIR, `${part.pathId}#seed.json`),
      JSON.stringify({ ...part, codeVersion: STRESS_CODE_VERSION, rows }),
    )
    console.log(`seeded ${part.pathId}: ${rows.length} rows from ${part.codeVersion}`)
  }
}

// ------------------------------------------------------------ return statement (Q20)

const RETURNS_OUT = path.join(DATA, 'set-and-forget-returns.json')
/** The net-APY history is fetched data: it lives in the private datasets repo (board rule N18).
 *  The return statement is an aggregate a doc cites and the UI serves: its canonical file is in
 *  the datasets repo, and public/data keeps the served copy. */
const NET_APY_HISTORY_FILE = netApyHistoryFileName(['aave-v3-usdc'], 1)
const RETURNS_DATASET_DIR = 'set-and-forget-returns'
const VENUE_STRESS_HISTORY = path.join(ROOT, 'public/data/venue-stress/history.json')
const OCT10_PROTOCOLS = path.join(ROOT, 'public/data/oct10-2025/protocols.json')

/**
 * The statements to measure. A1 mirrors the A1 copy claim (CLAIMS): ETH, delayed class, HF 2,
 * the deployed debt at Aave USDC under each book's typical and bad event and the floor, plus a
 * levered long — at the table's size ($100,000 of collateral, $40,000 of debt).
 */
interface ReturnDef {
  id: string
  label: string
  claimId: string
  /** lib/netApy venue key of the deployment venue (the supply series). */
  venueKey: string
  /** venue-stress history key of the same venue (the incumbent's borrow series). */
  borrowVenueKey: string
  incumbentLabel: string
  horizons: readonly string[]
  collateralUsd: number
}

const RETURNS: readonly ReturnDef[] = [
  {
    id: 'A1',
    label:
      'ETH, opened at HF 2 and left alone; the debt deployed at Aave USDC (carry) or swapped back into ETH (levered long). Membrane against Aave v3 on the same price path.',
    claimId: 'A1',
    venueKey: 'aave-v3-usdc',
    borrowVenueKey: 'aave-core-usdc',
    incumbentLabel: 'Aave v3 WETH collateral, USDC debt',
    horizons: ['30d', '90d', '365d'],
    collateralUsd: SET_AND_FORGET_COLLATERAL_USD,
  },
]

/** Named starts: a position opened at the close of the hour that begins each owner-named
 *  stress window (scripts/position-sim/build-venue-stress-history.mjs NAMED_EVENTS). */
const NAMED_STARTS: readonly { id: string; label: string; openIso: string }[] = [
  {
    id: 'named-2024-08-05',
    label: 'opened 2024-08-03, before the yen-carry unwind',
    openIso: '2024-08-03T00:00Z',
  },
  {
    id: 'named-2024-12',
    label: 'opened 2024-12-03, at the Dec-2024 leverage peak',
    openIso: '2024-12-03T00:00Z',
  },
  {
    id: 'named-2025-04',
    label: 'opened 2025-04-05, before the Apr-2025 tariff crash',
    openIso: '2025-04-05T00:00Z',
  },
  {
    id: 'named-2025-10-10',
    label: 'opened 2025-10-09 12:00, before the Oct-2025 liquidation cascade',
    openIso: '2025-10-09T12:00Z',
  },
  {
    id: 'named-2026-02',
    label: 'opened 2026-01-30, before the Feb-2026 ETH drawdown',
    openIso: '2026-01-30T00:00Z',
  },
  {
    id: 'named-2026-04-kelp',
    label: 'opened 2026-04-16, before the Apr-2026 Kelp freeze',
    openIso: '2026-04-16T00:00Z',
  },
  {
    id: 'named-2026-08-ptreusd',
    label: 'opened 2026-08-22, before the Aug-2026 PT-reUSD cascade',
    openIso: '2026-08-22T00:00Z',
  },
]

const cents = (x: number) => Math.round(x * 100) / 100
const lineOut = (l: Line) =>
  l.usd === null ? { usd: null, why: l.why } : { usd: cents(l.usd), basis: l.basis }

function membraneOut(r: MembraneReturn) {
  return {
    yieldEarned: lineOut(r.yieldEarned),
    borrowCost: lineOut(r.borrowCost),
    collateralSold: lineOut(r.collateralSold),
    yieldGivenUp: lineOut(r.yieldGivenUp),
    recallDrawnUsd: cents(r.recallDrawnUsd),
  }
}

function incumbentOut(r: IncumbentReturn) {
  return {
    yieldEarned: lineOut(r.yieldEarned),
    borrowCost: lineOut(r.borrowCost),
    netCarry: lineOut(netCarry(r)),
    collateralSold: lineOut(r.collateralSold),
    liquidationPenalty: lineOut(r.liquidationPenalty),
    yieldGivenUp: lineOut(r.yieldGivenUp),
  }
}

/** The borrow series: the hourly on-chain variable borrow APR (venue-stress history `apr`, %),
 *  stamped at the block read. One missing hour is a hole (gap 1.5 h). */
function borrowSeries(venueKey: string): { series: RateSeries; source: string } {
  const vs = JSON.parse(fs.readFileSync(VENUE_STRESS_HISTORY, 'utf8')) as {
    generatedAt: string
    timeline: { t: number[]; dt: number[] }
    venues: Record<string, { apr: (number | null)[] }>
  }
  const v = vs.venues[venueKey]
  if (!v) throw new Error(`venue-stress history: no ${venueKey}`)
  const points: { t: number; apr: number }[] = []
  vs.timeline.t.forEach((t, i) => {
    const a = v.apr[i]
    if (a !== null && a !== undefined)
      points.push({ t: t + Math.max(0, vs.timeline.dt[i]), apr: a / 100 })
  })
  const source = `public/data/venue-stress/history.json ${venueKey} apr (hourly archive reads, generated ${vs.generatedAt.slice(0, 10)})`
  return {
    series: rateSeries(`venue-stress:${venueKey}:borrowApr`, source, points, 1.5 * 3600),
    source,
  }
}

/** Why a window is not covered, as a countable class (no timestamps). */
function uncoveredClass(s: RateSeries, fromTs: number, toTs: number): string | null {
  const c = covers(s, fromTs, toTs)
  if (c.ok) return null
  if (!s.t.length || fromTs < s.t[0]) return `${s.id}: window starts before the series`
  if (toTs > s.t[s.t.length - 1] + s.maxGapSeconds) return `${s.id}: window ends after the series`
  return `${s.id}: a sample gap inside the window`
}

interface Acc {
  m: {
    yieldEarned: number[]
    yieldGivenUp: number[]
    collateralSold: number[]
    recallDrawn: number[]
  }
  i: {
    yieldEarned: number[]
    borrowCost: number[]
    netCarry: number[]
    collateralSold: number[]
    liquidationPenalty: number[]
  }
  mSold: number
  iSold: number
  recalled: number
  worst: {
    mostSold: { start: number; usd: number } | null
    leastYield: { start: number; usd: number } | null
    incumbentMostSold: { start: number; usd: number } | null
  }
}

const newAcc = (): Acc => ({
  m: { yieldEarned: [], yieldGivenUp: [], collateralSold: [], recallDrawn: [] },
  i: { yieldEarned: [], borrowCost: [], netCarry: [], collateralSold: [], liquidationPenalty: [] },
  mSold: 0,
  iSold: 0,
  recalled: 0,
  worst: { mostSold: null, leastYield: null, incumbentMostSold: null },
})

const usd = (l: Line) => l.usd

function runReturns(horizonFilter?: readonly string[]) {
  const t0 = Date.now()
  const DATASETS = datasetsDir(ROOT)
  const historyPath = path.join(DATASETS, NET_APY_HISTORY_DIR, NET_APY_HISTORY_FILE)
  const hist = JSON.parse(fs.readFileSync(historyPath, 'utf8')) as NetApyHistoryFile
  const protocols = JSON.parse(fs.readFileSync(OCT10_PROTOCOLS, 'utf8')) as {
    measuredLiquidations: Parameters<typeof measuredRepayFraction>[1]
  }
  const repay = measuredRepayFraction('aave-v3', protocols.measuredLiquidations)
  const out: unknown[] = []
  const sources: Record<string, unknown> = {}

  for (const rd of RETURNS) {
    const cl = CLAIMS.find((x) => x.id === rd.claimId)!
    const def = PATHS[cl.pathId]
    const line = membraneMaxLtv(def.symbol)
    if (line === null) throw new Error(`${def.symbol}: no Membrane line`)
    const ltv = cl.ltv(line)
    const p = def.build()
    const cov = pathCoverage(p)
    if (!cov) throw new Error(`${cl.pathId}: empty path`)
    const debtUsd = ltv * rd.collateralUsd

    const hv = hist.venues[rd.venueKey]
    if (!hv) throw new Error(`net-apy history: no ${rd.venueKey}`)
    const borrow = borrowSeries(rd.borrowVenueKey)
    const incSupply = historySeries(hist, rd.venueKey, 'supplyApr@0')
    const ti = hv.columns.indexOf('blockTs')
    const lti = hv.columns.indexOf('wethLtBps')
    const bi = hv.columns.indexOf('wethBonusBps')
    const paramRows = hv.rows.filter((r) => r[lti] != null && r[bi] != null) as number[][]
    /** Aave v3 WETH params at the last sample at or before ts. */
    const paramsAt = (ts: number): IncumbentParams | null => {
      let lo = 0
      let hi = paramRows.length - 1
      if (hi < 0 || paramRows[0][ti] > ts) return null
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (paramRows[mid][ti] <= ts) lo = mid
        else hi = mid - 1
      }
      return {
        label: rd.incumbentLabel,
        liquidationThreshold: paramRows[lo][lti] / 1e4,
        liquidationBonus: paramRows[lo][bi] / 1e4 - 1,
        repayFraction: repay.fraction,
        repayFractionLabel: repay.label,
      }
    }

    const cases = cl.caseIds.map((caseId) => {
      const cd = CASES.find((x) => x.id === caseId)
      if (!cd) throw new Error(`returns: unknown case ${caseId}`)
      const preset = cd.preset ? EXIT_CAPACITY_PRESETS[cd.preset] : null
      // The book whose deposit sets the supply APR: the preset's book; the floor names none, so
      // the default book; levered long deploys nothing.
      const bookUsd =
        cd.tradeShape !== 'carry'
          ? null
          : (preset?.bookUsd ??
            EXIT_CAPACITY_BOOKS.find((b) => b.id === EXIT_CAPACITY_DEFAULT_BOOK)!.usd)
      const supply =
        bookUsd === null ? null : historySeries(hist, rd.venueKey, `supplyApr@${bookUsd}`)
      const c: SetAndForgetCase = {
        line,
        membraneClass: cl.membraneClass,
        tradeShape: cd.tradeShape,
        exitCapacityPreset: cd.preset,
        collateralUsd: rd.collateralUsd,
      }
      return { caseId, cd, preset, bookUsd, supply, c }
    })

    sources[rd.id] = {
      price: def.source,
      netApy: {
        file: `membrane-datasets/${NET_APY_HISTORY_DIR}/${NET_APY_HISTORY_FILE} (private, board rule N18)`,
        venueKey: rd.venueKey,
        generatedAt: hist.generatedAt,
        source: hist.source,
        strideHours: hist.strideSeconds / 3600,
        samples: hv.rows.length,
        failedSamples: hv.failures.length,
        firstReadable: { iso: iso(hv.firstReadable.t), block: hv.firstReadable.b },
        lastUnreadable: hv.lastUnreadable
          ? {
              iso: iso(hv.lastUnreadable.t),
              block: hv.lastUnreadable.b,
              why: hv.lastUnreadable.why,
            }
          : null,
        last: iso(hv.rows[hv.rows.length - 1][ti] as number),
      },
      borrow: {
        source: borrow.source,
        first: iso(borrow.series.t[0]),
        last: iso(borrow.series.t[borrow.series.t.length - 1]),
      },
      incumbent: {
        label: rd.incumbentLabel,
        params:
          'liquidation threshold and bonus of Aave v3 WETH, read at the sample at or before the window start (net-apy history wethLtBps / wethBonusBps); held for the window',
        repayFraction: repay.fraction,
        repayFractionLabel: repay.label,
        engine:
          'compare.ts runIncumbent: at each step over the threshold, the repay share is repaid and the bonus seized on top',
      },
    }

    for (const hz of rd.horizons) {
      if (horizonFilter && !horizonFilter.includes(hz)) continue
      const h = SET_AND_FORGET_HORIZONS.find((x) => x.label === hz)!
      const minr = windowMinRatios(p, h.hours, def.resolution)
      const accs = cases.map(() => newAcc())
      const unavailable = new Map<string, number>()
      let nSurvival = 0
      let first: number | null = null
      let last: number | null = null
      const named = new Map<number, (typeof NAMED_STARTS)[number]>()
      for (const ns of NAMED_STARTS) {
        const s = Math.round((Date.parse(ns.openIso) / 1000 - p.startTs) / 3600) - 1
        named.set(s, ns)
      }
      const namedOut: Record<string, unknown>[] = []
      for (let s = cov.fromIndex; s + h.hours <= cov.toIndex; s++) {
        if (!Number.isFinite(minr[s])) continue
        nSurvival++
        const { openTs, closeTs } = windowTimes(p, s, h.hours)
        const params = paramsAt(openTs)
        let why: string | null =
          uncoveredClass(borrow.series, openTs, closeTs) ??
          (incSupply ? uncoveredClass(incSupply, openTs, closeTs) : 'no net-APY history') ??
          (params ? null : 'no Aave v3 WETH parameters at the window start')
        for (const k of cases) if (!why && k.supply) why = uncoveredClass(k.supply, openTs, closeTs)
        const ns = named.get(s)
        if (why) {
          unavailable.set(why, (unavailable.get(why) ?? 0) + 1)
          if (ns)
            namedOut.push({
              id: ns.id,
              label: ns.label,
              open: iso(openTs),
              close: iso(closeTs),
              unavailable: why,
            })
          continue
        }
        first ??= s
        last = s
        const iRun = incumbentWindow(
          rd.collateralUsd,
          debtUsd,
          p,
          s,
          h.hours,
          def.resolution,
          params!,
        )!
        const iBase = {
          startTs: openTs,
          horizonSeconds: h.hours * 3600,
          startDebtUsd: debtUsd,
          run: iRun,
          supply: incSupply,
          borrow: borrow.series,
        }
        const iCarry = incumbentReturn({ ...iBase, deployedUsd: debtUsd })
        const iLong = incumbentReturn({ ...iBase, deployedUsd: 0 })
        const iLiqs = iRun.events.filter((e) => e.kind === 'liquidation').length
        const perCase: Record<string, unknown> = {}
        cases.forEach((k, ci) => {
          const mw = membraneWindow(k.c, ltv, p, s, h.hours, def.resolution, k.supply)!
          const ir = k.cd.tradeShape === 'carry' ? iCarry : iLong
          const a = accs[ci]
          const m = mw.ret
          a.m.yieldEarned.push(usd(m.yieldEarned)!)
          a.m.yieldGivenUp.push(usd(m.yieldGivenUp)!)
          a.m.collateralSold.push(usd(m.collateralSold)!)
          a.m.recallDrawn.push(m.recallDrawnUsd)
          a.i.yieldEarned.push(usd(ir.yieldEarned)!)
          a.i.borrowCost.push(usd(ir.borrowCost)!)
          a.i.netCarry.push(usd(netCarry(ir))!)
          a.i.collateralSold.push(usd(ir.collateralSold)!)
          a.i.liquidationPenalty.push(usd(ir.liquidationPenalty)!)
          if (m.collateralSold.usd! > 0) a.mSold++
          if (ir.collateralSold.usd! > 0) a.iSold++
          if (m.recallDrawnUsd > 0) a.recalled++
          const w = a.worst
          if (m.collateralSold.usd! > 0 && (!w.mostSold || m.collateralSold.usd! > w.mostSold.usd))
            w.mostSold = { start: s, usd: m.collateralSold.usd! }
          if (
            k.cd.tradeShape === 'carry' &&
            (!w.leastYield || m.yieldEarned.usd! < w.leastYield.usd)
          )
            w.leastYield = { start: s, usd: m.yieldEarned.usd! }
          if (
            ir.collateralSold.usd! > 0 &&
            (!w.incumbentMostSold || ir.collateralSold.usd! > w.incumbentMostSold.usd)
          )
            w.incumbentMostSold = { start: s, usd: ir.collateralSold.usd! }
          if (ns) {
            perCase[k.caseId] = {
              membrane: {
                ...membraneOut(m),
                outcome: mw.run.outcome,
                saleReason: mw.run.saleReason,
              },
              incumbent: { ...incumbentOut(ir), liquidations: iLiqs },
            }
          }
        })
        if (ns)
          namedOut.push({
            id: ns.id,
            label: ns.label,
            open: iso(openTs),
            close: iso(closeTs),
            cases: perCase,
          })
      }
      // Named windows with no complete window (past the data's end, or a gap) say so.
      for (const ns of NAMED_STARTS) {
        if (!namedOut.some((x) => x.id === ns.id)) {
          namedOut.push({
            id: ns.id,
            label: ns.label,
            open: ns.openIso,
            unavailable: `no complete ${hz} window in the price data`,
          })
        }
      }

      /** One window re-run for its full statement (the extremes). */
      const statementAt = (k: (typeof cases)[number], s: number) => {
        const { openTs, closeTs } = windowTimes(p, s, h.hours)
        const mw = membraneWindow(k.c, ltv, p, s, h.hours, def.resolution, k.supply)!
        const iRun = incumbentWindow(
          rd.collateralUsd,
          debtUsd,
          p,
          s,
          h.hours,
          def.resolution,
          paramsAt(openTs)!,
        )!
        const ir = incumbentReturn({
          startTs: openTs,
          horizonSeconds: h.hours * 3600,
          startDebtUsd: debtUsd,
          deployedUsd: k.cd.tradeShape === 'carry' ? debtUsd : 0,
          run: iRun,
          supply: incSupply,
          borrow: borrow.series,
        })
        return {
          open: iso(openTs),
          close: iso(closeTs),
          membrane: {
            ...membraneOut(mw.ret),
            outcome: mw.run.outcome,
            saleReason: mw.run.saleReason,
          },
          incumbent: {
            ...incumbentOut(ir),
            liquidations: iRun.events.filter((e) => e.kind === 'liquidation').length,
          },
        }
      }

      const n = first === null ? 0 : accs[0].m.yieldEarned.length
      const period =
        first === null
          ? null
          : {
              firstOpen: iso(windowTimes(p, first, h.hours).openTs),
              lastOpen: iso(windowTimes(p, last!, h.hours).openTs),
            }
      cases.forEach((k, ci) => {
        const a = accs[ci]
        out.push({
          statementId: rd.id,
          caseId: k.caseId,
          exitCapacity: k.preset
            ? { id: k.preset.id, label: k.preset.label, mult: k.preset.mult }
            : null,
          yieldPricedAtBookUsd: k.bookUsd,
          horizon: hz,
          pathId: cl.pathId,
          membraneClass: cl.membraneClass,
          line,
          ltv,
          ltvLabel: cl.ltvLabel,
          collateralUsd: rd.collateralUsd,
          debtUsd,
          period,
          n,
          nSurvival,
          unavailable: Object.fromEntries([...unavailable.entries()].sort((x, y) => y[1] - x[1])),
          membrane: {
            yieldEarned: distOf(a.m.yieldEarned),
            borrowCost: {
              usd: null,
              why:
                k.cd.tradeShape === 'carry'
                  ? 'curator-set share of the venue yield; not fixed pre-launch'
                  : 'Membrane interest on undeployed debt; not fixed pre-launch',
            },
            collateralSold: distOf(a.m.collateralSold),
            yieldGivenUp: distOf(a.m.yieldGivenUp),
            recallDrawn: distOf(a.m.recallDrawn),
            windowsWithSale: a.mSold,
            windowsWithRecall: a.recalled,
          },
          incumbent: {
            yieldEarned: distOf(a.i.yieldEarned),
            borrowCost: distOf(a.i.borrowCost),
            netCarry: distOf(a.i.netCarry),
            collateralSold: distOf(a.i.collateralSold),
            liquidationPenalty: distOf(a.i.liquidationPenalty),
            windowsWithSale: a.iSold,
          },
          windows: {
            named: namedOut.map(({ cases: perCase, ...x }) =>
              perCase ? { ...x, ...((perCase as Record<string, object>)[k.caseId] ?? {}) } : x,
            ),
            membraneMostSold: a.worst.mostSold ? statementAt(k, a.worst.mostSold.start) : null,
            membraneLeastYield: a.worst.leastYield
              ? statementAt(k, a.worst.leastYield.start)
              : null,
            incumbentMostSold: a.worst.incumbentMostSold
              ? statementAt(k, a.worst.incumbentMostSold.start)
              : null,
          },
        })
        const d = (x: ReturnType<typeof distOf>) =>
          x ? `$${x.median.toFixed(0)} (p10 $${x.p10.toFixed(0)}, p90 $${x.p90.toFixed(0)})` : '—'
        console.log(
          `returns ${rd.id} ${k.caseId} ${hz}: n=${n} of ${nSurvival} | Membrane yield ${d(distOf(a.m.yieldEarned))}, given up ${d(distOf(a.m.yieldGivenUp))}, sold in ${a.mSold} | ` +
            `Aave yield ${d(distOf(a.i.yieldEarned))}, borrow ${d(distOf(a.i.borrowCost))}, sold in ${a.iSold}`,
        )
      })
    }
  }

  const file = {
    schema: 'set-and-forget-returns/v1',
    generatedAt: new Date().toISOString(),
    codeVersion: STRESS_CODE_VERSION,
    label: 'Historical replay over a named period. Not a forecast, not a probability.',
    method: {
      window:
        'A position opened at the close of an hour and left alone for the horizon. Every start hour whose window all the rate series cover (stride 1h).',
      membrane:
        'One traced stressGrid runStress replay per window, the same replay and case as the survival table (set-and-forget-ltv.json); the trace times each recall draw.',
      incumbent:
        'compare.ts runIncumbent on the same replay: the same collateral and start debt on Aave v3.',
      yieldEarned:
        'Venue supply APR (net-APY history, sample-and-hold) × the debt still deployed, simple interest. Membrane: priced at its whole book at the venue (the preset’s book; the floor names none, so the default $50M book); the gross venue yield before Membrane’s curator-set share, so an upper bound on what reaches the user. Aave: priced at the position’s own deposit.',
      borrowCost:
        'Aave: the measured hourly variable borrow APR × the debt still owed. Membrane: unavailable (curator-set share of yield; deployed debt carries no interest).',
      collateralSold:
        'Membrane: the engine’s exposedUsd (fees omitted; a sale in the held tail after the horizon counts, as in the survival table). Aave: seized collateral incl. the liquidation bonus.',
      yieldGivenUp:
        'Membrane: what the capital the recalls drew would have earned for the rest of the window. Aave: 0 by construction (no recall).',
      summary:
        'Quantiles (lower nearest rank) over the n windows of the named period. History, not odds.',
    },
    notModelled: [
      'Membrane’s curator-set share of the yield (never priced pre-launch)',
      'Membrane’s liquidation fee and the fee on a recall cure (LiquidationEngine STEP 2.5): the Membrane sold figure is understated',
      'interest accrual on the debt and compounding of the yield',
      'gas, slippage, MEV; incentives (Merkl)',
      'Aave parameter changes inside a window (held at the start)',
      'an Aave liquidation needs a liquidator in that half hour: modelled as always present',
    ],
    sources,
    statements: out,
    seconds: (Date.now() - t0) / 1000,
  }
  const body = JSON.stringify(file, null, 1) + '\n'
  const canonical = path.join(DATASETS, RETURNS_DATASET_DIR, 'set-and-forget-returns.json')
  fs.mkdirSync(path.dirname(canonical), { recursive: true })
  fs.writeFileSync(canonical, body)
  fs.writeFileSync(RETURNS_OUT, body)
  console.log(
    `wrote ${canonical} and the served copy ${path.relative(ROOT, RETURNS_OUT)} in ${file.seconds.toFixed(0)}s`,
  )
}

if (args.has('returns')) {
  runReturns(args.get('horizons')?.split(','))
} else if (args.has('report')) {
  report()
} else if (args.has('seed')) {
  seed(args.get('seed')!.split(','))
} else if (args.has('claims')) {
  runClaims(
    args.get('horizons')?.split(','),
    args.get('cases') ? new Set(args.get('cases')!.split(',')) : undefined,
  )
} else {
  const stride = Math.max(1, Number(args.get('stride') ?? 1))
  const wanted = args.get('horizons')?.split(',')
  const horizons = SET_AND_FORGET_HORIZONS.filter((h) => !wanted || wanted.includes(h.label))
  const caseFilter = args.get('cases') ? new Set(args.get('cases')!.split(',')) : undefined
  const classes = args.get('classes')
    ? CLASSES.filter((c) => args.get('classes')!.split(',').includes(c))
    : CLASSES
  const ids = (args.get('path') ?? Object.keys(PATHS).join(',')).split(',')
  // --collateral=<usd>: a position-size probe (the debt floor stays $2,000), never merged.
  const collateralUsd = Number(args.get('collateral') ?? SET_AND_FORGET_COLLATERAL_USD)
  const caseShard = args.get('shard')
  if (caseShard && !caseFilter) throw new Error('--shard needs --cases')
  for (const id of ids) runPath(id, horizons, stride, caseFilter, classes, collateralUsd, caseShard)
}
