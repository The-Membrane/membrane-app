import { erc20Abi } from 'viem'
import { useQuery } from '@tanstack/react-query'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { queryClient } from '@/pages/_app'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useBalanceByAsset } from '@/hooks/useBalance'
import useWallet from '@/hooks/useWallet'
import { shiftDigits } from '@/helpers/math'
import { getContractAddress } from '@/config/evm/contracts'
import { auctionAbi } from '@/contracts/abis/auction'
import { getLiveFeeAuctions } from '@/services/chain/auction'
import type { EvmCall } from '@/services/chain/types'

/**
 * Live fee auctions (EVM). Ported from the Cosmos `ongoingFeeAuctions` read onto
 * Auction.sol via services/chain/auction.getLiveFeeAuctions (AuctionStarted event
 * reconstruction → feeAuctions(denom) filtered to `exists`). Wallet-independent
 * read: uses the public client so the auction surfaces before connect.
 */
export const useLiveFeeAuction = () => {
  const { chain, publicClient } = useWallet()
  return useQuery({
    queryKey: ['live fee auction', chain.id],
    queryFn: async () => {
      return getLiveFeeAuctions(publicClient ?? null)
    },
    enabled: !!publicClient,
    staleTime: 1000 * 60, // 1m — auction state is volatile (Dutch ramp)
  })
}

/**
 * Fee-auction buy CTA.
 *
 * SEMANTIC CHANGE (Auction.sol AUC-C-01): swapForFee(denom, paid) pulls CDT as
 * the quote asset (NOT MBRN like the Cosmos fee auction), then pushes the fee
 * asset payout. The buy is sized by the user's CDT balance and settled in two
 * (non-atomic) steps — approve then swap — per services/chain/types.ts:
 *   [ cdt.approve(auction, paid), auction.swapForFee(denom, paid) ]
 * `denom` targets the oldest live auction (deepest discount), matching the
 * getLiveFeeAuctions ordering.
 */
export const useAuction = () => {
  const { address, chain } = useWallet()
  const cdt = useAssetBySymbol('CDT')
  const CDTBalance = useBalanceByAsset(cdt)
  const { data: feeAuctions } = useLiveFeeAuction()

  const auctionAddr = chain ? getContractAddress(chain.id, 'auction') : undefined
  const cdtAddr = chain ? getContractAddress(chain.id, 'cdt') : undefined
  const denom = feeAuctions?.[0]?.auctionAssetDenom

  const { data: msgs } = useQuery<EvmCall[] | undefined>({
    queryKey: ['msg auction swap', address, denom, CDTBalance, auctionAddr, cdtAddr],
    queryFn: () => {
      if (!address || !auctionAddr || !cdtAddr || !cdt || !denom) return undefined
      const paid = BigInt(shiftDigits(CDTBalance, cdt.decimal).dp(0).toString())
      if (paid <= 0n) return undefined

      return [
        {
          address: cdtAddr,
          abi: erc20Abi,
          functionName: 'approve',
          args: [auctionAddr, paid],
        },
        {
          address: auctionAddr,
          abi: auctionAbi,
          functionName: 'swapForFee',
          args: [denom, paid],
        },
      ]
    },
    enabled: !!address && !!auctionAddr && !!cdtAddr && !!cdt && !!denom,
  })

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['live fee auction'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
    queryClient.invalidateQueries({ queryKey: ['msg auction swap'] })
  }

  return {
    action: useSimulateAndBroadcast({
      msgs,
      enabled: !!msgs?.length,
      queryKey: ['sim fee auction swap', (msgs?.toString() ?? '0')],
      onSuccess,
    }),
    msgs,
  }
}

export default useAuction
