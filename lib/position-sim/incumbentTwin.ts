/**
 * incumbentTwin — the incumbent twin of a Risk Frontier stress node: what Aave V3, Spark or
 * Morpho Blue would sell on the SAME position under the SAME price path, under that venue's
 * own liquidation rules. ENGINE ONLY: it returns numbers, never copy (the one exception is
 * each venue's name, market and provenance line, data the UI shows next to the figures).
 *
 * ONE ENGINE. The twin does not reimplement a liquidation. It hands the node's own walk
 * inputs (stressGrid `stressWalkInputs`: the normalized collateral and debt and the exact
 * price path, hold tail included) to the SOURCE engine of the per-address simulator
 * (compare.ts `runSource`), with the venue's close factor as a rule. The price move is the
 * same in both runs, so the gap between the two sold figures is the engines' rules and
 * nothing else (compare.ts header). tests/unit/incumbentTwin.test.ts replays the Oct 10
 * census through `runComparison` and through this adapter and asserts the same liquidations.
 *
 * ---------------------------------------------------------------------------
 * REAL, read at mainnet block 23,543,615 (2025-10-09 23:59:59 UTC, the read block of
 * public/data/oct10-2025/protocols.json)
 * ---------------------------------------------------------------------------
 *  Threshold and bonus (WETH collateral):
 *   - Aave V3      83%, 5%   protocols.json aaveV3.reserves.WETH.
 *   - Spark        86%, 5%   PoolDataProvider 0xFc21d6d146E6086B8359705C8b28512a983db0cb
 *                            getReserveConfigurationData(WETH), read 2026-10-12 from
 *                            eth.drpc.org and gateway.tenderly.co (they agree).
 *   - Morpho Blue  LLTV 86%  WETH/USDC market 0x7dde86a1…f758, protocols.json
 *                            morphoBlue.markets. Bonus = LIF − 1, LIF = min(1.15,
 *                            1 / (1 − 0.3 × (1 − LLTV))): immutable constants,
 *                            protocols.json morphoBlue.liquidationIncentive.
 *  Close factor:
 *   - Aave V3 (v3.3+ logic, POOL_REVISION 9): 50% of the debt while HF > 0.95 AND the
 *     collateral AND the debt are each ≥ $2,000; else the whole debt. A partial that would
 *     leave debt or collateral under $1,000 reverts (MUST_NOT_LEAVE_DUST), so the liquidator
 *     takes the whole debt. The 0.95, $2,000 and $1,000 were READ from the linked
 *     LiquidationLogic library 0x36ae486289bb807c3c79a1427b9c3d934294ef43 at the read block
 *     (CLOSE_FACTOR_HF_THRESHOLD, MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD, MIN_LEFTOVER_BASE; the
 *     Pool itself has no getter, protocols.json closeFactor.onchain). The 50% is internal:
 *     documented, protocols.json closeFactor.documented.
 *   - Spark (v3.0 logic, POOL_REVISION 4): 50% while HF > 0.95, else the whole debt. No size
 *     rule, no dust rule. The 0.95 and the 100% were READ from the linked library
 *     0xc0816efc31779c697b18b3b68f1dfbede313e1fa (CLOSE_FACTOR_HF_THRESHOLD,
 *     MAX_LIQUIDATION_CLOSE_FACTOR). The 50% is internal: sparklend-v1-core
 *     contracts/protocol/libraries/logic/LiquidationLogic.sol, the same rule at revisions 3
 *     and 5.
 *   - Morpho Blue: no close factor. Modelled as the whole debt: the measured Oct 10 median
 *     repay was 100% (protocols.json measuredLiquidations.morphoBlue).
 *
 * ---------------------------------------------------------------------------
 * MODELLED (the † label, membrane-board design/DESIGN_RULES.md §4)
 * ---------------------------------------------------------------------------
 *  - The node's own assumptions: ONE collateral asset at the venue's WETH parameters, its
 *    price moved by the node's shape; debt a stable held at $1.
 *  - A liquidation fires at the first step the LTV is over the threshold, and again while it
 *    stays over, at the source engine's cadence (two steps apart at least,
 *    compare.ts MIN_SOURCE_EVENT_GAP_MINUTES).
 *  - Each event repays the close-factor share and seizes repay × (1 + bonus) of collateral,
 *    capped by what is left. Debt left with no collateral is bad debt.
 *  - After the node's path ends the price holds for SETTLE_STEPS more steps, so a running
 *    liquidation sequence finishes inside the horizon (a no-delay node's path ends one step
 *    after its shape).
 *  - OMITTED: gas, MEV, slippage, interest, and a liquidator who does not show up. A real
 *    liquidation needs a profitable liquidator in that minute (compare.ts caveats).
 *  - The sold figure INCLUDES the incumbent's bonus. Membrane's `exposedUsd` LEAVES OUT its
 *    fees (stressGrid header). The two are not on the same footing; the copy must say so.
 */

