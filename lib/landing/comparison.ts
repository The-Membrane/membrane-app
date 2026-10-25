/**
 * "[VENUE] VS MEMBRANE" — the checkmark table (layout reference: the Wrike vs Asana
 * page). Rows are FACTS ONLY. Venue cells are rendered from public/data/oct10-2025/
 * protocols.json (Aave V3 close factor, read reserve bonuses, Morpho Blue's missing close
 * factor and measured repay fractions); Membrane cells cite membrane-solidity master at
 * SOLIDITY_PIN (checked line by line in tests/unit/landingCitations.test.ts). A cell is
 * ✓ only where the cite proves it; "partially" where that is the truth.
 *
 * Dropped, for the report: a liquidation-fee row. Master's deploy script sets LIQ_FEE =
 * 1% (script/DeployFullSystem.s.sol:198, cap 5% at LiquidationEngine.sol:420), while the
 * replay engine charges Membrane 0% (owner ruling 2026-09-14 on an earlier commit). The
 * table will not state a fee the replay above it contradicts.
 */

import { CURE_WINDOW_HOURS, MAX_THRESHOLD_TO_DELAY } from '@/lib/position-sim/membrane'

import { CARRY_CITES } from './carry'
import { CITES, citeText, type Cite } from './objections'

export type Mark = 'yes' | 'no' | 'partial' | 'na'

export interface Cell {
  mark: Mark
  /** Short, ≤ 6 words. */
  text: string
}

export interface ComparisonRow {
  id: string
  label: string
  aave: Cell
  morpho: Cell
  membrane: Cell
  /** Where each cell comes from (Details / tooltip). */
  sources: string[]
}

export interface VenueDoc {
  aaveV3?: {
    reserves?: Record<string, { liquidationBonusPct?: number; usageAsCollateralEnabled?: boolean }>
    closeFactor?: { documented?: { DEFAULT_LIQUIDATION_CLOSE_FACTOR_pct?: number; CLOSE_FACTOR_HF_THRESHOLD?: number } }
  }
  morphoBlue?: { hasCloseFactor?: boolean | null; liquidationIncentive?: { MAX_LIQUIDATION_INCENTIVE_FACTOR?: number } }
  measuredLiquidations?: { aaveV3?: { medianRepayFraction?: number }; morphoBlue?: { medianRepayFraction?: number } }
}

const pct = (x: number) => `${Math.round(x * 100)}%`
const cites = (...c: Cite[]) => c.map((x) => `${citeText(x)}`).join(' · ')

/** Rows for a page. `carry` adds the recall row. Pure: same input, same table. */
export function comparisonRows(doc: VenueDoc | null, carry: boolean): ComparisonRow[] {
  const band = `${Math.round(MAX_THRESHOLD_TO_DELAY * 100)}%`
  const cf = doc?.aaveV3?.closeFactor?.documented
  const aaveMedian = doc?.measuredLiquidations?.aaveV3?.medianRepayFraction
  const morphoMedian = doc?.measuredLiquidations?.morphoBlue?.medianRepayFraction
  const rows: ComparisonRow[] = [
    {
      id: 'window',
      label: `${CURE_WINDOW_HOURS}h window within ${band} of the line`,
      aave: { mark: 'no', text: 'none per position' },
      morpho: { mark: 'no', text: 'none per position' },
      membrane: { mark: 'yes', text: `${CURE_WINDOW_HOURS}h, inside the ${band} band` },
      sources: [
        'Aave V3 and Morpho Blue: liquidation is callable once health factor is below 1 (Aave V3 LiquidationLogic; Morpho Blue Morpho.sol liquidate; protocols.json sources). Aave V3.1’s reserve grace period follows a governance unpause only; it is not per position.',
        `Membrane: ${cites(CITES.delayConfig, CITES.launchBand, CARRY_CITES.recallStep)}`,
      ],
    },
    {
      id: 'partial',
      label: 'Sells only back to the borrowable LTV',
      aave:
        cf?.DEFAULT_LIQUIDATION_CLOSE_FACTOR_pct && cf.CLOSE_FACTOR_HF_THRESHOLD
          ? {
              mark: 'partial',
              text: `${cf.DEFAULT_LIQUIDATION_CLOSE_FACTOR_pct}% cap; 100% below HF ${cf.CLOSE_FACTOR_HF_THRESHOLD}${aaveMedian ? ` · median ${pct(aaveMedian)}` : ''}`,
            }
          : { mark: 'partial', text: 'close factor' },
      morpho:
        doc?.morphoBlue?.hasCloseFactor === false
          ? { mark: 'no', text: `no close factor${morphoMedian ? ` · median ${pct(morphoMedian)}` : ''}` }
          : { mark: 'na', text: 'source pending' },
      membrane: { mark: 'yes', text: 'repays to borrowable LTV' },
      sources: [
        'Aave V3 close factor: protocols.json aaveV3.closeFactor (documented); medians: protocols.json measuredLiquidations (10 Oct 2025, share of loan closed per liquidation)',
        'Morpho Blue: protocols.json morphoBlue.hasCloseFactor = false',
        `Membrane: ${cites(CITES.restoreToB)} (below 100% LTV; at or above it the full debt is repaid)`,
      ],
    },
  ]
  if (carry) {
    rows.push({
      id: 'recall',
      label: 'Deployed debt recalled before any sale',
      aave: { mark: 'na', text: 'no deployment' },
      morpho: { mark: 'na', text: 'no deployment' },
      membrane: { mark: 'yes', text: 'recall, then sale' },
      sources: [`Membrane: ${cites(CARRY_CITES.recallStep, CARRY_CITES.recallCall, CARRY_CITES.recallApply)}`],
    })
  }
  rows.push({
    id: 'nothing',
    label: 'Nothing to set or monitor',
    aave: { mark: 'na', text: 'no window to set' },
    morpho: { mark: 'na', text: 'no window to set' },
    membrane: { mark: 'yes', text: 'any liquidate() call arms it' },
    sources: [`Membrane: ${cites(CITES.permissionlessLiquidate, CITES.timerStart)} — the band is per asset; no opt-in`],
  })
  return rows
}
