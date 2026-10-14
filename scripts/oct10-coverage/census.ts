/**
 * The Oct 10-11 2025 FULL-COVERAGE census, as a pure function of the on-chain pull: every
 * liquidated Aave V3 account and Morpho Blue position, the protocol's real liquidations on
 * the one side, Membrane's engine walked minute by minute on the other, on the same positions.
 *
 * build-census.ts loads the files and writes the outputs; this module only computes, so the
 * unit tests can run it on a committed fixture subset (tests/unit/fixtures/wavefront-census-
 * fixture.json) and scripts/tests/wavefront-census.test.ts on the whole pull.
 *
 * Method (docs/WAVEFRONT.md has the long form):
 *   - position spec: lib/wavefront/aave.ts, lib/wavefront/morpho.ts (composition at the t0
 *     event's N-1, valued at block-N oracle prices; line, LTV0, delay class, mixed split);
 *   - Membrane: lib/wavefront/kernel.ts per half, stepped over every minute after t0 to the
 *     grid end, each leg moved by its own protocol-oracle minute path relative to its block-N
 *     price (the path is the price in force at each minute START — no look-ahead);
 *   - real: every CSV event in USD at block-N protocol-oracle prices;
 *   - one stream (lib/wavefront/stream.ts) for the whole window, ticks folded by its reducer.
 */

import { heldAtOne } from '../../lib/position-sim/collateralClass'
import {
  BORROW_LTV_GAP,
  CURE_WINDOW_SECONDS,
  LIQ_DEBT_MINIMUM_USD,
  MAX_THRESHOLD_TO_DELAY,
} from '../../lib/position-sim/membrane'
import {
  aavePositionSpec,
  aaveRealUsd,
  kernelLegs,
  minuteOf,
  pathAnchors,
  streamLegs,
  type AaveCsvRow,
  type AaveEventRecord,
  type PositionSpec,
  type PriceSource,
} from '../../lib/wavefront/aave'
import { clusterAssigner, primarySymbol } from '../../lib/wavefront/cluster'
import { MembraneKernel, type KernelLeg, type KernelResult } from '../../lib/wavefront/kernel'
import {
  morphoPositionSpec,
  morphoRealUsd,
  type MorphoCsvRow,
  type MorphoEventRecord,
} from '../../lib/wavefront/morpho'
import {
  KIND_RANK,
  TICK_EVERY_MINUTES,
  applyRecord,
  createReplayState,
  isTickMinute,
  roundRecord,
  tickFromState,
  type MemRecord,
  type OpenRecord,
  type RealRecord,
  type StreamRecord,
  type StreamWindow,
  type Totals,
} from '../../lib/wavefront/stream'
import type { CureOutcome } from '../../lib/position-sim/curePath'

export const MAX_SALES = 20
export const DELAY_STEPS = Math.ceil(CURE_WINDOW_SECONDS / 60)

/** AaveOracle minute path of one chain (aave-oracle-1m.<chain>.json.gz, the fields read). */
export interface AaveOracleFile {
  chain: string
  baseUnit: string
  assets: { address: string; symbol: string; decimals: number }[]
  prices: Record<string, (string | null)[]>
}
/** Morpho oracle minute path of one chain (morpho-oracle-1m.<chain>.json.gz, the fields read). */
export interface MorphoOracleFile {
  chain: string
  prices: Record<string, (string | null)[]>
}

export interface CensusInputs {
  window: StreamWindow
  aaveCsv: AaveCsvRow[]
  aaveEvents: AaveEventRecord[]
  aaveOracle: Record<string, AaveOracleFile>
  morphoCsv: (MorphoCsvRow & Record<string, unknown>)[]
  morphoEvents: MorphoEventRecord[]
  morphoOracle: Record<string, MorphoOracleFile>
}

export interface CensusOptions {
  /** SENSITIVITY ONLY: stop after a delayed sale at t0 past the band (the old cureWalk). */
  stopAfterT0BandSale?: boolean
  /** Build only these positions (the cross-check's overlap set). */
  onlyPids?: ReadonlySet<string>
  /**
   * CROSS-CHECK TOGGLES ONLY. Rewrite a walked position's spec before its kernels are built
   * (e.g. the old census's single liquidated leg, or its inverted-HF line).
   */
  specOverride?: (
    spec: PositionSpec,
    events: readonly (AaveEventRecord | MorphoEventRecord)[],
  ) => PositionSpec
  /**
   * CROSS-CHECK TOGGLES ONLY. A leg's ratio at a minute from another price source; undefined
   * falls through to the protocol path.
   */
  ratioOverride?: (spec: PositionSpec, leg: KernelLeg, minute: number) => number | null | undefined
}

