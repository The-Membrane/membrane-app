import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import { shiftDigits } from '@/helpers/math'
import { queryClient } from '@/pages/_app'
import { buildRetractBidMsg } from '@/services/liquidation'
import useBidState from './useBidState'

type Props = {
  txSuccess?: () => void
}

const useUpdateBid = ({ txSuccess }: Props) => {
  const { bidState } = useBidState()
  const selectedAsset = bidState?.selectedAsset
  const updateBids = bidState?.updateBids
  const { address } = useWallet()
  const newAmount = updateBids?.[0]?.newAmount
  const isUpdated = 'newAmount' in (updateBids?.[0] || {})
  const originalAmount = shiftDigits(updateBids?.[0]?.amount, -6).toNumber()

  const { data: msgs } = useQuery<MsgExecuteContractEncodeObject[] | undefined>({
    queryKey: ['update bid', 'msgs', address, selectedAsset?.base, newAmount],
    queryFn: () => {
      if (!address || !selectedAsset || newAmount >= originalAmount) return

      const amountDiff = originalAmount - newAmount
      const microAmount = shiftDigits(amountDiff, 6).dp(0).toString()

      const msg = buildRetractBidMsg({
        address,
        denom: selectedAsset.base,
        bidId: updateBids?.[0].id,
        amount: originalAmount === amountDiff ? undefined : microAmount,
      })

      return [msg] as MsgExecuteContractEncodeObject[]
    },
    enabled: !!address && !!selectedAsset && isUpdated && newAmount < originalAmount,
  })

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['user bids'] })
    queryClient.invalidateQueries({ queryKey: ['liquidation info'] })
    txSuccess?.()
  }

  return useSimulateAndBroadcast({
    msgs,
    queryKey: [],
    amount: newAmount?.toString(),
    onSuccess,
  })
}

export default useUpdateBid
