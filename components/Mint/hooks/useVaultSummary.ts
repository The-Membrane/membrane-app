import { useBasket, useUserPositions, useCollateralInterest } from '@/hooks/useCDP'
import { useOraclePrice } from '@/hooks/useOracle'
import { calculateVaultSummary } from '@/services/cdp'
import { useMemo } from 'react'
import useMintState from './useMintState'
import useInitialVaultSummary from './useInitialVaultSummary'

const useVaultSummary = () => {
  const { data: basket } = useBasket()
  const { data: collateralInterest } = useCollateralInterest()
  const { data: basketPositions } = useUserPositions()
  const { data: prices } = useOraclePrice()
  const { mintState } = useMintState()
  const { initialBorrowLTV, initialLTV, initialTVL, basketAssets, debtAmount } = useInitialVaultSummary(mintState.positionNumber-1)

  const Basket = useMemo(() => { 
    console.log("basket changed"); return basket
  }, [basket])
  const CollateralInterest = useMemo(() => { console.log("collateralInterest changed"); return collateralInterest }, [collateralInterest])
  const BasketPositions = useMemo(() => { 
    console.log("basketPositions changed"); return basketPositions 
  }, [basketPositions])
  const Prices = useMemo(() => { console.log("prices changed"); return prices }, [prices])
  const Summary = useMemo(() => { console.log("summary changed"); return mintState?.summary }, [mintState?.summary])
  const Mint = useMemo(() => { console.log("mint changed"); return mintState?.mint }, [mintState?.mint])
  const Repay = useMemo(() => { console.log("repay changed"); return mintState?.repay }, [mintState?.repay])
  const PositionNumber = useMemo(() => { console.log("positionNumber changed"); return mintState?.positionNumber }, [mintState?.positionNumber])

  return useMemo(() => {
      //Start: 86
      //High Score (use mintState?.summary for dep): 61
      //Using Memo'd mint state for MintState dep: 68-70


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
      initialBorrowLTV,
      initialLTV,
      debtAmount,
      initialTVL,
      basketAssets,
    })
  }, [
    BasketPositions,
    Basket,
    CollateralInterest,
    Prices,
    Summary,
    Mint,
    Repay,
    PositionNumber,
  ])
}

export default useVaultSummary
