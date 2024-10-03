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

const useEarnLoop = ( ) => {
  const { address } = useWallet()
  const { earnState, setEarnState } = useEarnState()

  const maxMint = useMemo(() => {
    if (earnState.loopMax) return shiftDigits(earnState.loopMax, 6).dp(0).toNumber().toString()
        else return undefined
  }, [earnState.loopMax])


  type QueryData = {
    msgs: MsgExecuteContractEncodeObject[] | undefined
  }
  const { data: queryData } = useQuery<QueryData>({
    queryKey: [
      'earn page management loop msg creation',
      address,
      earnState.loopMax
    ],
    queryFn: () => {
      if (!address) return { msgs: undefined }
      var msgs = [] as MsgExecuteContractEncodeObject[]

      let messageComposer = new EarnMsgComposer(address, contracts.earn)
      let loopMsg = messageComposer.loopCDP({ max_mint_amount: maxMint })
      msgs.push(loopMsg)
      
      return { msgs }
    },
    enabled: !!address,
  })

  const { msgs }: QueryData = useMemo(() => {
    if (!queryData) return { msgs: undefined }
    else return queryData
  }, [queryData])

  console.log("loop msg:", msgs)

  const onInitialSuccess = () => {
    ///ADD A RESET FOR THE VAULT INFO QUERIES//
    //queryClient.invalidateQueries({ queryKey: ['positions'] })
  }

  return {
    action: useSimulateAndBroadcast({
    msgs,
    queryKey: ['earn page management loop', (msgs?.toString()??"0")],
    onSuccess: onInitialSuccess,
    enabled: !!msgs,
  })}
}

export default useEarnLoop
