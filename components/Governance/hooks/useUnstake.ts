import { StakingMsgComposer } from '@/contracts/codegen/staking/Staking.message-composer'
import { StakingClient } from '@/contracts/generated/staking/Staking.client'
import { shiftDigits } from '@/helpers/math'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import contracts from '@/config/contracts.json'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { coin } from '@cosmjs/amino'
import useSimulate from '@/hooks/useSimulate'
import useTransaction from '@/hooks/useTransaction'

type UseUnstake = {
  amount: string
}

const useUnstake = ({ amount }: UseUnstake) => {
  const { address } = useWallet()
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
