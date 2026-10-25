/**
 * THE MANUAL POSITION (framework: "fallback manual position (collateral, debt, LTV)"),
 * for a reader who will not paste a wallet.
 *
 * The reader gives: the collateral asset, its dollar value, the debt in dollars, the
 * venue, and the venue's liquidation line. The rest is read, never assumed:
 *   - Aave V3: liquidation threshold and bonus per asset from protocols.json
 *     aaveV3.reserves (read on-chain at block 23,543,615). The line defaults to it.
 *   - Morpho Blue: the LLTV is the reader's pick among the LLTVs real markets for that
 *     collateral use (protocols.json morphoBlue.markets), and the bonus is Morpho's own
 *     LIF formula on the documented constants (protocols.json morphoBlue.liquidationIncentive).
 * Token amounts are the dollars over the scenario's price at its first minute, so the
 * replay opens on the reader's numbers. The position is labelled "entered by hand".
 */

import { stamp, type ProtocolPosition } from '@/lib/position-sim'

export type ManualVenue = 'aave-v3' | 'morpho-blue'

export const MANUAL_COLLATERAL = ['WETH', 'wstETH', 'WBTC', 'cbBTC', 'USDe'] as const
export type ManualCollateral = (typeof MANUAL_COLLATERAL)[number]

export interface ManualInput {
  venue: ManualVenue
  collateral: ManualCollateral
  collateralUsd: number
  debtUsd: number
  /** The venue's liquidation line, 0–1. */
  liquidationLtv: number
}

export interface ProtocolsDoc {
  aaveV3?: { reserves?: Record<string, { liquidationThresholdPct?: number; liquidationBonusPct?: number; ltvPct?: number }> }
  morphoBlue?: {
    liquidationIncentive?: { MAX_LIQUIDATION_INCENTIVE_FACTOR?: number; LIQUIDATION_CURSOR?: number }
    markets?: Record<string, { collateralSymbol?: string; loanSymbol?: string; lltvPct?: number }>
  }
}

/** Aave's line for an asset, 0–1, or null if the reserve was not read. */
export function aaveLine(doc: ProtocolsDoc | null, symbol: string): number | null {
  const r = doc?.aaveV3?.reserves?.[symbol]
  return r?.liquidationThresholdPct ? r.liquidationThresholdPct / 100 : null
}

/** LLTVs real Morpho markets use for this collateral, against a USD stable, sorted. */
export function morphoLltvs(doc: ProtocolsDoc | null, symbol: string): number[] {
  const stables = new Set(['USDC', 'USDT', 'DAI', 'USDS', 'GHO', 'PYUSD', 'USDtb'])
  const out = new Set<number>()
  for (const m of Object.values(doc?.morphoBlue?.markets ?? {})) {
    if (m.collateralSymbol === symbol && m.loanSymbol && stables.has(m.loanSymbol) && m.lltvPct) out.add(m.lltvPct / 100)
  }
  return Array.from(out).sort((a, b) => a - b)
}

/** Morpho LIF = min(MAX, 1 / (1 − cursor × (1 − lltv))). Bonus = LIF − 1. */
export function morphoBonus(doc: ProtocolsDoc | null, lltv: number): number | null {
  const c = doc?.morphoBlue?.liquidationIncentive
  if (!c?.MAX_LIQUIDATION_INCENTIVE_FACTOR || c.LIQUIDATION_CURSOR === undefined) return null
  const lif = Math.min(c.MAX_LIQUIDATION_INCENTIVE_FACTOR, 1 / (1 - c.LIQUIDATION_CURSOR * (1 - lltv)))
  return lif - 1
}

export function aaveBonus(doc: ProtocolsDoc | null, symbol: string): number | null {
  const r = doc?.aaveV3?.reserves?.[symbol]
  return r?.liquidationBonusPct ? r.liquidationBonusPct / 100 - 1 : null
}

export type ManualError = 'collateral' | 'debt' | 'line' | 'price' | 'underwater' | 'reserve'

