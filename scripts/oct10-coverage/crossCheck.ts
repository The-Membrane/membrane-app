/**
 * CROSS-CHECK: the full-coverage census against the old census (public/data/oct10-2025/
 * evidence.json, scripts/build-evidence.ts), on the rows both include — the old census's
 * PRICED, NOT-EXCLUDED rows.
 *
 * The two differ in four ways, and each is toggled back to the old census's choice ONE AT A
 * TIME on the new census (everything else held at the new choice):
 *
 *   (i)   PRICE SOURCE, mainnet: the new census reads AaveOracle (on mainnet, Chainlink SVR
 *         `DualAggregator` feeds); the old one read the public ETH/USD and BTC/USD rounds of
 *         chainlink_rounds.csv and its minute grid prices-1m.json. Toggle: every leg the old
 *         grid can price (ETH and its proxies, BTC and its proxies, wstETH, stables at a flat
 *         $1) takes the old census's t0 basis — its block N-1 value rebased by the round in
 *         force at N over the round in force at N-1 — and walks the old grid relative to the
 *         round in force at N. Legs the old grid cannot price keep the protocol oracle.
 *   (ii)  COMPOSITION: the full basket vs the old single liquidated leg. Toggle: one collateral
 *         leg (the first event's liquidated reserve) carrying the whole collateral value and one
 *         debt leg (the first event's debt reserve) carrying the whole debt, no split, walked in
 *         the OLD row's class (no-delay only where the old census said so).
 *   (iii) PER-CHAIN ORACLES on L2s vs the mainnet-round proxy: toggle (i) on Arbitrum,
 *         Optimism and Base rows — there the old census priced through MAINNET rounds on a
 *         timestamp rule.
 *   (iv)  LINE from exact N prices vs the inverted HF at N-1 (hf × debt / coll of the first
 *         event's snapshot). Toggle: the old line; a split's halves scaled by old/new.
 *
 * Each factor's effect is reported as (new − toggled): the dollars that choice moved, going
 * from the old choice to the new one. The four do not have to add up to the whole difference
 * — what they leave is reported as the interaction/residual, and an all-toggles rebuild shows
 * how much of the old census the new code reproduces when every choice is set back.
 *
 * Membrane figures are compared on the t0 basis (closedT0: debt closed in t0 USD), which is
 * what the old census's membraneClosedUsd is. The real side is decomposed exactly (no
 * interaction): price source of the debt token, events the old census dropped (debt symbol
 * with no series), and its cap at the account's debt.
 */
import fs from 'node:fs'

import { heldAtOne } from '../../lib/position-sim/collateralClass'
import {
  AAVE_PRICE_UNIT,
  aavePoolOf,
  type AaveEventRecord,
  type HalfSpec,
  type PositionSpec,
  type SpecLeg,
} from '../../lib/wavefront/aave'
import type { KernelLeg } from '../../lib/wavefront/kernel'
import { AAVE_CORE_POOL, aavePid } from '../../lib/wavefront/pid'
import { buildCensus, type CensusInputs, type CensusRow } from './census'
import { parseCsv } from './inputs'

type Feed = 'ETH/USD' | 'BTC/USD'
const ETH_LIKE = new Set(['WETH', 'ETH', 'weETH', 'rETH', 'cbETH', 'ETHx', 'osETH', 'wstETH'])
const BTC_LIKE = new Set(['WBTC', 'BTC', 'cbBTC', 'tBTC', 'LBTC'])
/** The old census's feed for a symbol: build-evidence.ts feedFor (wstETH = ETH × constant). */
const oldFeed = (s: string): Feed | 'STABLE' | null =>
  heldAtOne(s) ? 'STABLE' : ETH_LIKE.has(s) ? 'ETH/USD' : BTC_LIKE.has(s) ? 'BTC/USD' : null

const r2 = (x: number) => Math.round(x * 100) / 100
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

export interface CrossCheckArgs {
  rows: CensusRow[]
  inputs: CensusInputs
  evidencePath: string
  pricesPath: string
  roundsPath: string
  chainlinkCheckPath: string
}

