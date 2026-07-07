import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { useQuery } from '@tanstack/react-query'
import { shiftDigits } from '@/helpers/math'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { queryClient } from '@/pages/_app'
import { assetKey } from '@/services/chain/liquidation'
import { liqQueueAbi } from '@/contracts/abis/liqQueue'
import { getContractAddress } from '@/config/evm/contracts'
import type { EvmCall } from '@/services/chain/types'
import useBidState from './useBidState'

type Props = {
  txSuccess?: () => void
}

/**
 * Update (retract) a LiqQueue bid — EVM port (was retractBid on the CosmWasm
 * liquidation_queue). `retractBid(bidFor, bidId, amount)`: amount === 0 retracts the
 * full bid (LiqQueue.sol:586), a smaller amount does a partial retract.
 */
const useUpdateBid = ({ txSuccess }: Props) => {
  const { bidState } = useBidState()
  const cdtAsset = useAssetBySymbol('CDT')
  const selectedAsset = bidState?.selectedAsset
  const updateBids = bidState?.updateBids
  const { address, chain } = useWallet()
  const newAmount = updateBids?.[0]?.newAmount
  const isUpdated = 'newAmount' in (updateBids?.[0] || {})
  const originalAmount = shiftDigits(updateBids?.[0]?.amount, -6).toNumber()

  const { data: msgs } = useQuery<EvmCall[] | undefined>({
    queryKey: ['update bid', 'msgs', address, selectedAsset?.symbol, newAmount],
    queryFn: () => {
      if (!address || !selectedAsset || newAmount >= originalAmount) return undefined
      const liqQueue = getContractAddress(chain.id, 'liqQueue')
      if (!liqQueue) return undefined

      const decimals = cdtAsset?.decimal ?? 6
      const amountDiff = originalAmount - newAmount
      // full retract → 0 (LiqQueue treats 0 as "retract everything")
      const retractAmount =
        originalAmount === amountDiff ? 0n : BigInt(shiftDigits(amountDiff, decimals).dp(0).toString())
      const bidFor = assetKey(selectedAsset.symbol ?? selectedAsset.base)
      const bidId = BigInt(updateBids?.[0]?.id)

      const call: EvmCall = {
        address: liqQueue,
        abi: liqQueueAbi,
        functionName: 'retractBid',
        args: [bidFor, bidId, retractAmount],
      }
      return [call]
    },
    enabled: !!address && !!selectedAsset && isUpdated && newAmount < originalAmount,
  })

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['user bids'] })
    queryClient.invalidateQueries({ queryKey: ['liquidation info'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
    txSuccess?.()
  }

  return useSimulateAndBroadcast({
    msgs,
    queryKey: ['update_bid_sim', msgs?.toString() ?? '0'],
    amount: newAmount?.toString(),
    enabled: !!msgs,
    onSuccess,
  })
}

export default useUpdateBid