import { MIN_SOURCE_EVENT_GAP_MINUTES, runSource, type SourceCloseFactor } from './compare'
import {
  MAX_STRESS_SALES,
  runStress,
  stressCellCanonical,
  stressGridScenarios,
  stressWalkInputs,
  type StressCell,
  type StressGridOptions,
  type StressPosition,
  type StressResult,
  type StressRunOptions,
  type StressScenario,
} from './stressGrid'
import { stamp, type PricePath, type ProtocolPosition, type SimEvent, type SimRun } from './types'

// ---------------------------------------------------------------- constants

/** The mainnet block every parameter below was read at (protocols.json readBlock). */
export const INCUMBENT_READ_BLOCK = 23_543_615

/** Morpho Blue's immutable liquidation-incentive constants (ConstantsLib.sol). */
export const MORPHO_MAX_LIF = 1.15
export const MORPHO_LIQUIDATION_CURSOR = 0.3

/** Morpho Blue's bonus for a market: LIF − 1, LIF = min(MAX_LIF, 1 / (1 − CURSOR × (1 − LLTV))). */
export function morphoLiquidationBonus(lltv: number): number {
  return Math.min(MORPHO_MAX_LIF, 1 / (1 - MORPHO_LIQUIDATION_CURSOR * (1 - lltv))) - 1
}

/** Steps the price holds after the node's path, so a liquidation sequence can finish. */
export const SETTLE_STEPS = (MIN_SOURCE_EVENT_GAP_MINUTES + 1) * MAX_STRESS_SALES

const DUST_USD = 1e-6

// -------------------------------------------------------------------- types

export type IncumbentId = 'aave-v3' | 'spark' | 'morpho-blue'

export type IncumbentCloseFactor =
  /** Aave v3.3+: partial only at HF > threshold with both sides ≥ minBase; no dust leftover. */
  | {
      kind: 'aave-v3.3'
      defaultFactor: number
      hfThreshold: number
      minBaseUsd: number
      minLeftoverUsd: number
    }
  /** Aave v3.0 (Spark): partial at HF > threshold, else the whole debt. */
  | { kind: 'aave-v3.0'; defaultFactor: number; hfThreshold: number }
  /** No close factor (Morpho Blue): the whole debt. */
  | { kind: 'whole-loan' }
  /** A fixed share, e.g. the measured Oct 10 median (compare.ts `measuredRepayFraction`). */
  | { kind: 'fixed'; fraction: number }

export interface IncumbentRules {
  id: IncumbentId
  /** 'Aave V3'. */
  name: string
  /** 'Aave': where a line has room for one word. */
  shortName: string
  /** 'WETH collateral' / 'WETH/USDC 86% market'. */
  market: string
  liquidationThreshold: number
  /** On top of the repaid value: 0.05 = the liquidator seizes 105%. */
  liquidationBonus: number
  closeFactor: IncumbentCloseFactor
  /** One line: where every number comes from. */
  provenance: string
}

const MORPHO_WETH_USDC_LLTV = 0.86