export function crossCheck(a: CrossCheckArgs) {
  const evidence = JSON.parse(fs.readFileSync(a.evidencePath, 'utf8'))
  const px = JSON.parse(fs.readFileSync(a.pricesPath, 'utf8'))
  const grid: Record<Feed, number[]> = {
    'ETH/USD': px.columns.ethOracle,
    'BTC/USD': px.columns.btcOracle,
  }
  const wrap: number = px.meta.wstethWrapRate
  const seed: Record<Feed, number> = {
    'ETH/USD': grid['ETH/USD'][0],
    'BTC/USD': grid['BTC/USD'][0],
  }
  const rounds: Record<Feed, { ts: number; block: number; log: number; p: number }[]> = {
    'ETH/USD': [],
    'BTC/USD': [],
  }
  for (const r of parseCsv(fs.readFileSync(a.roundsPath, 'utf8'))) {
    if (r.feed !== 'ETH/USD' && r.feed !== 'BTC/USD') continue
    rounds[r.feed as Feed].push({
      ts: +r.updated_at_ts,
      block: +r.block_number,
      log: +r.log_index,
      p: +r.answer_float,
    })
  }
  for (const f of Object.values(rounds))
    f.sort((x, y) => x.ts - y.ts || x.block - y.block || x.log - y.log)
  /** build-evidence.ts inForcePair: the round the snapshot (N-1) and the liquidation (N) saw. */
  const inForce = (feed: Feed, chain: string, block: number, ts: number, log: number) => {
    let state = seed[feed]
    let liq = seed[feed]
    for (const r of rounds[feed]) {
      const seenByState = chain === 'mainnet' ? r.block <= block - 1 : r.ts < ts
      const seenByLiq =
        chain === 'mainnet' ? r.block < block || (r.block === block && r.log < log) : r.ts <= ts
      if (seenByState) state = r.p
      if (seenByLiq) liq = r.p
      else if (!seenByState) break
    }
    return { state, liq }
  }

  // ---- the overlap -------------------------------------------------------------------------
  const oldRows: any[] = evidence.cohort.filter((r: any) => r.priced && !r.excluded)
  const byPid = new Map(a.rows.map((r) => [r.pid, r]))
  const oldByPid = new Map(
    oldRows.map((r) => [aavePid(r.chain, AAVE_CORE_POOL[r.chain], r.user), r]),
  )
  const both = oldRows.filter(
    (r) => byPid.get(aavePid(r.chain, AAVE_CORE_POOL[r.chain], r.user))?.walked,
  )
  const missing = oldRows
    .filter((r) => !byPid.get(aavePid(r.chain, AAVE_CORE_POOL[r.chain], r.user))?.walked)
    .map((r) => aavePid(r.chain, AAVE_CORE_POOL[r.chain], r.user))
  const pids = new Set(both.map((r) => aavePid(r.chain, AAVE_CORE_POOL[r.chain], r.user)))

  // Per-pid context the toggles need: the t0 event and the first event.
  const evsByPid = new Map<string, AaveEventRecord[]>()
  for (const e of a.inputs.aaveEvents) {
    const pid = aavePid(e.chain, aavePoolOf(e), e.user)
    if (!pids.has(pid)) continue
    evsByPid.set(pid, [...(evsByPid.get(pid) ?? []), e])
  }
  for (const v of evsByPid.values())
    v.sort((x, y) => x.block_number - y.block_number || x.log_index - y.log_index)
  const t0Event = (s: PositionSpec) => evsByPid.get(s.pid)![s.t0!.eventIndex]
  const firstEvent = (s: PositionSpec) => evsByPid.get(s.pid)![0]

  /** A leg's value at N-1 (AaveOracle N-1 price, Aave rounding as the snapshot totals use). */
  const valueNm1 = (ev: AaveEventRecord, leg: SpecLeg, isDebt: boolean) => {
    const p = ev.position.find((x) => x.asset === leg.key)
    if (!p || p.priceNm1 == null) return leg.value0
    const amt = isDebt ? BigInt(p.variableDebt) + BigInt(p.stableDebt) : BigInt(p.aTokenBalance)
    const num = amt * BigInt(p.priceNm1)
    const den = 10n ** BigInt(p.decimals)
    return Number(isDebt ? (num + den - 1n) / den : num / den) / AAVE_PRICE_UNIT
  }
  const rebaseOf = (symbol: string, s: PositionSpec, ev: AaveEventRecord) => {
    const f = oldFeed(symbol)
    if (f === null || f === 'STABLE') return 1
    const x = inForce(f, s.chain, ev.block_number, ev.ts, ev.log_index)
    return x.state > 0 ? x.liq / x.state : 1
  }

  // Old-grid path per (pid, leg key): ratio = grid[m] / round in force at N.
  const oldPath = new Map<string, { feed: Feed | 'STABLE'; pLiq: number }>()

  interface Toggles {
    price?: boolean
    composition?: boolean
    line?: boolean
  }
  const variantSpec = (s: PositionSpec, t: Toggles): PositionSpec => {
    const ev = t0Event(s)
    const f0 = firstEvent(s)
    const old = oldByPid.get(s.pid)
    // 1. values
    const revalue = (leg: SpecLeg, isDebt: boolean): SpecLeg => {
      if (!t.price || oldFeed(leg.symbol) === null) return leg
      return { ...leg, value0: valueNm1(ev, leg, isDebt) * rebaseOf(leg.symbol, s, ev) }
    }
    let collateral = s.collateral.map((l) => revalue(l, false))
    let debt = s.debt.map((l) => revalue(l, true))
    // 2. composition
    let halves: HalfSpec[]
    let line = s.line as number
    if (t.line) {
      // The old census's line: hf x debt / coll of the FIRST event's N-1 snapshot.
      const cs = a.inputs.aaveCsv.find(
        (r) =>
          r.chain === s.chain && r.tx_hash === f0.tx_hash && Number(r.log_index) === f0.log_index,
      ) as any
      line =
        (Number(cs.health_factor) * Number(cs.total_debt_base_usd)) /
        Number(cs.total_collateral_base_usd)
    }
    if (t.composition) {
      const cAsset = f0.collateral_asset
      const dAsset = f0.debt_asset
      const cRes =
        ev.position.find((x) => x.asset === cAsset) ?? f0.position.find((x) => x.asset === cAsset)!
      const dRes =
        ev.position.find((x) => x.asset === dAsset) ?? f0.position.find((x) => x.asset === dAsset)!
      let cVal: number
      let dVal: number
      if (t.price) {
        // Old basis: the whole N-1 snapshot rebased by the LIQUIDATED legs' feeds.
        cVal = sum(s.collateral.map((l) => valueNm1(ev, l, false))) * rebaseOf(cRes.symbol, s, ev)
        dVal = sum(s.debt.map((l) => valueNm1(ev, l, true))) * rebaseOf(dRes.symbol, s, ev)
      } else {
        cVal = sum(collateral.map((l) => l.value0))
        dVal = sum(debt.map((l) => l.value0))
      }
      collateral = [
        {
          key: cAsset,
          p0: Number(cRes.priceN),
          symbol: cRes.symbol,
          amount: 0,
          price0: null,
          value0: cVal,
          usd: cVal,
          lt: line,
        },
      ]
      debt = [
        {
          key: dAsset,
          p0: Number(dRes.priceN),
          symbol: dRes.symbol,
          amount: 0,
          price0: null,
          value0: dVal,
          usd: dVal,
        },
      ]
      halves = [
        {
          collateral,
          share: 1,
          line,
          delayClass: old?.delayClass === 'no-delay' ? 'no-delay' : 'delayed',
        },
      ]
    } else {
      const total = sum(collateral.map((l) => l.value0))
      const scale = t.line && s.line ? line / s.line : 1
      halves = s.halves.map((h) => {
        const legs = h.collateral.map((l) => collateral.find((c) => c.key === l.key)!)
        return {
          ...h,
          collateral: legs,
          share: s.halves.length > 1 ? sum(legs.map((l) => l.value0)) / total : 1,
          line: h.line * scale,
        }
      })
    }
    if (t.price) {
      for (const l of [...collateral, ...debt]) {
        const f = oldFeed(l.symbol)
        if (f === null) continue
        const pLiq =
          f === 'STABLE' ? 1 : inForce(f, s.chain, ev.block_number, ev.ts, ev.log_index).liq
        oldPath.set(`${s.pid}|${l.key}`, { feed: f, pLiq })
      }
    }
    const cU = sum(collateral.map((l) => l.value0))
    const dU = sum(debt.map((l) => l.value0))
    return { ...s, collateral, debt, halves, line, collUsd: cU, debtUsd: dU, ltv0: dU / cU }
  }
  const oldRatio = (s: PositionSpec, leg: KernelLeg, m: number): number | null | undefined => {
    const o = oldPath.get(`${s.pid}|${leg.key}`)
    if (!o) return undefined
    if (o.feed === 'STABLE') return 1
    const v = grid[o.feed][m]
    return v > 0 && o.pLiq > 0 ? v / o.pLiq : null
  }

  const run = (t: Toggles) => {
    oldPath.clear()
    const c = buildCensus(a.inputs, {
      onlyPids: pids,
      specOverride: (s) => variantSpec(s, t),
      ratioOverride: t.price ? oldRatio : undefined,
    })
    return new Map(c.rows.map((r) => [r.pid, r]))
  }

  const isL2 = (pid: string) => !pid.startsWith('aave-v3:mainnet:')
  const memT0 = (m: Map<string, CensusRow>, filter: (pid: string) => boolean = () => true) =>
    r2(sum([...pids].filter(filter).map((p) => m.get(p)?.mem?.closedT0 ?? 0)))
  const newMap = new Map([...pids].map((p) => [p, byPid.get(p)!]))
  const vPrice = run({ price: true })
  const vComp = run({ composition: true })
  const vLine = run({ line: true })
  const vAll = run({ price: true, composition: true, line: true })

  const oldMem = r2(sum(both.map((r) => r.membraneClosedUsd)))
  const oldReal = r2(sum(both.map((r) => r.aaveClosedUsd)))
  const newMemT0 = memT0(newMap)
  const newMemSaleMinute = r2(sum([...pids].map((p) => byPid.get(p)!.mem!.repaidUsd)))
  const newReal = r2(sum([...pids].map((p) => byPid.get(p)!.real.repaidUsd)))

  const fx = (v: Map<string, CensusRow>, filter?: (pid: string) => boolean) =>
    r2(memT0(newMap, filter) - memT0(v, filter))
  const factors = {
    priceSourceMainnet_i: fx(vPrice, (p) => !isL2(p)),
    composition_ii: fx(vComp),
    perChainOraclesL2_iii: fx(vPrice, isL2),
    line_iv: fx(vLine),
  }
  const explained = r2(sum(Object.values(factors)))
  const allToggled = memT0(vAll)

  // ---- per-row agreement ---------------------------------------------------------------------
  const perRow = both.map((o) => {
    const pid = aavePid(o.chain, AAVE_CORE_POOL[o.chain], o.user)
    const n = byPid.get(pid)!
    return {
      pid,
      oldMem: o.membraneClosedUsd as number,
      newMem: n.mem!.closedT0,
      allToggled: vAll.get(pid)?.mem?.closedT0 ?? 0,
      oldReal: o.aaveClosedUsd as number,
      newReal: n.real.repaidUsd,
      oldOutcome: o.outcome as string,
      newOutcome: n.mem!.outcome,
      legs: n.collateral.length,
      split: !!n.mem!.subs,
    }
  })
  const within = (f: (x: (typeof perRow)[number]) => [number, number], tol: number) =>
    perRow.filter((x) => {
      const [u, v] = f(x)
      return Math.abs(u - v) <= Math.max(0.01, tol * Math.max(Math.abs(u), Math.abs(v)))
    }).length
  const topMem = [...perRow]
    .sort((x, y) => Math.abs(y.newMem - y.oldMem) - Math.abs(x.newMem - x.oldMem))
    .slice(0, 10)
    .map((x) => ({
      pid: x.pid,
      oldMem: r2(x.oldMem),
      newMem: r2(x.newMem),
      allToggled: r2(x.allToggled),
      oldOutcome: x.oldOutcome,
      newOutcome: x.newOutcome,
      legs: x.legs,
      split: x.split,
    }))

  // ---- real side, decomposed exactly ----------------------------------------------------------
  let realPrice = 0
  let realDropped = 0
  let realDroppedEvents = 0
  let realCap = 0
  const evByKey = new Map(
    a.inputs.aaveEvents.map((e) => [`${e.chain}:${e.tx_hash}:${e.log_index}`, e]),
  )
  for (const o of both) {
    const pid = aavePid(o.chain, AAVE_CORE_POOL[o.chain], o.user)
    const csv = a.inputs.aaveCsv.filter((r) => r.chain === o.chain && r.user === o.user) as any[]
    let oldUncapped = 0
    for (const r of csv) {
      const ev = evByKey.get(`${r.chain}:${r.tx_hash}:${Number(r.log_index)}`)
      const p = ev?.position.find((x) => x.asset === r.debt_asset)
      const aave = p?.priceN ? Number(p.priceN) / AAVE_PRICE_UNIT : 0
      const cover = Number(r.debt_to_cover_normalized)
      const f = oldFeed(r.debt_symbol)
      if (f === null) {
        realDropped += cover * aave
        realDroppedEvents++
        continue
      }
      const pOld =
        f === 'STABLE'
          ? 1
          : inForce(f, r.chain, Number(r.block_number), Number(r.ts), Number(r.log_index)).liq *
            (r.debt_symbol === 'wstETH' ? wrap : 1)
      oldUncapped += cover * pOld
      realPrice += cover * (aave - pOld)
    }
    realCap += oldUncapped - o.aaveClosedUsd
    void pid
  }

  // ---- the price-source evidence from the pull ------------------------------------------------
  const clc = JSON.parse(fs.readFileSync(a.chainlinkCheckPath, 'utf8'))
  const feedMatch = Object.entries(clc.chains as Record<string, any[]>).flatMap(([chain, xs]) =>
    xs.map((x) => ({
      chain,
      symbol: x.symbol,
      kind: x.kind,
      source: x.sourceDescription ?? null,
      aggregator: x.feed?.aggregators?.[0]?.typeAndVersion ?? null,
      minuteMatchRate: x.matchRate == null ? null : Math.round(x.matchRate * 1e4) / 1e4,
    })),
  )

  const summary = {
    rows: both.length,
    oldPricedIncluded: oldRows.length,
    notWalkedInNew: missing,
    real: {
      old: oldReal,
      new: newReal,
      deltaUsd: r2(newReal - oldReal),
      decomposition: {
        debtPriceSource: r2(realPrice),
        eventsOldDropped: { usd: r2(realDropped), events: realDroppedEvents },
        oldCapAtDebt: r2(realCap),
      },
      rowsWithin1Pct: within((x) => [x.oldReal, x.newReal], 0.01),
    },
    membrane: {
      basis:
        'closedT0 (debt closed on the t0 basis, USD at the t0 block prices) — what the old membraneClosedUsd is',
      old: oldMem,
      new: newMemT0,
      newAtSaleMinuteUsd: newMemSaleMinute,
      deltaUsd: r2(newMemT0 - oldMem),
      factors,
      factorsSum: explained,
      interactionAndResidual: r2(newMemT0 - oldMem - explained),
      allFactorsToggled: allToggled,
      allFactorsToggledVsOld: r2(allToggled - oldMem),
      rowsWithin1Pct: within((x) => [x.oldMem, x.newMem], 0.01),
      rowsWithin1PctAllToggled: within((x) => [x.oldMem, x.allToggled], 0.01),
      sameOutcome: perRow.filter((x) => x.oldOutcome === x.newOutcome).length,
      multiLegRows: perRow.filter((x) => x.legs > 1).length,
      splitRows: perRow.filter((x) => x.split).length,
    },
  }
  return {
    method:
      'One factor at a time on the new census, over the old census priced & not-excluded rows that the new census walks. (i) price source on mainnet rows, (iii) the same toggle on L2 rows (the old census priced L2s through mainnet rounds on a timestamp rule), (ii) composition (single liquidated leg, old class), (iv) line (inverted HF at N-1). Effect = new - toggled.',
    summary,
    topMembraneDifferences: topMem,
    feedMatch,
  }
}
