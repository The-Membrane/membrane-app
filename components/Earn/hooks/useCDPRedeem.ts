import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

import contracts from '@/config/contracts.json'
import useEarnState from './useEarnState'
import { shiftDigits } from '@/helpers/math'
import { PositionsMsgComposer } from '@/contracts/codegen/positions/Positions.message-composer'
import { denoms } from '@/config/defaults'

const useCDPRedeem = ( ) => {
  const { address } = useWallet()
  const { earnState, setEarnState } = useEarnState()

//   const maxMint = useMemo(() => {
//     if (earnState.loopMax) return shiftDigits(earnState.loopMax, 6).dp(0).toNumber().toString()
//         else return undefined
//   }, [earnState.loopMax])


  type QueryData = {
    msgs: MsgExecuteContractEncodeObject[] | undefined
  }
  const { data: queryData } = useQuery<QueryData>({
    queryKey: [
      'earn page management redeem msg creation',
      address,
      earnState.redeemAmount
    ],
    queryFn: () => {
      if (!address || !earnState.redeemAmount) return { msgs: undefined }
      var msgs = [] as MsgExecuteContractEncodeObject[]

      let messageComposer = new PositionsMsgComposer(address, contracts.cdp)
      const funds = [{ amount: shiftDigits(earnState.redeemAmount, 6).dp(0).toNumber().toString(), denom: denoms.CDT[0].toString() }]
      let redeemMsg = messageComposer.redeemCollateral({ maxCollateralPremium: 1 }, funds)
      msgs.push(redeemMsg)
      
      return { msgs }
    },
    enabled: !!address,
  })

  const { msgs }: QueryData = useMemo(() => {
    if (!queryData) return { msgs: undefined }
    else return queryData
  }, [queryData])

  console.log("redeem msg:", msgs)

  const onInitialSuccess = () => {
    ///ADD A RESET FOR THE VAULT INFO QUERIES//
    //queryClient.invalidateQueries({ queryKey: ['positions'] })
  }

  return {
    action: useSimulateAndBroadcast({
    msgs,
    queryKey: ['earn page management redeem', (msgs?.toString()??"0")],
    onSuccess: onInitialSuccess,
    enabled: !!msgs,
  })}
}

export default useCDPRedeem