export const INCUMBENT_TWINS: Readonly<Record<IncumbentId, IncumbentRules>> = {
  'aave-v3': {
    id: 'aave-v3',
    name: 'Aave V3',
    shortName: 'Aave',
    market: 'WETH collateral',
    liquidationThreshold: 0.83,
    liquidationBonus: 0.05,
    closeFactor: {
      kind: 'aave-v3.3',
      defaultFactor: 0.5,
      hfThreshold: 0.95,
      minBaseUsd: 2_000,
      minLeftoverUsd: 1_000,
    },
    provenance:
      'Aave V3 Ethereum, WETH reserve at block 23,543,615: 83% threshold and 5% bonus (protocols.json). Close factor (v3.3+): 0.95 HF, $2,000 and $1,000 read from LiquidationLogic 0x36ae…ef43; the 50% is documented.',
  },
  spark: {
    id: 'spark',
    name: 'Spark',
    shortName: 'Spark',
    market: 'WETH collateral',
    liquidationThreshold: 0.86,
    liquidationBonus: 0.05,
    closeFactor: { kind: 'aave-v3.0', defaultFactor: 0.5, hfThreshold: 0.95 },
    provenance:
      'SparkLend Ethereum, WETH reserve at block 23,543,615: 86% threshold and 5% bonus (PoolDataProvider 0xFc21…0cb). Close factor (v3.0): 0.95 HF and 100% read from LiquidationLogic 0xc081…e1fa; the 50% is from the sparklend-v1-core source.',
  },
  'morpho-blue': {
    id: 'morpho-blue',
    name: 'Morpho Blue',
    shortName: 'Morpho',
    market: 'WETH/USDC 86% market',
    liquidationThreshold: MORPHO_WETH_USDC_LLTV,
    liquidationBonus: morphoLiquidationBonus(MORPHO_WETH_USDC_LLTV),
    closeFactor: { kind: 'whole-loan' },
    provenance:
      'Morpho Blue market 0x7dde…f758 (WETH/USDC) at block 23,543,615: 86% LLTV (protocols.json). Bonus from the immutable LIF formula (max 1.15, cursor 0.3). No close factor: the whole loan, as the measured Oct 10 median.',
  },
}

/** Picker order. */
export const INCUMBENT_ORDER: readonly IncumbentId[] = ['aave-v3', 'spark', 'morpho-blue']

/** The default twin: Aave V3, the largest venue and the one the Oct 10 census is drawn from. */
export const DEFAULT_INCUMBENT: IncumbentId = 'aave-v3'

/** The share of the debt one liquidation repays under a close-factor rule, 0–1. */
export function incumbentCloseFactor(
  cf: IncumbentCloseFactor,
  s: Parameters<SourceCloseFactor>[0],
): number {
  switch (cf.kind) {
    case 'fixed':
      return cf.fraction
    case 'whole-loan':
      return 1
    case 'aave-v3.0':
      return s.healthFactor > cf.hfThreshold ? cf.defaultFactor : 1
    case 'aave-v3.3': {
      const partial =
        s.healthFactor > cf.hfThreshold &&
        s.collateralUsd >= cf.minBaseUsd &&
        s.debtUsd >= cf.minBaseUsd
      if (!partial) return 1
      // MUST_NOT_LEAVE_DUST: a partial that leaves debt OR collateral under the minimum
      // reverts, so the liquidator takes the whole debt. A seize that takes ALL the
      // collateral is not a partial on that side (LiquidationLogic only checks when both
      // sides are partial).
      const repay = cf.defaultFactor * s.debtUsd
      const seize = repay * (1 + s.bonus)
      if (
        seize < s.collateralUsd &&
        (s.debtUsd - repay < cf.minLeftoverUsd || s.collateralUsd - seize < cf.minLeftoverUsd)
      ) {
        return 1
      }
      return cf.defaultFactor
    }
  }
}

function resolveRules(incumbent: IncumbentId | IncumbentRules): IncumbentRules {
  return typeof incumbent === 'string' ? INCUMBENT_TWINS[incumbent] : incumbent
}

// ------------------------------------------------------------------- run

const COLLATERAL = 'COLLATERAL'
const DEBT = 'DEBT'

/**
 * The incumbent's engine on one scalar path: `collateralUsd` of one asset whose price moves
 * by `ratios` (price ÷ t0 price), against `debtUsd` of a stable at $1. This is compare.ts
 * `runSource` on a one-leg position; nothing else.
 */
