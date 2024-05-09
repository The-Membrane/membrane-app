import { getDepostAndWithdrawMsgs, getMintAndRepayMsgs } from '@/helpers/mint'
import { useBasket, useUserPositions } from '@/hooks/useCDP'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import useQuickActionState from './useQuickActionState'
import { queryClient } from '@/pages/_app'
import { useEffect } from 'react'

const useQuickAction = () => {
  const { quickActionState } = useQuickActionState()
  const { summary = [] } = quickActionState
  const { address } = useWallet()
  const { data: basketPositions, ...basketErrors } = useUserPositions()
  const { data: basket } = useBasket()

  /////First we'll do new positions only, but these actions will be usable by all positions & multiple per user in the future//////

  //Use first position id or use the basket's next position ID (for new positions)
  var positionId = "";
//   if (basketPositions !== undefined) {
//     positionId = basketPositions?.[0]?.positions?.[0]?.position_id
//   } else {
    //Use the next position ID
    useEffect(() => {positionId = basket?.current_position_id ?? ""}, [basket])
//   }

  const { data: msgs } = useQuery<MsgExecuteContractEncodeObject[] | undefined>({
    queryKey: [
      'mint',
      address,
      positionId,
      summary?.map((s: any) => String(s.amount)) || '0',
      quickActionState?.mint,
    ],
    queryFn: () => {
      if (!address) return
      const deposit = getDepostAndWithdrawMsgs({ summary, address, positionId, hasPosition: basketPositions !== undefined })
      const mint = getMintAndRepayMsgs({
        address,
        positionId,
        mintAmount: quickActionState?.mint,
        repayAmount: 0,
      })
      return [...deposit, ...mint] as MsgExecuteContractEncodeObject[]
    },
    enabled: !!address && !!summary && !!quickActionState?.mint && !!positionId,
  })

  const onSuccess = () => {    
    queryClient.invalidateQueries({ queryKey: ['positions'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
  }

  return useSimulateAndBroadcast({
    msgs,
    queryKey: [
      String(quickActionState?.mint) || '0',
      ...summary?.map((s: any) => String(s.amount)),
    ],
    onSuccess,
  })
}

export default useQuickAction
