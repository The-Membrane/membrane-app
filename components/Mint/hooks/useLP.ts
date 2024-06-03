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
import { useOraclePrice } from '@/hooks/useOracle'
import { USDC_CL_RATIO } from '@/config/defaults'

type Props = {
  txSuccess?: () => void
}

const useLP = ({ txSuccess }: Props) => {
  const { LPState } = useLPState()
  const cdtAsset = useAssetBySymbol('CDT')
  const usdcAsset = useAssetBySymbol("USDC")
  const { address } = useWallet()
  const { data: prices } = useOraclePrice()

  const { data: msgs } = useQuery<MsgExecuteContractEncodeObject[] | undefined>({
    queryKey: ['bid', 'msgs', address, LPState.newCDT],
    queryFn: () => {
      if (!address || LPState.newCDT === 0) return

      const microAmount = shiftDigits(LPState.newCDT, 6).dp(0).toString()

      //Swap to USDC
      const cdtPrice = prices?.find((price) => price.denom === cdtAsset?.base)
      const usdcPrice = prices?.find((price) => price.denom === usdcAsset?.base)
      //CL LP range flucuates so we havbe a config RATIO
      const CDTInAmount = num(microAmount).multipliedBy(1 - USDC_CL_RATIO).toNumber()
      const USDCTradeAmount = num(microAmount).multipliedBy(USDC_CL_RATIO).toNumber()
      const { msg, tokenOutMinAmount } = handleCollateralswaps(address, Number(cdtPrice!.price), Number(usdcPrice!.price), 'USDC' as keyof exported_supportedAssets, USDCTradeAmount)

      var msgs = [msg]

      //Build LP msg
      const CDTCoinIn = coin(CDTInAmount.toString(), cdtAsset?.base!)
      const USDCCoinIn = coin(tokenOutMinAmount.toString(), usdcAsset?.base!)
      const LPmsg = joinCLPools(address, CDTCoinIn, 1268, USDCCoinIn)

      msgs.push(LPmsg as MsgExecuteContractEncodeObject)
                
      return msgs as MsgExecuteContractEncodeObject[]
    },
    enabled: !!address && LPState.newCDT !== 0,
  })

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
