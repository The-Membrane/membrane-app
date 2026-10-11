/**
 * The alert rules. Each rule reads one snapshot (plus context) and returns SIGNALS: one
 * number per key with the LevelSpec that judges it. The engine runs every signal through
 * its own anti-flap tracker (levels.ts). A signal with value null had no data — the
 * tracker is left untouched and the rule is listed as uncovered, never as "fine".
 */

import type { AlertConfig } from './config'
import { fmtBps, fmtHf, fmtPct, fmtPrice, fmtUsd } from './format'
import type { LevelSpec } from './levels'
import { recallNeededUsd, type PositionMetrics } from './metrics'
import { ORACLE_CHANGE_SEVERITY } from './oracleRegistry'
import type { Level, MarketContext, PositionSnapshot, TransitionKind } from './types'
import { levelOf } from './types'

export type RuleId =
  | 'health-factor'
  | 'ltv'
  | 'liquidation-distance'
  | 'cushion-burn'
  | 'collateral-depeg'
  | 'exit-capacity'
  | 'oracle-change'

export interface TransitionInfo {
  kind: TransitionKind
  from: Level
  to: Level
  threshold: number
}

export interface Signal {
  key: string
  value: number | null
  spec: LevelSpec
  /** Why value is null. */
  uncoveredReason?: string
  evidence: Record<string, number | string | null>
  describe(t: TransitionInfo): { title: string; detail: string }
}

export interface RuleInput {
  snapshot: PositionSnapshot
  metrics: PositionMetrics
  ctx: MarketContext
  /**
   * Health-factor history as [bucketStartTs, maxHfInBucket], oldest first, including the
   * current sample's bucket. See engine.ts for the bucket size.
   */
  hfHistory: ReadonlyArray<readonly [number, number]>
  /**
   * Total available exit capacity as [bucketStartTs, maxUsdInBucket], oldest first, for the
   * exit-capacity burn signal. Empty when that signal is off or no reading was fresh.
   */
  capHistory?: ReadonlyArray<readonly [number, number]>
  config: AlertConfig
}

export interface Rule {
  id: RuleId
  evaluate(input: RuleInput): Signal[]
}

const recovering = (k: TransitionKind) => k === 'clear' || k === 'ease'

// ------------------------------------------------------------------ health factor

export const healthFactorRule: Rule = {
  id: 'health-factor',
  evaluate: ({ metrics, config }) => {
    const spec = config.healthFactor
    if (!spec) return []
    const hf = metrics.healthFactor
    return [
      {
        key: 'hf',
        value: hf,
        spec,
        evidence: { healthFactor: hf, ltv: metrics.ltv, liquidationLtv: metrics.liquidationLtv },
        describe: (t) =>
          recovering(t.kind)
            ? {
                title: `Health factor back to ${fmtHf(hf)}`,
                detail: `Recovered above ${fmtHf(t.threshold)}.`,
              }
            : {
                title: `Health factor ${fmtHf(hf)}`,
                detail: `Below ${fmtHf(t.threshold)}. Liquidation starts at 1.00. LTV ${fmtPct(metrics.ltv)} against a ${fmtPct(metrics.liquidationLtv)} line.`,
              },
      },
    ]
  },
}

// ------------------------------------------------------------------ LTV (user lines)

export const ltvRule: Rule = {
  id: 'ltv',
  evaluate: ({ metrics, config }) => {
    const spec = config.ltv
    if (!spec) return []
    return [
      {
        key: 'ltv',
        value: metrics.ltv,
        spec,
        evidence: { ltv: metrics.ltv, liquidationLtv: metrics.liquidationLtv },
        describe: (t) =>
          recovering(t.kind)
            ? {
                title: `LTV back to ${fmtPct(metrics.ltv)}`,
                detail: `Under your ${fmtPct(t.threshold)} line again.`,
              }
            : {
                title: `LTV ${fmtPct(metrics.ltv)}`,
                detail: `Above your ${fmtPct(t.threshold)} line. The venue liquidates at ${fmtPct(metrics.liquidationLtv)}.`,
              },
      },
    ]
  },
}

