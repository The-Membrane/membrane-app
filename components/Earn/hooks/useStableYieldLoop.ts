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
import { shiftDigits } from '@/helpers/math'

const useStableYieldLoop = ( ) => { 
  const { address } = useWallet()
  const { earnState, setEarnState } = useEarnState()
  const usdcAsset = useAssetBySymbol('USDC')


  type QueryData = {
    msgs: MsgExecuteContractEncodeObject[] | undefined
  }
  const { data: queryData } = useQuery<QueryData>({
    queryKey: [
      'earn_enter_msg_creation',
      address,
      earnState.deposit,
      usdcAsset,
    ],
    queryFn: () => {
      if (!address || !usdcAsset ||  earnState.deposit === 0) return { msgs: undefined }
      var msgs = [] as MsgExecuteContractEncodeObject[]

      let messageComposer = new EarnMsgComposer(address, contracts.earn)
      const funds = [{ amount: shiftDigits(earnState.deposit, usdcAsset.decimal).dp(0).toNumber().toString(), denom: usdcAsset.base }]
      let enterMsg = messageComposer.enterVault(funds)
      msgs.push(enterMsg)
      
      return { msgs }
    },
    enabled: !!address,
  })

  const { msgs }: QueryData = useMemo(() => {
    if (!queryData) return { msgs: undefined }
    else return queryData
  }, [queryData])

  console.log("enter msgs:", msgs)

  const onInitialSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['positions'] })
    queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
    setEarnState({ deposit: 0 })
  }

  return {
    action: useSimulateAndBroadcast({
    msgs,
    queryKey: ['earn_page_looped_mars_usdc_enter', (msgs?.toString()??"0")],
    onSuccess: onInitialSuccess,
    enabled: !!msgs,
  })}
}

export default useStableYieldLoop
