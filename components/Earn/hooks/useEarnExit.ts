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

const useEarnExit = ( ) => {
  const { address } = useWallet()
  const { earnState, setEarnState } = useEarnState()
  const loopedUSDCAsset = useAssetBySymbol('loopedUSDCmars')

  
  type QueryData = {
    msgs: MsgExecuteContractEncodeObject[] | undefined
  }
  const { data: queryData } = useQuery<QueryData>({
    queryKey: [
      'earn_exit_msg_creation',
      address,
      earnState.withdraw,
      loopedUSDCAsset,
    ],
    queryFn: () => {
      if (!address || !loopedUSDCAsset ||  earnState.withdraw === 0) return { msgs: undefined }

      var msgs = [] as MsgExecuteContractEncodeObject[]
      // console.log("earn state withdraw", earnState.withdraw)
      let messageComposer = new EarnMsgComposer(address, contracts.earn)
      const funds = [{ amount: earnState.withdraw.toString(), denom: loopedUSDCAsset.base }]
      let exitMsg = messageComposer.exitVault(funds)
      msgs.push(exitMsg)

      console.log("exit msg:", msgs)
      
      return { msgs }
    },
    enabled: !!address,
  })

  const { msgs }: QueryData = useMemo(() => {
    if (!queryData) return { msgs: undefined }
    else return queryData
  }, [queryData])

  const onInitialSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['positions'] })
    queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
    setEarnState({ withdraw: 0 })
  }

  console.log("here to return action ")
  return  {
    action: useSimulateAndBroadcast({
    msgs,
    queryKey: ['earn_page_mars_usdc_looped_vault_exit', (msgs?.toString()??"0")],
    onSuccess: onInitialSuccess,
    enabled: !!msgs,
  })}
}

export default useEarnExit
