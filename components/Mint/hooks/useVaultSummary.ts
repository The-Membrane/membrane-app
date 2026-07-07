import { useQuery } from '@tanstack/react-query'
import useMintState from './useMintState'
import useInitialVaultSummary from './useInitialVaultSummary'
import { useChainRoute } from '@/hooks/useChainRoute'

/**
 * Vault summary — EVM migration.
 *
 * TODO(evm-migration): a faithful vault summary needs the basket aggregate — per-asset
 * max_LTV / max_borrow_LTV / liquidation LTV plus the credit price — which Cdp.sol does not
 * expose. getBasket / getBasketAssets are documented stubs in services/chain/cdp.ts (per-asset
 * LTVs live in the Collateral contract, outside the CDP ABI), so calculateVaultSummary (which
 * requires the full CosmWasm Basket) cannot run. We return honest defaults — the same
 * zero-shape calculateVaultSummary yields when it has no basket — rather than inventing
 * LTV / liquidation math. debtAmount / TVL fall through from useInitialVaultSummary (also
 * honest defaults today). Re-wire onto a Collateral service when one exists.
 */
export const useVaultSummary = ({ positionNumber }: { positionNumber?: number } = {}) => {
  const { mintState } = useMintState()
  const { chainName } = useChainRoute()

  const positionNum = positionNumber ?? mintState.positionNumber
  const { data: vaultSummary } = useInitialVaultSummary(positionNum - 1)

  const {
    initialBorrowLTV = 0,
    initialLTV = 0,
    initialTVL = 0,
    debtAmount = 0,
  } = vaultSummary ?? {}

  return useQuery({
    queryKey: [
      'vault summary',
      'evm',
      chainName,
      String(positionNum),
      String(mintState.mint),
      String(mintState.repay),
      String(mintState.newDebtAmount),
      String(debtAmount),
      String(initialTVL),
    ],
    queryFn: () => ({
      newDebtAmount: mintState?.newDebtAmount ?? 0,
      debtAmount,
      cost: 0,
      discountedCost: 0,
      costRatios: [] as number[],
      tvl: initialTVL,
      ltv: initialLTV,
      borrowLTV: initialBorrowLTV,
      maxMint: 0,
      liquidValue: 0,
      liqudationLTV: 0,
      initialLTV,
      initialTVL,
      initialBorrowLTV,
      remainingMintAmount: 0,
      positionId: '0',
    }),
    enabled: true,
  })
}

export default useVaultSummary
