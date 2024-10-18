import { getDepostAndWithdrawMsgs } from '@/helpers/mint'
import { useBasket, useUserPositions } from '@/hooks/useCDP'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import { queryClient } from '@/pages/_app'
import { useMemo } from 'react'

import contracts from '@/config/contracts.json'
import { EarnMsgComposer } from '@/contracts/codegen/earn/Earn.message-composer'
import { useAssetBySymbol } from '@/hooks/useAssets'
import useEarnState from './useEarnState'
import { useBalanceByAsset } from '@/hooks/useBalance'
import { useUSDCVaultTokenUnderlying } from './useEarnQueries'
import { shiftDigits } from '@/helpers/math'
import { num } from '@/helpers/num'

const useEarnExit = ( ) => {
  const { address } = useWallet()
  const { earnState, setEarnState } = useEarnState()
  const earnUSDCAsset = useAssetBySymbol('earnUSDC')
  const earnUSDCBalance = useBalanceByAsset(earnUSDCAsset)

  const { data } = useUSDCVaultTokenUnderlying(shiftDigits(earnUSDCBalance, 6).toFixed(0))
  const underlyingUSDC = data ?? "1"
  
  type QueryData = {
    msgs: MsgExecuteContractEncodeObject[]
  }
  const { data: queryData } = useQuery<QueryData>({
    queryKey: [
      'earn_exit_msg_creation',
      address,
      earnState.withdraw,
      earnUSDCAsset,
      underlyingUSDC,
      earnUSDCBalance
    ],
    queryFn: () => {
      console.log("earn exit", 
        address,
        earnState.withdraw,
        earnUSDCAsset)
      if (!address || !earnUSDCAsset || earnState.withdraw === 0 || underlyingUSDC === "0"|| earnUSDCBalance === "0") return { msgs: [] }

      const usdcWithdrawAmount = shiftDigits(earnState.withdraw, 6).toNumber()
      //find percent of underlying usdc to withdraw
      const percentToWithdraw = num(usdcWithdrawAmount).div(underlyingUSDC).toNumber()
      //Calc VT to withdraw using the percent
      const withdrawAmount = num(shiftDigits(earnUSDCBalance, 6).toFixed(0)).times(percentToWithdraw).dp(0).toNumber()

      console.log("withdrawAmount", withdrawAmount, usdcWithdrawAmount, percentToWithdraw)


      var msgs = [] as MsgExecuteContractEncodeObject[]
      let messageComposer = new EarnMsgComposer(address, contracts.earn)
      const funds = [{ amount: withdrawAmount.toString(), denom: earnUSDCAsset.base }]
      let exitMsg = messageComposer.exitVault(funds)
      msgs.push(exitMsg)

      console.log("exit msg:", msgs)
      
      return { msgs }
    },
    enabled: !!address,
  })

  const  msgs = queryData?.msgs ?? []

  const onInitialSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['positions'] })
    queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
    setEarnState({ withdraw: 0 })
  }

  console.log("here to return action ")
  
  return  {
    action: useSimulateAndBroadcast({
    msgs: [],
    queryKey: ['earn_page_mars_usdc_looped_vault_exit', (msgs?.toString()??"0")],
    onSuccess: onInitialSuccess,
    enabled: !!msgs?.length,
  })}
}

export default useEarnExit