export interface SubRow {
  sub: number
  delayClass: 'no-delay' | 'delayed'
  line: number
  share: number
  symbols: string[]
  outcome: CureOutcome
  sales: number
  closedT0: number
  repaidUsd: number | null
  startUnbreached: boolean
  armedAtGridEnd: boolean
}

export interface CensusRow {
  pid: string
  protocol: 'aave-v3' | 'morpho-blue'
  chain: string
  owner: string
  market?: string
  events: number
  first: { block: number; ts: number }
  walked: boolean
  reason?: string
  t0?: { block: number; ts: number; minute: number; shifted: boolean }
  unit: string
  collateral: { symbol: string; amount: number; usd: number | null; lt?: number }[]
  debt: { symbol: string; amount: number; usd: number | null }[]
  collUsd: number | null
  debtUsd: number | null
  line: number | null
  ltv0: number | null
  delayClass: 'no-delay' | 'delayed' | 'mixed'
  cluster: string
  primarySymbol: string
  notes?: string[]
  real: {
    events: number
    repaidUsd: number
    seizedUsd: number
    badDebtUsd: number
    unpricedEvents: number
  }
  mem: null | {
    outcome: CureOutcome
    sales: number
    firstSaleMinute: number | null
    repaidUsd: number
    soldUsd: number
    unpricedSales: number
    /** Debt closed on the t0 basis, in the position's unit (== cureWalk.closedUsd). */
    closedT0: number
    breaches: number
    arms: number
    saves: number
    armedAtGridEnd: boolean
    startUnbreached: boolean
    subs?: SubRow[]
  }
}

export interface CensusResult {
  rows: CensusRow[]
  records: StreamRecord[]
  finalTotals: Totals
  coverage: { walked: number; total: number }
  stats: {
    aaveRealPriceSources: Record<string, number>
    morphoLoanPricing: Record<string, { how: string; events: number; positions: number }>
    ownClusters: string[]
    clusterCounts: Record<string, number>
    classCounts: Record<string, number>
    splitHalves: { mixed: number; startUnbreachedHalves: number; tinyHalves: number }
    t0Shifted: string[]
    zeroValueCollateralPositions: number
    locatedFloatMismatch: string[]
  }
}

// ------------------------------------------------------------------ paths

/** Column cache: string prices → Float64Array (NaN = null), parsed once. */
class Columns {
  private cache = new Map<string, Float64Array>()
  constructor(private readonly src: Record<string, Record<string, (string | null)[]>>) {}
  get(chain: string, key: string): Float64Array | null {
    const k = `${chain}|${key}`
    let c = this.cache.get(k)
    if (c) return c
    const raw = this.src[chain]?.[key]
    if (!raw) return null
    c = new Float64Array(raw.length)
    for (let i = 0; i < raw.length; i++) {
      const v = raw[i]
      c[i] = v == null ? NaN : Number(v)
    }
    this.cache.set(k, c)
    return c
  }
}

const groupBy = <T>(xs: readonly T[], key: (x: T) => string) => {
  const m = new Map<string, T[]>()
  for (const x of xs) {
    const k = key(x)
    const a = m.get(k)
    if (a) a.push(x)
    else m.set(k, [x])
  }
  return m
}

const evKey = (chain: string, tx: string, log: number) => `${chain}:${tx.toLowerCase()}:${log}`

// ------------------------------------------------------------------ census

