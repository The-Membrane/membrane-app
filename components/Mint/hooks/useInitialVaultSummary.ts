import { useQuery } from '@tanstack/react-query'
import { useChainRoute } from '@/hooks/useChainRoute'

/**
 * Initial (pre-input) vault summary — EVM migration.
 *
 * TODO(evm-migration): getPositions / getDebt / getTVL / getBorrowLTV / getLTV (services/cdp)
 * are CosmWasm-shape transforms that need the basket aggregate (per-asset LTVs) and the
 * basketAssets roster — both documented stubs on EVM (getBasket → null, getBasketAssets → []
 * in services/chain/cdp.ts / hooks/useCDP). useUserPositions now returns the flat
 * EvmUserPosition[] shape those transforms cannot consume. We return honest zero defaults
 * rather than inventing collateral value / LTV figures; re-wire once a Collateral service
 * backs the basket roster and per-asset LTVs.
 */
const useInitialVaultSummary = (positionIndex: number = 0) => {
  const { chainName } = useChainRoute()

  return useQuery({
    queryKey: ['initial vault summary', 'evm', chainName, String(positionIndex)],
    queryFn: async () => ({
      initialBorrowLTV: 0,
      initialLTV: 0,
      debtAmount: 0,
      initialTVL: 0,
      basketAssets: [] as any[],
    }),
  })
}

export default useInitialVaultSummary
