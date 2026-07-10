import { useQuery } from '@tanstack/react-query'
import { cdpAbi } from '@/contracts/abis/cdp'
import { getPublicClient } from '@/services/chain/client'
import { getContractAddress } from '@/config/evm/contracts'
import { getCreditMinted } from '@/services/chain/cdp'
import { shiftDigits } from '@/helpers/math'
import { num } from '@/helpers/num'

/**
 * Fixed-rate aggregate cap view — EVM migration.
 *
 * Reads Cdp.sol `fixedRateCapsView()` (contracts/abis/cdp.ts) + the basket-wide
 * `creditMinted` principal counter to reproduce the on-chain gate in
 * CdpFixedRate.fixedRateAggregateCapHolds: the combined fixed-rate debt (regular + peg,
 * across 1m/3m/6m) must stay at or under `totalCap` (20%, 1e18-scaled) of the basket's
 * total debt AFTER the borrow. Exceeding it reverts `FixedRateCapExceeded()`.
 *
 * Multipliers (1.1e18 / 1.3e18 / 1.7e18) are read from the same view so displayed fixed
 * rates = multiplier × variable rate track the deployed values rather than UI constants.
 *
 * All *amounts* are CDT base units (18 dp by default); *fractions* (totalCap, multiplier)
 * are DECIMAL_FRACTIONAL 1e18-scaled.
 */

const DECIMAL_FRACTIONAL = 1e18

// Fallbacks mirror CdpFixedRate defaults if the view can't be read.
const FALLBACK_MULTIPLIERS = { oneMonth: 1.1, threeMonth: 1.3, sixMonth: 1.7 }
const FALLBACK_TOTAL_CAP_FRACTION = 0.2

export interface FixedRateCapsData {
  /** Aggregate ceiling as a fraction of total basket debt (e.g. 0.2 = 20%). */
  totalCapFraction: number
  /** Current basket-wide fixed-rate debt (regular + peg, all durations), human CDT. */
  existingFixedAmount: number
  /** Basket-wide total minted debt (creditMinted), human CDT. */
  totalDebt: number
  /** On-chain bucket multipliers (fraction, e.g. 1.1). */
  multipliers: { oneMonth: number; threeMonth: number; sixMonth: number }
}

type RawCap = { cap: bigint; amount: bigint; multiplier: bigint }
type RawCaps = {
  totalCap: bigint
  oneMonth: RawCap
  threeMonth: RawCap
  sixMonth: RawCap
}

const CDT_DECIMALS = 18

export const useFixedRateCaps = () => {
  return useQuery<FixedRateCapsData>({
    queryKey: ['fixed_rate_caps', 'evm'],
    staleTime: 1000 * 60 * 5,
    queryFn: async (): Promise<FixedRateCapsData> => {
      const client = getPublicClient()
      const cdpAddr = client.chain ? getContractAddress(client.chain.id, 'cdp') : undefined

      const fallback: FixedRateCapsData = {
        totalCapFraction: FALLBACK_TOTAL_CAP_FRACTION,
        existingFixedAmount: 0,
        totalDebt: 0,
        multipliers: FALLBACK_MULTIPLIERS,
      }

      if (!cdpAddr) return fallback

      try {
        const [caps, creditMinted] = await Promise.all([
          client.readContract({
            address: cdpAddr,
            abi: cdpAbi,
            functionName: 'fixedRateCapsView',
          }) as Promise<RawCaps>,
          getCreditMinted(client, cdpAddr) as Promise<bigint | null>,
        ])

        const toFraction = (v: bigint) => num(v.toString()).dividedBy(DECIMAL_FRACTIONAL).toNumber()
        const toHuman = (v: bigint) => shiftDigits(v.toString(), -CDT_DECIMALS).toNumber()

        const existingFixedAmount =
          toHuman(caps.oneMonth.amount) +
          toHuman(caps.threeMonth.amount) +
          toHuman(caps.sixMonth.amount)

        return {
          totalCapFraction: toFraction(caps.totalCap),
          existingFixedAmount,
          totalDebt: creditMinted != null ? toHuman(creditMinted) : 0,
          multipliers: {
            oneMonth: toFraction(caps.oneMonth.multiplier) || FALLBACK_MULTIPLIERS.oneMonth,
            threeMonth: toFraction(caps.threeMonth.multiplier) || FALLBACK_MULTIPLIERS.threeMonth,
            sixMonth: toFraction(caps.sixMonth.multiplier) || FALLBACK_MULTIPLIERS.sixMonth,
          },
        }
      } catch (error) {
        console.error('Error querying CDP fixedRateCapsView:', error)
        return fallback
      }
    },
  })
}

/**
 * Max additional fixed-rate borrow (human CDT) that still satisfies
 * `(existing + x) ≤ totalCap × (totalDebt + x)`.
 * Solving for x: x ≤ (totalCap·D − E) / (1 − totalCap). Clamped to ≥ 0.
 */
export const remainingFixedCapacity = (caps?: FixedRateCapsData): number => {
  if (!caps) return Infinity
  const { totalCapFraction: tc, totalDebt: D, existingFixedAmount: E } = caps
  if (tc <= 0) return Infinity // cap disabled on-chain
  if (tc >= 1) return Math.max(0, tc * D - E)
  const x = (tc * D - E) / (1 - tc)
  return Math.max(0, x)
}
