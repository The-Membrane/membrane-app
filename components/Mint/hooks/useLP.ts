import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import { shiftDigits } from '@/helpers/math'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { queryClient } from '@/pages/_app'
import { coin } from '@cosmjs/stargate'
import useLPState from './useLPState'
import { handleCollateralswaps, joinCLPools } from '@/services/osmosis'
import { num } from '@/helpers/num'
import { exported_supportedAssets } from '@/helpers/chain'

type Props = {
  txSuccess?: () => void
}

const useLP = ({ txSuccess }: Props) => {
  const { LPState } = useLPState()
  const cdtAsset = useAssetBySymbol('CDT')
  const usdcAsset = useAssetBySymbol('USDC')
  const { address } = useWallet()

  const { data: msgs } = useQuery<MsgExecuteContractEncodeObject[] | undefined>({
    queryKey: ['bid', 'msgs', address, LPState.newCDT],
    queryFn: () => {
      if (!address || LPState.newCDT === 0) return

      const microAmount = shiftDigits(LPState.newCDT, 6).dp(0).toString()

      //Swap to USDC
      const CDTInAmount = num(microAmount).div(2).toNumber()
      const { msg, tokenOutMinAmount } = handleCollateralswaps(address, 'USDC' as keyof exported_supportedAssets, CDTInAmount)

      var msgs = msg
      console.log("swap", msg)

      //Build LP msg
      const CDTCoinIn = coin(CDTInAmount.toString(), cdtAsset?.base!)
      const USDCCoinIn = coin(tokenOutMinAmount.toString(), usdcAsset?.base!)
      const LPmsg = joinCLPools(address, CDTCoinIn, 1268, USDCCoinIn)

      msgs = msgs.concat(LPmsg)
      console.log("lpmsg", LPmsg)
                
      return [msg] as MsgExecuteContractEncodeObject[]
    },
    enabled: !!address && LPState.newCDT !== 0,
  })
  console.log("all msgs", msgs)

  const onSuccess = () => {
    //We'll handle withdraws and rewards in the future
    // queryClient.invalidateQueries({ queryKey: ['LP IDs'] })
    // queryClient.invalidateQueries({ queryKey: ['LP rewards'] })
    txSuccess?.()
  }

  return useSimulateAndBroadcast({
    msgs,
    queryKey: [],
    amount: LPState.newCDT.toString(),
    onSuccess,
  })
}

export default useLP