// ------------------------------------------------------------------ distance to liquidation price

export const liquidationDistanceRule: Rule = {
  id: 'liquidation-distance',
  evaluate: ({ metrics, ctx, config }) => {
    const cfg = config.liquidationDistance
    const d = metrics.dominant
    if (!cfg || !d) return []
    const distance = d.distance ?? Infinity
    const liq = d.liquidationPriceUsd
    const sigma = ctx.hourlyVol?.[d.symbol]
    const useSigma = cfg.mode === 'sigma' && sigma !== undefined && sigma > 0
    const logDist = distance < 1 ? -Math.log(1 - distance) : Infinity
    const value = useSigma ? logDist / ((sigma as number) * Math.sqrt(cfg.horizonH)) : distance
    const where = liq === null ? 'no liquidation price' : `${d.symbol} at ${fmtPrice(liq)}`
    return [
      {
        key: `${d.symbol}:${useSigma ? 'sigma' : 'pct'}`,
        value,
        spec: useSigma ? cfg.sigmaSpec : cfg.spec,
        evidence: {
          symbol: d.symbol,
          price: d.priceUsd,
          liquidationPrice: liq,
          distance: d.distance,
          hourlyVol: sigma ?? null,
          sigmas: useSigma ? value : null,
        },
        describe: (t) => {
          const move = Number.isFinite(distance) ? `-${fmtPct(distance)}` : 'n/a'
          const scale = useSigma
            ? ` That is ${value.toFixed(1)} sigma of ${d.symbol}'s current ${cfg.horizonH}h volatility.`
            : ''
          return recovering(t.kind)
            ? {
                title: `Liquidation price further away`,
                detail: `Liquidation now at ${where} (${move} from ${fmtPrice(d.priceUsd)}).`,
              }
            : {
                title: `Liquidation if ${where}`,
                detail: `${move} from ${fmtPrice(d.priceUsd)}.${scale}`,
              }
        },
      },
    ]
  },
}

// ------------------------------------------------------------------ cushion burn (speed)

/**
 * Share of the cushion above health factor 1.0 lost since the peak of the lookback window.
 * Scale-free: a looper parked at HF 1.005 and a borrower at HF 1.4 are judged on the same
 * axis — how much of what stood between them and liquidation just went.
 */
export function cushionBurn(
  hfHistory: RuleInput['hfHistory'],
  now: number,
  lookbackS: number,
  current: number,
): number | null {
  let peak = current
  for (const [t, hf] of hfHistory) {
    if (t < now - lookbackS || t > now) continue
    if (hf > peak) peak = hf
  }
  if (!Number.isFinite(current) || !(peak > 1)) return null
  return Math.max(0, (peak - current) / (peak - 1))
}

export const cushionBurnRule: Rule = {
  id: 'cushion-burn',
  evaluate: ({ snapshot, metrics, hfHistory, config }) => {
    const cfg = config.cushionBurn
    if (!cfg || !Number.isFinite(metrics.healthFactor)) return []
    const hf = metrics.healthFactor
    const burn = hf >= cfg.maxHf ? 0 : cushionBurn(hfHistory, snapshot.ts, cfg.lookbackS, hf)
    const hours = cfg.lookbackS / 3600
    return [
      {
        key: 'hf',
        value: burn,
        spec: cfg.spec,
        uncoveredReason:
          burn === null ? 'no health-factor history above 1.0 in the lookback window' : undefined,
        evidence: { healthFactor: hf, burn, lookbackS: cfg.lookbackS },
        describe: (t) =>
          recovering(t.kind)
            ? { title: `Health factor steadied at ${fmtHf(hf)}`, detail: `No longer falling fast.` }
            : {
                title: `Health factor falling fast: ${fmtHf(hf)}`,
                detail: `${fmtPct(burn ?? 0, 0)} of the cushion above 1.00 went in the last ${hours}h.`,
              },
      },
    ]
  },
}

