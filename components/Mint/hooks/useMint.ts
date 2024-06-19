import { getDepostAndWithdrawMsgs, getMintAndRepayMsgs } from '@/helpers/mint'
import { useBasket, useUserPositions } from '@/hooks/useCDP'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import useMintState from './useMintState'
import { queryClient } from '@/pages/_app'

const useMint = () => {
  const { mintState } = useMintState()
  const { summary = [] } = mintState
  const { address } = useWallet()
  const { data: basketPositions, ...basketErrors } = useUserPositions()
  const { data: basket } = useBasket()

  //Use the current position id or use the basket's next position ID (for new positions)
  var positionId = "";
  if (basketPositions !== undefined && mintState.positionNumber < basketPositions.length ) {
    positionId = basketPositions?.[0]?.positions?.[mintState.positionNumber-1]?.position_id
  } else {
    //Use the next position ID
    positionId = basket?.current_position_id ?? ""    
  }

  const { data: msgs } = useQuery<MsgExecuteContractEncodeObject[] | undefined>({
    queryKey: [
      'mint',
      address,
      positionId,
      summary?.map((s: any) => String(s.amount)) || '0',
      mintState?.mint,
      mintState?.repay,
    ],
    queryFn: () => {
      if (!address) return
      const depositAndWithdraw = getDepostAndWithdrawMsgs({ summary, address, positionId, hasPosition: basketPositions !== undefined })
      const mintAndRepay = getMintAndRepayMsgs({
        address,
        positionId,
        mintAmount: mintState?.mint,
        repayAmount: mintState?.repay,
      })
      return [...depositAndWithdraw, ...mintAndRepay] as MsgExecuteContractEncodeObject[]
    },
    enabled: !!address && !mintState.overdraft,
  })

  const onSuccess = () => {    
    queryClient.invalidateQueries({ queryKey: ['positions'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
  }

  return useSimulateAndBroadcast({
    msgs,
    queryKey: [
      String(mintState?.mint) || '0',
      String(mintState?.repay) || '0',
      ...summary?.map((s: any) => String(s.amount)),
    ],
    onSuccess,
  })
}

export default useMint
