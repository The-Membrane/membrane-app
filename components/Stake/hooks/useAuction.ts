import contracts from '@/config/contracts.json'
import { AuctionMsgComposer } from '@/contracts/codegen/auction/Auction.message-composer'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { useQuery } from '@tanstack/react-query'
import { queryClient } from '@/pages/_app'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useBalanceByAsset } from '@/hooks/useBalance'
import { isGreaterThanZero, shiftDigits } from '@/helpers/num'
import { getLiveFeeAuction, useAssetAuctionClient } from '@/services/asset_auction'
import useWallet from '@/hooks/useWallet'
import { coin } from '@cosmjs/stargate'
import useAppState from '@/persisted-state/useAppState'
import { useChainRoute } from '@/hooks/useChainRoute'

export const useLiveFeeAuction = () => {
  const { data: client } = useAssetAuctionClient()
  return useQuery({
    queryKey: ['live fee auction', client],
    queryFn: async () => {
      return getLiveFeeAuction(client)
    },
  })
}

export const useAuction = () => {
  const { chainName } = useChainRoute()
  const { address } = useWallet(chainName)
  const cdt = useAssetBySymbol('CDT', chainName)
  const mbrn = useAssetBySymbol('MBRN', chainName)
  const MBRNBalance = useBalanceByAsset(mbrn)
  const { data: feeAuctions } = useLiveFeeAuction()

  const { data: msgs } = useQuery<MsgExecuteContractEncodeObject[] | undefined>({
    queryKey: ['msg auction claim', address, feeAuctions, MBRNBalance, cdt, mbrn],
    queryFn: () => {
      console.log("boom", !address, !cdt, !mbrn, !feeAuctions, !isGreaterThanZero(MBRNBalance))
      if (!address || !cdt || !mbrn || !feeAuctions || !isGreaterThanZero(MBRNBalance)) return [] as MsgExecuteContractEncodeObject[]

      const messageComposer = new AuctionMsgComposer(address, contracts.auction)

      console.log("here:", feeAuctions[0])
      //Create msgs for the first Auction which has the lowest discount
      console.log(shiftDigits(MBRNBalance, 6))
      const funds = coin(shiftDigits(MBRNBalance, 6).toString(), mbrn.base)
      const msgs = messageComposer.swapForFee({ auctionAsset: feeAuctions[0].auction_asset.info }, [funds])
      console.log("here2")
      //Subsequent executions can handle the next auction, this allows the user to only execute for discounts they like 
      //+ we don't have to do calculations for how much MBRN needs to be sent

      console.log("msgs:", msgs)
      return [msgs] as MsgExecuteContractEncodeObject[]
    },
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