export function runIncumbentOnPath(
  collateralUsd: number,
  debtUsd: number,
  ratios: readonly number[],
  stepSeconds: number,
  incumbent: IncumbentId | IncumbentRules,
): SimRun {
  const rules = resolveRules(incumbent)
  const lt = rules.liquidationThreshold
  const position: ProtocolPosition = {
    protocol: rules.id,
    label: rules.name,
    collateral: [
      {
        symbol: COLLATERAL,
        address: '',
        decimals: 18,
        amount: collateralUsd,
        priceUsd: 1,
        valueUsd: collateralUsd,
        liquidationThreshold: lt,
        maxLtv: lt,
        liquidationBonus: rules.liquidationBonus,
      },
    ],
    debt: [
      {
        symbol: DEBT,
        address: '',
        decimals: 18,
        amount: debtUsd,
        priceUsd: 1,
        valueUsd: debtUsd,
        borrowApr: null,
      },
    ],
    totalCollateralUsd: collateralUsd,
    totalDebtUsd: debtUsd,
    ltv: collateralUsd > 0 ? debtUsd / collateralUsd : Infinity,
    liquidationLtv: lt,
    healthFactor: debtUsd > 0 ? (lt * collateralUsd) / debtUsd : Infinity,
    provenance: stamp('modelled', `${rules.name} twin · modelled`, rules.provenance, 0),
  }
  const path: PricePath = {
    startTs: 0,
    stepSeconds,
    count: ratios.length,
    series: {
      [COLLATERAL]: ratios.slice(),
      [DEBT]: new Array<number | null>(ratios.length).fill(1),
    },
    provenance: stamp('modelled', 'stress scenario price path', undefined, 0),
  }
  const cf = rules.closeFactor
  return runSource(position, path, {
    venue: null,
    sourceRepayFraction: cf.kind === 'fixed' ? cf.fraction : 1,
    sourceRepayFractionLabel: closeFactorLabel(cf),
    sourceCloseFactor: cf.kind === 'fixed' ? undefined : (s) => incumbentCloseFactor(cf, s),
  })
}

/** A short machine-side label for the engine's own event text. */
function closeFactorLabel(cf: IncumbentCloseFactor): string {
  switch (cf.kind) {
    case 'fixed':
      return `${(cf.fraction * 100).toFixed(1)}% fixed`
    case 'whole-loan':
      return 'no close factor'
    case 'aave-v3.0':
      return `close factor ${cf.defaultFactor * 100}% above HF ${cf.hfThreshold}`
    case 'aave-v3.3':
      return `close factor ${cf.defaultFactor * 100}% above HF ${cf.hfThreshold} and $${cf.minBaseUsd}`
  }
}

export interface IncumbentTwin {
  incumbent: IncumbentId
  rules: IncumbentRules
  /** Collateral the incumbent would seize, USD at seize-time prices, its bonus INCLUDED. */
  incumbentSoldUsd: number
  /** The part of `incumbentSoldUsd` that is the liquidator's bonus. */
  incumbentBonusUsd: number
  /** Debt its liquidations repaid. */
  incumbentRepaidUsd: number
  /** Collateral price ÷ its t0 price at the FIRST liquidation (0.75 = 25% under now). Null: none. */
  incumbentLiquidationPrice: number | null
  incumbentTimeToLiquidationSeconds: number | null
  /** Liquidation calls. */
  incumbentLiquidations: number
  /** Debt left once its collateral ran out. */
  incumbentBadDebtUsd: number
  /** Membrane's sold figure on the same node (`StressModelled.exposedUsd`), fees LEFT OUT. */
  membraneSoldUsd: number
  /** Collateral price ÷ t0 at Membrane's first sale on the same path. Null: nothing sold. */
  membraneLiquidationPrice: number | null
  /** The source engine's liquidation events (index = step on the twin path). */
  events: SimEvent[]
  /** The node's horizon plus the settle hold, seconds. */
  horizonSeconds: number
}

interface IncumbentPathRun {
  run: SimRun
  ratios: number[]
  stepSeconds: number
}

function runOnNode(
  position: StressPosition,
  scenario: StressScenario,
  rules: IncumbentRules,
  opts: StressRunOptions,
): IncumbentPathRun | null {
  const w = stressWalkInputs(position, scenario, opts)
  if (!w) return null
  const last = w.ratios[w.ratios.length - 1]
  const ratios = [...w.ratios, ...new Array<number>(SETTLE_STEPS).fill(last)]
  return {
    run: runIncumbentOnPath(w.collateralUsd, w.debtUsd, ratios, w.stepSeconds, rules),
    ratios,
    stepSeconds: w.stepSeconds,
  }
}

