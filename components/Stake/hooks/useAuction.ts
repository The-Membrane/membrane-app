import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { useQuery } from '@tanstack/react-query'
import { queryClient } from '@/pages/_app'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useBalanceByAsset } from '@/hooks/useBalance'
import { getLiveFeeAuction, useAssetAuctionClient } from '@/services/asset_auction'
import useWallet from '@/hooks/useWallet'
import type { EvmCall } from '@/services/chain/types'

export const useLiveFeeAuction = () => {
  const { data: client } = useAssetAuctionClient()
  return useQuery({
    queryKey: ['live fee auction', client],
    queryFn: async () => {
      return getLiveFeeAuction(client)
    },
  })
}

/**
 * TODO(evm-migration): fee-auction participation is stubbed pending two upstreams:
 * - services/asset_auction (useLiveFeeAuction) is still Cosmos — needs porting to
 *   Auction.sol reads (feeAuctions(denom), blacklistAuctions).
 * - SEMANTIC CHANGE: Auction.sol swapForFee(denom, paid) pulls CDT as the quote asset
 *   (AUC-C-01 remediation), NOT MBRN like the Cosmos fee auction. The EVM msgs are
 *   [cdt.approve(auction, paid), auction.swapForFee(denom, paid)] sized by the user's
 *   CDT balance, so this hook must switch from MBRN balance to CDT balance when live.
 */
export const useAuction = () => {
  const { address } = useWallet()
  const cdt = useAssetBySymbol('CDT')
  const mbrn = useAssetBySymbol('MBRN')
  const MBRNBalance = useBalanceByAsset(mbrn)
  const { data: feeAuctions } = useLiveFeeAuction()

  const { data: msgs } = useQuery<EvmCall[] | undefined>({
    queryKey: ['msg auction claim', address, feeAuctions, MBRNBalance, cdt, mbrn],
    queryFn: () => [] as EvmCall[],
    enabled: !!address,
  })

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
    queryClient.invalidateQueries({ queryKey: ['msg auction claim'] })
  }

  return {
    action: useSimulateAndBroadcast({
      msgs,
      enabled: !!msgs,
      queryKey: ['sim fee auction claim', (msgs?.toString() ?? "0")],
      onSuccess,
    }), msgs
  }
}

export default useAuction
