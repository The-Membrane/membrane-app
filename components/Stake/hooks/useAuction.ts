import contracts from '@/config/contracts.json'
import { AuctionMsgComposer } from '@/contracts/codegen/auction/Auction.message-composer'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { useQuery } from '@tanstack/react-query'
import { queryClient } from '@/pages/_app'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useBalanceByAsset } from '@/hooks/useBalance'
import { isGreaterThanZero } from '@/helpers/num'
import { coins } from 'cosmwasm'
import { getLiveFeeAuction } from '@/services/asset_auction'


export const useLiveFeeAuction = () => {
  return useQuery({
    queryKey: ['live fee auction'],
    queryFn: async () => {
      return getLiveFeeAuction()
    },
  })
}

export const useAuction = () => {
    const { address } = useWallet()
    const cdt = useAssetBySymbol('CDT')
    const mbrn = useAssetBySymbol('MBRN')
    const MBRNBalance = useBalanceByAsset(mbrn)    
  const { data: feeAuctions } = useLiveFeeAuction()
  
  const { data: msgs } = useQuery<MsgExecuteContractEncodeObject[] | undefined>({
    queryKey: ['msg auction claim', address],
    queryFn: () => {
      if (!address || !cdt || !mbrn || !feeAuctions || !isGreaterThanZero(MBRNBalance)) return [] as MsgExecuteContractEncodeObject[]
        
      const messageComposer = new AuctionMsgComposer(address, contracts.auction)
      
      //Create msgs for every asset that has a ongoing auction
      const msgs = messageComposer.swapForFee({auctionAsset: {
        native_token: {
          denom: cdt.base
        }
      }}, coins(MBRNBalance, mbrn.base) )

      return [msgs] as MsgExecuteContractEncodeObject[]
    },
    enabled: !!address,
  })
  
  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['balances'] })
  }

  return {
    action: useSimulateAndBroadcast({
    msgs,
    enabled: !!msgs,
    onSuccess,
  }), msgs}
}

export default useAuction

function useWallet(): { address: any } {
    throw new Error('Function not implemented.')
}
