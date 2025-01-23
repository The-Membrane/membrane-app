import { useBasket, useUserPositions, useCollateralInterest, useUserDiscount } from '@/hooks/useCDP'
import { useOraclePrice } from '@/hooks/useOracle'
import { calculateVaultSummary } from '@/services/cdp'
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import useMintState from './useMintState'
import useInitialVaultSummary from './useInitialVaultSummary'
import useWallet from '@/hooks/useWallet'

// This hook is used to calculate the vault summary
export const useVaultSummary = ({ positionNumber }: { positionNumber?: number } = {}) => {
  const { address } = useWallet()
  const { data: basket } = useBasket()
  const { data: collateralInterest } = useCollateralInterest()
  const { data: basketPositions } = useUserPositions()
  const { data: prices } = useOraclePrice()
  const { data: discount } = useUserDiscount(address)
  const { mintState } = useMintState()

  const positionNum = positionNumber ?? mintState.positionNumber
  const { data: vaultSummary } = useInitialVaultSummary(positionNum - 1)

  const {
    initialBorrowLTV = 0,
    initialLTV = 0,
    initialTVL = 0,
    basketAssets = [],
    debtAmount = 0
  } = vaultSummary ?? {}

  return useQuery({
    queryKey: [
      'vault summary',
      basketPositions,
      basket,
      collateralInterest,
      prices,
      mintState?.summary,
      vaultSummary,
      mintState.mint,
      mintState.repay,
      positionNum,
      mintState.newDebtAmount,
      discount
    ],
    queryFn: () => calculateVaultSummary({
      basket,
      collateralInterest,
      basketPositions,
      positionIndex: positionNum - 1,
      prices,
      newDeposit: mintState?.totalUsdValue ?? 0,
      summary: mintState?.summary,
      mint: mintState?.mint,
      repay: mintState?.repay,
      newDebtAmount: mintState?.newDebtAmount,
      initialBorrowLTV,
      initialLTV,
      debtAmount,
      initialTVL,
      basketAssets,
      discount: discount?.discount ?? "0"
    })
  })
}

export default useVaultSummary
