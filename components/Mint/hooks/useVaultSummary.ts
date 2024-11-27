import { useBasket, useUserPositions, useCollateralInterest, useUserDiscount } from '@/hooks/useCDP'
import { useOraclePrice } from '@/hooks/useOracle'
import { calculateVaultSummary } from '@/services/cdp'
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import useMintState from './useMintState'
import useInitialVaultSummary from './useInitialVaultSummary'
import useWallet from '@/hooks/useWallet'

const useVaultSummary = () => {
  const { address } = useWallet()
  const { data: basket } = useBasket()
  const { data: collateralInterest } = useCollateralInterest()
  const { data: basketPositions } = useUserPositions()
  const { data: prices } = useOraclePrice()
  const { data: discount } = useUserDiscount(address)
  const { mintState } = useMintState()
  const { data } = useInitialVaultSummary(mintState.positionNumber-1)

  return useQuery({
    queryKey: [
      'vault-summary', 
      address, 
      mintState.positionNumber, 
      mintState.mint, 
      mintState.repay
    ],
    queryFn: async () => {
      if (!data) return null;

      return calculateVaultSummary({
        basket,
        collateralInterest,
        basketPositions,
        positionIndex: mintState.positionNumber-1,
        prices,
        newDeposit: mintState?.totalUsdValue || 0,
        summary: mintState?.summary,
        mint: mintState?.mint,
        repay: mintState?.repay,
        newDebtAmount: mintState?.newDebtAmount,
        initialBorrowLTV: data.initialBorrowLTV,
        initialLTV: data.initialLTV,
        debtAmount: data.debtAmount,
        initialTVL: data.initialTVL,
        basketAssets: data.basketAssets,
        discount: discount?.discount ?? "0",
      })
    },
    // Consider adding these options
    staleTime: 5000, // Keep data fresh for 5 seconds
    refetchOnWindowFocus: false,
    refetchOnReconnect: false
  })
}

export default useVaultSummary
