import { getDepostAndWithdrawMsgs } from '@/helpers/mint'
import { useBasket, useUserPositions } from '@/hooks/useCDP'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import useQuickActionState from './useQuickActionState'
import { queryClient } from '@/pages/_app'
import { useMemo } from 'react'
import { swapToCDTMsg, swapToCollateralMsg } from '@/helpers/osmosis'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useOraclePrice } from '@/hooks/useOracle'
import { loopPosition } from '@/services/osmosis'
import { num } from '@/helpers/num'
import { updatedSummary } from '@/services/cdp'
import { denoms, loopMax } from '@/config/defaults'
import { AssetWithBalance } from '@/components/Mint/hooks/useCombinBalance'
import { setCookie } from '@/helpers/cookies'
import { shiftDigits } from '@/helpers/math'

const useSwapToCDT = ({ onSuccess, run }: { onSuccess: () => void, run: boolean }) => {
  const { quickActionState } = useQuickActionState()

  const { address } = useWallet()
  const { data: basket } = useBasket()
  const { data: prices } = useOraclePrice()
  const usdcAsset = useAssetBySymbol('USDC')



  type QueryData = {
    msgs: MsgExecuteContractEncodeObject[] | undefined
  }
  const { data: queryData } = useQuery<QueryData>({
    queryKey: [
      'home_page_swap',
      address,
      quickActionState?.usdcSwapToCDT,
      prices,
      usdcAsset,
      run
    ],
    queryFn: () => {
      if (!address || !basket || !prices || !usdcAsset || quickActionState?.usdcSwapToCDT === 0 || !run) return { msgs: [] }
      var msgs = [] as MsgExecuteContractEncodeObject[]
      const cdtPrice = parseFloat(prices?.find((price) => price.denom === denoms.CDT[0])?.price ?? "0")

      //1) Swap USDC to CDT
      const { msg: swap, tokenOutMinAmount, foundToken } = swapToCDTMsg({
        address,
        swapFromAmount: shiftDigits(quickActionState?.usdcSwapToCDT, 6).toFixed(0),
        swapFromAsset: usdcAsset,
        prices,
        cdtPrice,
        tokenOut: 'CDT'
      })
      msgs.push(swap as MsgExecuteContractEncodeObject)

      return { msgs }

    },
    enabled: !!address,
  })

  const msgs = queryData?.msgs ?? []

  console.log("swap to cdt msgs", msgs)

  const onInitialSuccess = () => {
    onSuccess()
    queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
  }

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['home_page_swap_sim', (msgs?.toString() ?? "0")],
      onSuccess: onInitialSuccess,
    })
  }
}

export default useSwapToCDT