export function buildCensus(inp: CensusInputs, opts: CensusOptions = {}): CensusResult {
  const W = inp.window
  const lastMinute = W.minutes - 1
  const aaveCols = new Columns(
    Object.fromEntries(Object.entries(inp.aaveOracle).map(([c, f]) => [c, f.prices])),
  )
  const morphoCols = new Columns(
    Object.fromEntries(Object.entries(inp.morphoOracle).map(([c, f]) => [c, f.prices])),
  )
  const aaveUnit = (chain: string) => Number(inp.aaveOracle[chain]?.baseUnit ?? '100000000')
  const aaveUsdAt = (chain: string, asset: string, minute: number): number | null => {
    const col = aaveCols.get(chain, asset)
    if (!col) return null
    const v = col[Math.max(0, Math.min(col.length - 1, minute))]
    return Number.isFinite(v) && v > 0 ? v / aaveUnit(chain) : null
  }

  // ---- Morpho loan-token USD: stable at $1, else the AaveOracle path, else unpriced.
  const loanHow = (chain: string, token: string, symbol: string): string =>
    heldAtOne(symbol)
      ? 'stable-flat-1'
      : aaveCols.get(chain, token)
        ? 'aave-oracle-path'
        : 'unpriced'
  const loanUsdFn =
    (chain: string, token: string, symbol: string) =>
    (minute: number): number | null => {
      const how = loanHow(chain, token, symbol)
      if (how === 'stable-flat-1') return 1
      if (how === 'aave-oracle-path') return aaveUsdAt(chain, token, minute)
      return null
    }

  // ---- specs ------------------------------------------------------------------------------
  interface Pos {
    spec: PositionSpec
    eventsSorted: (AaveEventRecord | MorphoEventRecord)[]
    csv: (AaveCsvRow | MorphoCsvRow)[]
    usdPerUnit: (minute: number) => number | null
    loanToken?: string
  }
  const positions: Pos[] = []
  const stats: CensusResult['stats'] = {
    aaveRealPriceSources: {},
    morphoLoanPricing: {},
    ownClusters: [],
    clusterCounts: {},
    classCounts: {},
    splitHalves: { mixed: 0, startUnbreachedHalves: 0, tinyHalves: 0 },
    t0Shifted: [],
    zeroValueCollateralPositions: 0,
    locatedFloatMismatch: [],
  }

  const aaveCsvByUser = groupBy(inp.aaveCsv, (r) => `${r.chain}:${r.user.toLowerCase()}`)
  const aaveEvByUser = groupBy(inp.aaveEvents, (e) => `${e.chain}:${e.user.toLowerCase()}`)
  const keep = (pid: string) => !opts.onlyPids || opts.onlyPids.has(pid)
  for (const [k, evs] of aaveEvByUser) {
    if (!keep(`aave-v3:${k}`)) continue
    const spec = aavePositionSpec(evs, {
      startTs: W.startTs,
      stepSeconds: W.stepSeconds,
      debtMinimumUsd: LIQ_DEBT_MINIMUM_USD,
    })
    positions.push({
      spec,
      eventsSorted: [...evs].sort(
        (a, b) => a.block_number - b.block_number || a.log_index - b.log_index,
      ),
      csv: aaveCsvByUser.get(k) ?? [],
      usdPerUnit: () => 1,
    })
  }
  const morphoCsvByPos = groupBy(
    inp.morphoCsv,
    (r) => `${r.chain}:${r.market_id.toLowerCase()}:${r.borrower.toLowerCase()}`,
  )
  const morphoEvByPos = groupBy(
    inp.morphoEvents,
    (e) => `${e.chain}:${e.market_id.toLowerCase()}:${e.borrower.toLowerCase()}`,
  )
  for (const [k, evs] of morphoEvByPos) {
    if (!keep(`morpho-blue:${k}`)) continue
    const csv = morphoCsvByPos.get(k) ?? []
    if (!csv.length) throw new Error(`census: Morpho position ${k} has no CSV row`)
    const sym = { collateral: csv[0].collateral_symbol, loan: csv[0].loan_symbol }
    const loanToken = evs[0].loanToken.toLowerCase()
    const usd = loanUsdFn(evs[0].chain, loanToken, sym.loan)
    const spec = morphoPositionSpec(evs, {
      startTs: W.startTs,
      stepSeconds: W.stepSeconds,
      debtMinimumUsd: LIQ_DEBT_MINIMUM_USD,
      collateralSymbol: sym.collateral,
      loanSymbol: sym.loan,
      loanUsd: usd,
    })
    const how = loanHow(evs[0].chain, loanToken, sym.loan)
    const lk = `${evs[0].chain}:${sym.loan}`
    const s = (stats.morphoLoanPricing[lk] ??= { how, events: 0, positions: 0 })
    s.positions++
    s.events += csv.length
    positions.push({
      spec,
      eventsSorted: [...evs].sort(
        (a, b) => a.block_number - b.block_number || a.log_index - b.log_index,
      ),
      csv,
      usdPerUnit: usd,
      loanToken,
    })
  }

  // ---- clusters ---------------------------------------------------------------------------
  const prim = positions.map((p) => primarySymbol(p.spec.collateral))
  const { clusterOf, ownClusters } = clusterAssigner(prim)
  stats.ownClusters = ownClusters

  // ---- per position: open, real, mem --------------------------------------------------------
  interface Emitted {
    rec: StreamRecord
    pos: number
    local: number
  }
  const emitted: Emitted[] = []
  const rows: CensusRow[] = []
  const evIndexAave = new Map(
    inp.aaveEvents.map((e) => [evKey(e.chain, e.tx_hash, e.log_index), e]),
  )
  const evIndexMorpho = new Map(
    inp.morphoEvents.map((e) => [evKey(e.chain, e.tx_hash, e.log_index), e]),
  )

  positions.forEach((P, pi) => {
    const s =
      opts.specOverride && P.spec.located && P.spec.t0
        ? opts.specOverride(P.spec, P.eventsSorted)
        : P.spec
    let local = 0
    const emit = (rec: StreamRecord) =>
      emitted.push({ rec: roundRecord(rec), pos: pi, local: local++ })
    const cluster = clusterOf(prim[pi])
    stats.clusterCounts[cluster] = (stats.clusterCounts[cluster] ?? 0) + 1
    stats.classCounts[s.delayClass] = (stats.classCounts[s.delayClass] ?? 0) + 1
    if (s.notes.some((n) => n.startsWith('collateral worth 0')))
      stats.zeroValueCollateralPositions++
    if (s.t0?.shifted) stats.t0Shifted.push(s.pid)
    const walked = s.located && !!s.t0 && s.halves.length > 0

    const open: OpenRecord = {
      kind: 'open',
      seq: 0,
      pid: s.pid,
      protocol: s.protocol,
      chain: s.chain,
      block: s.first.block,
      ts: s.first.ts,
      legs: streamLegs(s.collateral),
      debtLegs: streamLegs(s.debt),
      debtUsd: s.debtUsd,
      collUsd: s.collUsd,
      line: s.line,
      ltv0: s.ltv0,
      delayClass: s.delayClass,
      cluster,
      walked,
    }
    if (!walked) open.reason = s.reason ?? 'not walked'
    if (walked && s.t0) open.t0 = { block: s.t0.block, ts: s.t0.ts, minute: s.t0.minute }
    if (walked && s.halves.length > 1) {
      open.subs = s.halves.map((h) => ({
        sub: h.sub as number,
        delayClass: h.delayClass,
        line: h.line,
        share: h.share,
        collUsd: s.collUsd == null ? null : s.collUsd * h.share,
        debtUsd: s.debtUsd == null ? null : s.debtUsd * h.share,
      }))
    }
    emit(open)

    // ---- real
    const realRecs: RealRecord[] = []
    const csvSorted = [...P.csv].sort(
      (a, b) =>
        Number(a.block_number) - Number(b.block_number) ||
        Number(a.log_index) - Number(b.log_index),
    )
    for (const row of csvSorted) {
      const block = Number(row.block_number)
      const ts = Number(row.ts)
      const log = Number(row.log_index)
      const key = evKey(s.chain, String(row.tx_hash), log)
      const minute = minuteOf(ts, W.startTs, W.stepSeconds)
      let rec: RealRecord
      if (s.protocol === 'aave-v3') {
        const ev = evIndexAave.get(key)
        const r = aaveRealUsd(row as AaveCsvRow, ev, (asset) => aaveUsdAt(s.chain, asset, minute))
        for (const src of [r.debtPriceSource, r.collPriceSource] as PriceSource[]) {
          stats.aaveRealPriceSources[src] = (stats.aaveRealPriceSources[src] ?? 0) + 1
        }
        rec = {
          kind: 'real',
          seq: 0,
          pid: s.pid,
          ts,
          block,
          tx: String(row.tx_hash).toLowerCase(),
          logIndex: log,
          repaidUsd: r.repaidUsd,
          seizedUsd: r.seizedUsd,
        }
      } else {
        const ev = evIndexMorpho.get(key)
        const r = morphoRealUsd(row as MorphoCsvRow, ev, P.usdPerUnit(minute))
        rec = {
          kind: 'real',
          seq: 0,
          pid: s.pid,
          ts,
          block,
          tx: String(row.tx_hash).toLowerCase(),
          logIndex: log,
          repaidUsd: r.repaidUsd,
          seizedUsd: r.seizedUsd,
          badDebtUsd: r.badDebtUsd,
        }
      }
      realRecs.push(rec)
    }

    // ---- mem
    let memRow: CensusRow['mem'] = null
    const memRecs: MemRecord[] = []
    if (walked && s.t0) {
      if (s.ltv0 != null && s.line != null && !(s.ltv0 > s.line))
        stats.locatedFloatMismatch.push(s.pid)
      const anchors = pathAnchors(s)
      const cols = new Map<string, Float64Array | null>()
      for (const k of anchors.keys()) {
        cols.set(
          k,
          s.protocol === 'aave-v3' ? aaveCols.get(s.chain, k) : morphoCols.get(s.chain, k),
        )
      }
      const kernels = s.halves.map((h) => {
        const legs = kernelLegs(s, h)
        return new MembraneKernel({
          pid: s.pid,
          ...(h.sub !== undefined ? { sub: h.sub } : {}),
          collateral: legs.collateral,
          debt: legs.debt,
          line: h.line,
          noDelay: h.delayClass === 'no-delay',
          band: MAX_THRESHOLD_TO_DELAY,
          delaySteps: DELAY_STEPS,
          gap: BORROW_LTV_GAP,
          debtMinimum: s.debtMinimum,
          maxSales: MAX_SALES,
          t0Minute: s.t0!.minute,
          t0Ts: s.t0!.ts,
          startTs: W.startTs,
          stepSeconds: W.stepSeconds,
          lastMinute,
          usdPerUnit: P.usdPerUnit,
          stopAfterT0BandSale: opts.stopAfterT0BandSale,
        })
      })
      for (const k of kernels) memRecs.push(...k.start())
      let m = 0
      const override = opts.ratioOverride
      const ratioOf = (leg: KernelLeg): number | null => {
        if (override) {
          const o = override(s, leg, m)
          if (o !== undefined) return o
        }
        if (!leg.key) return 1
        const col = cols.get(leg.key)
        if (!col) return null
        const v = col[m]
        const p0 = anchors.get(leg.key) as number
        return Number.isFinite(v) && v > 0 && p0 > 0 ? v / p0 : null
      }
      for (m = s.t0.minute + 1; m <= lastMinute; m++) {
        let live = false
        for (const k of kernels) {
          if (k.isDone) continue
          live = true
          memRecs.push(...k.step(m, ratioOf))
        }
        if (!live) break
      }
      for (const k of kernels) memRecs.push(...k.finish())
      const results: KernelResult[] = kernels.map((k) => k.result())

      // Per-half rows and the whole position's figures.
      const rounded = memRecs.map((r) => roundRecord(r))
      const sumOf = (sub: number | undefined, f: (r: MemRecord) => number | null) =>
        rounded
          .filter((r) => (r.event === 'sell' || r.event === 'sell-instant') && r.sub === sub)
          .reduce((a, r) => a + (f(r) ?? 0), 0)
      const subs: SubRow[] | undefined =
        s.halves.length > 1
          ? s.halves.map((h, k) => ({
              sub: h.sub as number,
              delayClass: h.delayClass,
              line: h.line,
              share: h.share,
              symbols: h.collateral.map((l) => l.symbol),
              outcome: results[k].outcome,
              sales: results[k].sales,
              closedT0: results[k].closedT0,
              repaidUsd: results[k].repaidUsd == null ? null : sumOf(h.sub, (r) => r.repaidUsd),
              startUnbreached: results[k].startUnbreached,
              armedAtGridEnd: results[k].armedAtGridEnd,
            }))
          : undefined
      if (subs) {
        stats.splitHalves.mixed++
        stats.splitHalves.startUnbreachedHalves += subs.filter((x) => x.startUnbreached).length
        stats.splitHalves.tinyHalves += subs.filter((x) => x.share < 0.01).length
      }
      const sells = rounded.filter((r) => r.event === 'sell' || r.event === 'sell-instant')
      // The position's outcome: an unsplit position's own; a split one's DOMINANT half (the
      // larger share of the debt; ties: sub 0). Each half's outcome is in subs[].
      let dom = 0
      s.halves.forEach((h, k) => {
        if (h.share > s.halves[dom].share) dom = k
      })
      const outcome: CureOutcome = results[dom].outcome
      memRow = {
        outcome,
        sales: results.reduce((a, r) => a + r.sales, 0),
        firstSaleMinute: sells.length ? Math.min(...sells.map((r) => r.minute)) : null,
        repaidUsd: sells.reduce((a, r) => a + (r.repaidUsd ?? 0), 0),
        soldUsd: sells.reduce((a, r) => a + (r.soldUsd ?? 0), 0),
        unpricedSales: sells.filter((r) => r.repaidUsd == null || r.soldUsd == null).length,
        closedT0: results.reduce((a, r) => a + r.closedT0, 0),
        breaches: results.reduce((a, r) => a + r.breaches, 0),
        arms: rounded.filter((r) => r.event === 'arm').length,
        saves: rounded.filter((r) => r.event === 'save').length,
        armedAtGridEnd: results.some((r) => r.armedAtGridEnd),
        startUnbreached: results.every((r) => r.startUnbreached),
        ...(subs ? { subs } : {}),
      }
    }
    for (const r of realRecs) emit(r)
    for (const r of memRecs) emit(r)

    const realRounded = realRecs.map((r) => roundRecord(r))
    rows.push({
      pid: s.pid,
      protocol: s.protocol,
      chain: s.chain,
      owner: s.owner,
      ...(s.market ? { market: s.market } : {}),
      events: P.csv.length,
      first: s.first,
      walked,
      ...(walked ? {} : { reason: open.reason }),
      ...(walked && s.t0
        ? { t0: { block: s.t0.block, ts: s.t0.ts, minute: s.t0.minute, shifted: s.t0.shifted } }
        : {}),
      unit: s.unit,
      collateral: s.collateral.map((l) => ({
        symbol: l.symbol,
        amount: l.amount,
        usd: l.usd,
        ...(l.lt !== undefined ? { lt: l.lt } : {}),
      })),
      debt: s.debt.map((l) => ({ symbol: l.symbol, amount: l.amount, usd: l.usd })),
      collUsd: s.collUsd,
      debtUsd: s.debtUsd,
      line: s.line,
      ltv0: s.ltv0,
      delayClass: s.delayClass,
      cluster,
      primarySymbol: prim[pi],
      ...(s.notes.length ? { notes: s.notes } : {}),
      real: {
        events: realRounded.length,
        repaidUsd: realRounded.reduce((a, r) => a + (r.repaidUsd ?? 0), 0),
        seizedUsd: realRounded.reduce((a, r) => a + (r.seizedUsd ?? 0), 0),
        badDebtUsd: realRounded.reduce((a, r) => a + (r.badDebtUsd ?? 0), 0),
        unpricedEvents: realRounded.filter((r) => r.repaidUsd == null || r.seizedUsd == null)
          .length,
      },
      mem: memRow,
    })
  })

  // ---- one stream, in time order, ticks folded by the reducer ----------------------------
  emitted.sort(
    (a, b) =>
      a.rec.ts - b.rec.ts ||
      KIND_RANK[a.rec.kind] - KIND_RANK[b.rec.kind] ||
      a.pos - b.pos ||
      a.local - b.local,
  )
  const state = createReplayState()
  const records: StreamRecord[] = []
  let seq = 0
  let nextTick = 0
  while (nextTick <= lastMinute && !isTickMinute(nextTick)) nextTick++
  const tickTsOf = (m: number) => W.startTs + W.stepSeconds * (m + 1)
  const flushTicksBefore = (ts: number) => {
    while (nextTick <= lastMinute && tickTsOf(nextTick) <= ts) {
      const t = tickFromState(state, W, nextTick)
      t.seq = ++seq
      applyRecord(state, t)
      records.push(t)
      nextTick += TICK_EVERY_MINUTES
    }
  }
  for (const e of emitted) {
    flushTicksBefore(e.rec.ts)
    e.rec.seq = ++seq
    applyRecord(state, e.rec)
    records.push(e.rec)
  }
  flushTicksBefore(Infinity)

  return {
    rows,
    records,
    finalTotals: state.totals,
    coverage: { ...state.coverage },
    stats,
  }
}
