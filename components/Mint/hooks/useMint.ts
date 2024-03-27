import { getDepostAndWithdrawMsgs, getMintAndRepayMsgs } from '@/helpers/mint'
import { useBasketPositions } from '@/hooks/useCDP'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import useMintState from './useMintState'

const useMint = () => {
  const { mintState } = useMintState()
  const { summary = [] } = mintState
  const { address } = useWallet()
  const { data: basketPositions } = useBasketPositions()
  const positionId = basketPositions?.[0]?.positions?.[0]?.position_id

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
      if (!address || !positionId) return
      const depositAndWithdraw = getDepostAndWithdrawMsgs({ summary, address, positionId })
      console.log({ depositAndWithdraw })
      const mintAndRepay = getMintAndRepayMsgs({
        address,
        positionId,
        mintAmount: mintState?.mint,
        repayAmount: mintState?.repay,
      })
      return [...depositAndWithdraw, ...mintAndRepay] as MsgExecuteContractEncodeObject[]
    },
    enabled: !!address && !!positionId && !mintState.overdraft,
  })

  return useSimulateAndBroadcast({
    msgs,
    queryKey: [
      String(mintState?.mint) || '0',
      String(mintState?.repay) || '0',
      ...summary?.map((s: any) => String(s.amount)),
    ],
    amount: '1',
  })

  // const simulate = useSimulate({
  //   msgs,
  //   amount: '1',
  //   queryKey: [
  //     String(mintState?.mint) || '0',
  //     String(mintState?.repay) || '0',
  //     summary?.map((s: any) => String(s.value)) || '0',
  //   ],
  // })

  // const tx = useTransaction({
  //   msgs,
  //   fee: simulate.data?.[0] || [],
  // })

  // return {
  //   simulate,
  //   tx,
  // }
}

export default useMint
