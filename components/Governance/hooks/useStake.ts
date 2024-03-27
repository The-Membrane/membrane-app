import contracts from '@/config/contracts.json'
import { StakingMsgComposer } from '@/contracts/codegen/staking/Staking.message-composer'
import { shiftDigits } from '@/helpers/math'
import { useAssetBySymbol } from '@/hooks/useAssets'
import useSimulate from '@/hooks/useSimulate'
import useTransaction from '@/hooks/useTransaction'
import useWallet from '@/hooks/useWallet'
import { coin } from '@cosmjs/amino'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'

type UseStake = {
  amount: string
}

const useStake = ({ amount }: UseStake) => {
  const { address } = useWallet()
  const mbrnAsset = useAssetBySymbol('MBRN')

  const { data: stakeMsgs = [] } = useQuery<MsgExecuteContractEncodeObject[] | null>({
    queryKey: ['msg', address, mbrnAsset?.base, contracts.staking, amount],
    queryFn: async () => {
      if (!address || !mbrnAsset) return null

      const messageComposer = new StakingMsgComposer(address, contracts.staking)
      const macroAmount = shiftDigits(amount, mbrnAsset?.decimal).toString()
      const funds = [coin(macroAmount, mbrnAsset?.base)]
      const msg = messageComposer.stake({ user: address }, funds)

      if (!msg) return null

      return [msg]
    },
    enabled: !!address && !!mbrnAsset && !!contracts.staking && Number(amount) > 0,
  })

  const simulate = useSimulate({
    msgs: stakeMsgs,
    amount: amount,
    queryKey: [mbrnAsset?.base!],
  })

  const tx = useTransaction({
    msgs: stakeMsgs,
    fee: simulate.data?.[0] || [],
  })

  return {
    simulate,
    tx,
  }
}

export default useStake
