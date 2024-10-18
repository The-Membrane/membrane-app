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

const useEarn = ( ) => {
  const { address } = useWallet()
  const { earnState, setEarnState } = useEarnState()
  const usdcAsset = useAssetBySymbol('USDC')
  const earnUSDCAsset = useAssetBySymbol('earnUSDC')
  const earnUSDCBalance = useBalanceByAsset(earnUSDCAsset)

  const { data } = useUSDCVaultTokenUnderlying(shiftDigits(earnUSDCBalance, 6).toFixed(0))
  const underlyingUSDC = data ?? "1"
  
  type QueryData = {
    msgs: MsgExecuteContractEncodeObject[]
  }
  const { data: queryData } = useQuery<QueryData>({
    queryKey: [
      'earn_msgs_creation',
      address,
      earnState.withdraw,
      earnState.deposit,
      usdcAsset,
      earnUSDCAsset,
      underlyingUSDC,
      earnUSDCBalance
    ],
    queryFn: () => {
        if (!address || !earnUSDCAsset || !usdcAsset) {console.log("earn exit early return", address, earnUSDCAsset, earnState.withdraw, underlyingUSDC, earnUSDCBalance); return { msgs: [] }}
        var msgs = [] as MsgExecuteContractEncodeObject[]
        let messageComposer = new EarnMsgComposer(address, contracts.earn)

        if (earnState.withdraw != 0){

          const usdcWithdrawAmount = shiftDigits(earnState.withdraw, 6).toNumber()
          // find percent of underlying usdc to withdraw
          const percentToWithdraw = num(usdcWithdrawAmount).div(underlyingUSDC).toNumber()
  
          // Calc VT to withdraw using the percent
          const withdrawAmount = num(shiftDigits(earnUSDCBalance, 6).toFixed(0)).times(percentToWithdraw).dp(0).toNumber()
          // const withdrawAmount = shiftDigits(earnUSDCBalance, 6).toFixed(0);
    
          // console.log("withdrawAmount", withdrawAmount, usdcWithdrawAmount, percentToWithdraw)
    
          const funds = [{ amount: withdrawAmount.toString(), denom: earnUSDCAsset.base }]
          let exitMsg = messageComposer.exitVault(funds)
          msgs.push(exitMsg)
        }

        if (earnState.deposit != 0){          
          const funds = [{ amount: shiftDigits(earnState.deposit, usdcAsset.decimal).dp(0).toNumber().toString(), denom: usdcAsset.base }]
          let enterMsg = messageComposer.enterVault(funds)
          msgs.push(enterMsg)
        }

      console.log("earn msgs:", msgs)
      
      return { msgs }
    },
    enabled: !!address,
  })

  const  msgs = queryData?.msgs ?? []

  const onInitialSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['positions'] })
    queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
    setEarnState({ withdraw: 0, deposit: 0 })
  }

  console.log("here to return action ")
  
  return  {
    action: useSimulateAndBroadcast({
    msgs,
    queryKey: ['earn_page_mars_usdc_looped_vault', (msgs?.toString()??"0")],
    onSuccess: onInitialSuccess,
    enabled: !!msgs?.length,
  })}
}

export default useEarn
