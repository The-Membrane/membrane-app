import { getDepostAndWithdrawMsgs, getMintAndRepayMsgs } from '@/helpers/mint'
import { useBasketPositions } from '@/hooks/useCDP'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
// import useMintState from './useMintState'
import { buildBidMsg, buildRetractBidMsg, buildUpdateBidMsg } from '@/services/liquidation'
import useBidState from './useBidState'
import { decodeMsgs } from '@/helpers/decodeMsg'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { shiftDigits } from '@/helpers/math'
import { coin } from '@cosmjs/stargate'
import { queryClient } from '@/pages/_app'

const useUpdateBid = ({ txSuccess }) => {
  const { bidState, setBidState } = useBidState()
  const cdtAsset = useAssetBySymbol('CDT')

  const selectedAsset = bidState?.selectedAsset
  const updateBids = bidState?.updateBids
  const { premium, cdt } = bidState?.placeBid

  // const { summary = [] } = mintState
  const { address } = useWallet()
  // const { data: basketPositions } = useBasketPositions()
  // const positionId = basketPositions?.[0]?.positions?.[0]?.position_id

  const newAmount = updateBids?.[0]?.newAmount
  const isUpdated = 'newAmount' in (updateBids?.[0] || {})
  const originalAmount = shiftDigits(updateBids?.[0]?.amount, -6).toNumber()

  const { data: msgs } = useQuery<MsgExecuteContractEncodeObject[] | undefined>({
    queryKey: ['update bid', address, selectedAsset?.base, newAmount],
    queryFn: () => {
      if (!address || !selectedAsset || newAmount >= originalAmount) return

      const amountDiff = originalAmount - newAmount

      // const updatedAmount = amountDiff > 0 ? newAmount - originalAmount : originalAmount - newAmount

      const microAmount = shiftDigits(amountDiff, 6).dp(0).toString()
      const funds = [coin(microAmount, cdtAsset?.base!)]

      let msg = null

      // if (newAmount === 0) {
      msg = buildRetractBidMsg({
        address,
        denom: selectedAsset.base,
        bidId: updateBids?.[0].id,
        amount: originalAmount === amountDiff ? undefined : microAmount,
      })
      // } else {
      //   msg = buildUpdateBidMsg({
      //     address,
      //     denom: selectedAsset.base,
      //     funds,
      //   })
      // }

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