function twinOf(p: IncumbentPathRun, rules: IncumbentRules, membrane: StressResult): IncumbentTwin {
  const liq = p.run.events.filter((e) => e.kind === 'liquidation')
  const first = liq[0]
  const sum = (f: (e: SimEvent) => number) => liq.reduce((a, e) => a + f(e), 0)
  const priceAt = (i: number) => p.ratios[Math.min(p.ratios.length - 1, Math.max(0, i))]
  const saleAt =
    membrane.outcome !== 'not_modelled' && membrane.timeToSaleSeconds !== null
      ? Math.round(membrane.timeToSaleSeconds / p.stepSeconds)
      : null
  const endColl = p.run.endCollateralUsd
  const endDebt = p.run.endDebtUsd
  return {
    incumbent: rules.id,
    rules,
    incumbentSoldUsd: sum((e) => e.seizedUsd),
    incumbentBonusUsd: sum((e) => e.penaltyUsd),
    incumbentRepaidUsd: sum((e) => e.repaidUsd),
    incumbentLiquidationPrice: first ? priceAt(first.minute) : null,
    incumbentTimeToLiquidationSeconds: first ? first.minute * p.stepSeconds : null,
    incumbentLiquidations: liq.length,
    incumbentBadDebtUsd: endDebt > DUST_USD && !(endColl > DUST_USD) ? endDebt : 0,
    membraneSoldUsd: membrane.outcome === 'not_modelled' ? 0 : membrane.exposedUsd,
    membraneLiquidationPrice: saleAt === null ? null : priceAt(saleAt),
    events: liq,
    horizonSeconds: (p.ratios.length - 1) * p.stepSeconds,
  }
}

/**
 * The incumbent twin of ONE node. Null when the Membrane node is not modelled: there is
 * nothing to stand it next to. `membrane` is the node's own result when the caller has it.
 */
export function runIncumbentTwin(
  position: StressPosition,
  scenario: StressScenario,
  incumbent: IncumbentId | IncumbentRules = DEFAULT_INCUMBENT,
  opts: StressRunOptions & { membrane?: StressResult } = {},
): IncumbentTwin | null {
  const membrane = opts.membrane ?? runStress(position, scenario, opts)
  if (membrane.outcome === 'not_modelled') return null
  const rules = resolveRules(incumbent)
  const p = runOnNode(position, scenario, rules, opts)
  return p ? twinOf(p, rules, membrane) : null
}

/**
 * A twin runner for many nodes of ONE position. A venue condition changes nothing for the
 * incumbent (it has no recall), so the incumbent runs once per price shape and every node
 * on that shape shares it.
 */
export function incumbentTwinRunner(
  position: StressPosition,
  incumbent: IncumbentId | IncumbentRules = DEFAULT_INCUMBENT,
  opts: StressRunOptions = {},
): (scenario: StressScenario, membrane: StressResult) => IncumbentTwin | null {
  const rules = resolveRules(incumbent)
  const cache = new Map<string, IncumbentPathRun | null>()
  return (scenario, membrane) => {
    if (membrane.outcome === 'not_modelled') return null
    const key = stressCellCanonical(position, { price: scenario.price }, opts)
    let p = cache.get(key)
    if (p === undefined) {
      // The node's full scenario, not the bare price: its venue can be what makes it modelled.
      p = runOnNode(position, scenario, rules, opts)
      if (p) cache.set(key, p)
    }
    return p ? twinOf(p, rules, membrane) : null
  }
}

export interface TwinStressCell extends StressCell {
  twin: IncumbentTwin | null
}

/** `runStressGrid` with the incumbent twin next to every node. */
export function runStressGridWithTwin(
  position: StressPosition,
  incumbent: IncumbentId | IncumbentRules = DEFAULT_INCUMBENT,
  opts: StressGridOptions = {},
): TwinStressCell[] {
  const twin = incumbentTwinRunner(position, incumbent, opts)
  return stressGridScenarios(position.tradeShape, opts).map((scenario) => {
    const result = runStress(position, scenario, opts)
    return { scenario, result, twin: twin(scenario, result) }
  })
}
