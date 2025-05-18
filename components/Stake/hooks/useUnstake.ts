import contracts from '@/config/contracts.json'
import { StakingMsgComposer } from '@/contracts/codegen/staking/Staking.message-composer'
import { shiftDigits } from '@/helpers/math'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useChainRoute } from '@/hooks/useChainRoute'
import useSimulate from '@/hooks/useSimulate'
import useTransaction from '@/hooks/useTransaction'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'

type UseUnstake = {
  amount: string
}

const useUnstake = ({ amount }: UseUnstake) => {
  const { chainName } = useChainRoute()
  const { address } = useWallet(chainName)
  const mbrnAsset = useAssetBySymbol('MBRN')

  const { data: unstakeMsgs = [] } = useQuery<MsgExecuteContractEncodeObject[] | null>({
    queryKey: ['msg', address, mbrnAsset?.base, contracts.staking, amount],
    queryFn: async () => {
      if (!address || !mbrnAsset) return null

      const messageComposer = new StakingMsgComposer(address, contracts.staking)
      const macroAmount = shiftDigits(amount, mbrnAsset?.decimal).toString()

      const msg = messageComposer.unstake({ mbrnAmount: macroAmount })

      if (!msg) return null

      return [msg]
    },
    enabled: !!address && !!mbrnAsset && !!contracts.staking && Number(amount) > 0,
  })

  const simulate = useSimulate({
    msgs: unstakeMsgs,
    amount: amount,
    queryKey: [mbrnAsset?.base!],
    chain_id: 'osmosis',
  })

  const tx = useTransaction({
    msgs: unstakeMsgs,
    fee: simulate.data?.[0] || [],
  })

  return {
    simulate,
    tx,
  }
}

export default useUnstake