export function validateManual(i: ManualInput): ManualError | null {
  if (!(i.collateralUsd > 0)) return 'collateral'
  if (!(i.debtUsd > 0)) return 'debt'
  if (!(i.liquidationLtv > 0 && i.liquidationLtv < 1)) return 'line'
  if (i.debtUsd / i.collateralUsd >= i.liquidationLtv) return 'underwater'
  return null
}

export const MANUAL_ERROR_TEXT: Record<ManualError, string> = {
  collateral: 'Enter collateral above $0.',
  debt: 'Enter debt above $0.',
  line: 'Enter a liquidation LTV between 0 and 100.',
  price: 'No price for this asset in this scenario.',
  underwater: 'Debt is over the line. Lower it.',
  reserve: 'No Aave reserve for this asset. Use Morpho Blue.',
}

/** Builds the position, or an error. `startPrice` is the scenario's minute-0 price. */
export function buildManualPosition(
  i: ManualInput,
  doc: ProtocolsDoc | null,
  startPrice: number | null,
): { position: ProtocolPosition } | { error: ManualError } {
  const err = validateManual(i)
  if (err) return { error: err }
  if (!startPrice || !(startPrice > 0)) return { error: 'price' }
  const bonus = i.venue === 'aave-v3' ? aaveBonus(doc, i.collateral) : morphoBonus(doc, i.liquidationLtv)
  // Never a silent 0% bonus: a venue with no parameters for the asset is refused.
  if (bonus === null) return { error: i.venue === 'aave-v3' ? 'reserve' : 'price' }
  const amount = i.collateralUsd / startPrice
  const ltv = i.debtUsd / i.collateralUsd
  const label = i.venue === 'aave-v3' ? 'Aave V3' : `Morpho Blue · ${i.collateral}/USDC ${(i.liquidationLtv * 100).toFixed(1)}%`
  return {
    position: {
      protocol: i.venue,
      label,
      collateral: [
        {
          symbol: i.collateral,
          address: '',
          decimals: 18,
          amount,
          priceUsd: startPrice,
          valueUsd: i.collateralUsd,
          liquidationThreshold: i.liquidationLtv,
          maxLtv: i.liquidationLtv,
          liquidationBonus: bonus,
        },
      ],
      debt: [{ symbol: 'USDC', address: '', decimals: 6, amount: i.debtUsd, priceUsd: 1, valueUsd: i.debtUsd, borrowApr: null }],
      totalCollateralUsd: i.collateralUsd,
      totalDebtUsd: i.debtUsd,
      ltv,
      liquidationLtv: i.liquidationLtv,
      healthFactor: ltv > 0 ? i.liquidationLtv / ltv : Infinity,
      provenance: stamp(
        'modelled',
        'entered by hand · priced at the scenario start',
        `Collateral and debt are the reader's inputs. ${i.venue === 'aave-v3' ? 'Liquidation bonus read from protocols.json aaveV3.reserves.' : "Liquidation bonus from Morpho's LIF formula on the documented constants."}`,
      ),
    },
  }
}

/** Compact URL form, so a manual replay reproduces from its link: venue:asset:coll:debt:line. */
export function encodeManual(i: ManualInput): string {
  return [i.venue, i.collateral, Math.round(i.collateralUsd), Math.round(i.debtUsd), i.liquidationLtv.toFixed(4)].join(':')
}

export function decodeManual(raw: string | string[] | undefined | null): ManualInput | null {
  const s = Array.isArray(raw) ? raw[0] : raw
  if (!s) return null
  const [venue, collateral, c, d, l] = s.split(':')
  if (venue !== 'aave-v3' && venue !== 'morpho-blue') return null
  if (!(MANUAL_COLLATERAL as readonly string[]).includes(collateral)) return null
  const i: ManualInput = {
    venue,
    collateral: collateral as ManualCollateral,
    collateralUsd: Number(c),
    debtUsd: Number(d),
    liquidationLtv: Number(l),
  }
  return validateManual(i) ? null : i
}