// ------------------------------------------------------------------ collateral depeg

export const depegRule: Rule = {
  id: 'collateral-depeg',
  evaluate: ({ snapshot, metrics, ctx, config }) => {
    const cfg = config.depeg
    if (!cfg) return []
    const out: Signal[] = []
    for (const c of snapshot.collateral) {
      if (!c.peg) continue
      const share =
        metrics.collateralUsd > 0 ? (c.amount * c.oraclePriceUsd) / metrics.collateralUsd : 0
      if (share < cfg.minShare) continue
      const ref = c.peg.underlying === 'USD' ? 1 : ctx.underlyingUsd?.[c.peg.underlying]
      const market = c.marketPriceUsd ?? c.oraclePriceUsd
      const bps = ref && ref > 0 ? (1 - market / (ref * c.peg.rate)) * 1e4 : null
      const basis = c.oracleBasis ?? 'market'
      const spec = c.peg.class === 'stable' ? cfg.stable : cfg.lst
      const vs = c.peg.underlying === 'USD' ? '$1' : c.peg.underlying
      out.push({
        key: c.symbol,
        value: bps,
        spec,
        uncoveredReason: bps === null ? `no ${c.peg.underlying} price in context` : undefined,
        evidence: {
          symbol: c.symbol,
          depegBps: bps,
          marketPrice: market,
          oracleBasis: basis,
          healthFactor: metrics.healthFactor,
          marketHealthFactor: metrics.marketHealthFactor,
          share,
        },
        describe: (t) => {
          if (recovering(t.kind))
            return {
              title: `${c.symbol} back near its peg`,
              detail: `${fmtBps(bps ?? 0)} below ${vs}.`,
            }
          const seen =
            basis === 'market'
              ? `Your venue's oracle follows the market, so health factor (${fmtHf(metrics.healthFactor)}) already counts it.`
              : `Your venue prices ${c.symbol} by ${basis === 'hardcoded' ? 'a fixed value' : 'exchange rate'}: health factor stays ${fmtHf(metrics.healthFactor)}, but at market prices it is ${fmtHf(metrics.marketHealthFactor)}. Selling now takes the discount.`
          return { title: `${c.symbol} ${fmtBps(bps ?? 0)} below ${vs}`, detail: seen }
        },
      })
    }
    return out
  },
}

// ------------------------------------------------------------------ exit capacity vs recall needed

/** Share of the trailing peak capacity that is gone now, 0–1. null without a peak above 0. */
export function capacityBurn(
  capHistory: RuleInput['capHistory'],
  now: number,
  lookbackS: number,
  current: number,
): number | null {
  let peak = current
  for (const [t, usd] of capHistory ?? []) {
    if (t < now - lookbackS || t > now) continue
    if (usd > peak) peak = usd
  }
  if (!Number.isFinite(current) || !(peak > 0)) return null
  return Math.max(0, 1 - current / peak)
}

