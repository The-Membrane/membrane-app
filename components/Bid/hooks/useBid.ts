import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { useQuery } from '@tanstack/react-query'
import { shiftDigits } from '@/helpers/math'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { queryClient } from '@/pages/_app'
import { assetKey } from '@/services/chain/liquidation'
import { buildApproveIfNeeded } from '@/services/chain/allowance'
import { liqQueueAbi } from '@/contracts/abis/liqQueue'
import { getContractAddress, type Address } from '@/config/evm/contracts'
import type { EvmCall } from '@/services/chain/types'
import useBidState from './useBidState'

type Props = {
  txSuccess?: () => void
}

/**
 * Place a LiqQueue bid — EVM port (was submitBid on the CosmWasm liquidation_queue).
 *
 * Builds a 2-step EvmCall[]: approve CDT to the LiqQueue, then submitBid. The queue
 * pulls the bid asset (CDT) via transferFrom (LiqQueue.sol:544), so the approve is
 * required. `submitBid(bidFor, liqPremium, bidAmount, bidOwner)` takes the raw premium
 * index (0..maxPremium) and credits `bidOwner` (address(0) → msg.sender).
 *
 * TODO(evm-migration): the Cosmos "Omni Asset Pool" (premium === 10, routed to the
 * stability-pool deposit) has no Solidity equivalent — inv_no_stability_pool. That
 * branch is dropped; premium 10 is treated as a normal 10%-premium single-asset bid.
 */
const useBid = ({ txSuccess }: Props) => {
  const { bidState } = useBidState()
  const cdtAsset = useAssetBySymbol('CDT')
  const selectedAsset = bidState?.selectedAsset
  const { premium, cdt } = bidState?.placeBid
  const { address, chain, publicClient } = useWallet()

  const { data: msgs } = useQuery<EvmCall[] | undefined>({
    queryKey: ['bid', 'msgs', address, selectedAsset?.symbol, premium, cdt],
    queryFn: async () => {
      if (!address || !selectedAsset) return undefined
      const liqQueue = getContractAddress(chain.id, 'liqQueue')
      const cdtToken = getContractAddress(chain.id, 'cdt')
      if (!liqQueue || !cdtToken) return undefined

      const decimals = cdtAsset?.decimal ?? 6
      const bidAmount = BigInt(shiftDigits(cdt, decimals).dp(0).toString())
      const bidFor = assetKey(selectedAsset.symbol ?? selectedAsset.base)

      // Approve gated on the standing allowance (services/chain/allowance.ts).
      const calls: EvmCall[] = [
        ...(await buildApproveIfNeeded(publicClient ?? null, {
          token: cdtToken as Address,
          owner: address as Address,
          spender: liqQueue as Address,
          amount: bidAmount,
        })),
        {
          address: liqQueue,
          abi: liqQueueAbi,
          functionName: 'submitBid',
          args: [bidFor, BigInt(premium), bidAmount, address],
        },
      ]
      return calls
    },
    enabled: !!address && !!selectedAsset && !!cdt,
  })

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['liquidation info'] })
    queryClient.invalidateQueries({ queryKey: ['user bids'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
    // Allowance read inside the msg builder changed with this tx — rebuild msgs.
    queryClient.invalidateQueries({ queryKey: ['bid', 'msgs'] })
    txSuccess?.()
  }

  return useSimulateAndBroadcast({
    msgs,
    queryKey: ['bid_sim', msgs?.toString() ?? '0'],
    amount: cdt.toString(),
    enabled: !!msgs,
    onSuccess,
  })
}

export default useBid
