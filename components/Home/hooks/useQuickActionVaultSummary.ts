import { useMemo } from 'react'

/**
 * Projected vault summary (debt / cost / TVL / LTV) for the leverage quick action.
 *
 * TODO(evm-migration): this composed `calculateVaultSummary` (services/cdp.ts) over the
 * CosmWasm Basket + denom-keyed oracle prices + the `levAssets` deposit draft. All of those
 * inputs are gone on EVM: `useBasket` and `useOraclePrice` are stubbed in the migrated data
 * layer, `calculateVaultSummary` is a CosmWasm-shape transform, and `levAssets` was removed
 * from QuickActionState. Returns a zeroed summary until an EVM basket/collateral view and an
 * EVM-shape vault-summary calculator exist.
 */
const useQuickActionVaultSummary = () => {
  return useMemo(
    () => ({
      debtAmount: 0,
      cost: 0,
      tvl: 0,
      ltv: 0,
      borrowLTV: 0,
      liquidValue: 0,
      liqudationLTV: 0,
    }),
    [],
  )
}

export default useQuickActionVaultSummary