export const exitCapacityRule: Rule = {
  id: 'exit-capacity',
  evaluate: ({ snapshot, ctx, capHistory, config }) => {
    const cfg = config.exitCapacity
    if (!cfg) return []
    const fresh = (ctx.capacity ?? []).filter(
      (r) => Number.isFinite(r.availableUsd) && snapshot.ts - r.asOf <= cfg.maxAgeS,
    )
    const need = recallNeededUsd(snapshot, cfg.shock, cfg.targetHf)
    const available = fresh.reduce((a, r) => a + Math.max(0, r.availableUsd), 0)
    const value = fresh.length === 0 ? null : need > 0 ? available / need : Infinity
    const venues = fresh.map((r) => r.venue).join(', ') || null
    const signals: Signal[] = [
      {
        key: 'recall',
        value,
        spec: cfg.spec,
        uncoveredReason: fresh.length === 0 ? 'no fresh venue capacity reading' : undefined,
        evidence: {
          availableUsd: fresh.length ? available : null,
          recallNeededUsd: need,
          shock: cfg.shock,
          venues,
        },
        describe: (t) =>
          recovering(t.kind)
            ? {
                title: `Venue exit capacity recovered`,
                detail: `${fmtUsd(available)} can leave against ${fmtUsd(need)} needed.`,
              }
            : {
                title: `Venue exit capacity ${fmtUsd(available)}`,
                detail: `A ${fmtPct(cfg.shock, 0)} drop would need ${fmtUsd(need)} recalled to hold HF ${fmtHf(cfg.targetHf)}. Cover: ${(value ?? 0).toFixed(2)}x.`,
              },
      },
    ]
    const burnCfg = cfg.burn
    // The burn only matters while the position could need a recall at all.
    if (burnCfg && need > 0) {
      const burn =
        fresh.length === 0
          ? null
          : capacityBurn(capHistory, snapshot.ts, burnCfg.lookbackS, available)
      const hours = burnCfg.lookbackS / 3600
      signals.push({
        key: 'burn',
        value: burn,
        spec: burnCfg.spec,
        uncoveredReason:
          fresh.length === 0
            ? 'no fresh venue capacity reading'
            : burn === null
              ? 'no capacity above zero in the lookback window'
              : undefined,
        evidence: {
          availableUsd: fresh.length ? available : null,
          burn,
          lookbackS: burnCfg.lookbackS,
          venues,
        },
        describe: (t) =>
          recovering(t.kind)
            ? {
                title: `Venue exit capacity steadied`,
                detail: `${fmtUsd(available)} can leave now.`,
              }
            : {
                title: `Venue exit capacity falling fast: ${fmtUsd(available)}`,
                detail: `${fmtPct(burn ?? 0, 0)} of the exit capacity went in the last ${hours}h. A recall of ${fmtUsd(need)} may not get out.`,
              },
      })
    }
    return signals
  },
}

// ------------------------------------------------------------------ oracle change

export const oracleChangeRule: Rule = {
  id: 'oracle-change',
  evaluate: ({ snapshot, ctx, config }) => {
    const cfg = config.oracleChange
    if (!cfg) return []
    if (!ctx.oracleEventsCovered) {
      return [
        {
          key: 'oracle',
          value: null,
          spec: cfg.spec,
          uncoveredReason: 'oracle registry not wired',
          evidence: {},
          describe: () => ({ title: '', detail: '' }),
        },
      ]
    }
    const held = new Set([
      ...snapshot.collateral.map((c) => c.symbol),
      ...snapshot.debt.map((d) => d.symbol),
    ])
    const recent = (ctx.oracleEvents ?? []).filter(
      (e) => held.has(e.asset) && e.ts <= snapshot.ts && snapshot.ts - e.ts <= cfg.windowS,
    )
    const worst = recent.reduce(
      (m, e) => Math.max(m, levelOf(e.severity ?? ORACLE_CHANGE_SEVERITY[e.kind])),
      0,
    )
    const latest = recent[recent.length - 1]
    return [
      {
        key: 'oracle',
        value: worst,
        spec: cfg.spec,
        evidence: {
          events: recent.length,
          latestKind: latest?.kind ?? null,
          latestAsset: latest?.asset ?? null,
        },
        describe: (t) =>
          recovering(t.kind)
            ? {
                title: `No recent oracle changes`,
                detail: `None in the last ${cfg.windowS / 3600}h on assets you hold.`,
              }
            : {
                title: `Oracle change on ${latest?.asset ?? 'a held asset'}`,
                detail: recent
                  .map((e) => `${e.asset}: ${e.kind.replace(/_/g, ' ')} — ${e.detail}`)
                  .join('; '),
              },
      },
    ]
  },
}

export const ALL_RULES: readonly Rule[] = [
  healthFactorRule,
  ltvRule,
  liquidationDistanceRule,
  cushionBurnRule,
  depegRule,
  exitCapacityRule,
  oracleChangeRule,
]
