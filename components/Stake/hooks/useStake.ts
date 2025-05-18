import contracts from '@/config/contracts.json'
import { StakingMsgComposer } from '@/contracts/codegen/staking/Staking.message-composer'
import { shiftDigits } from '@/helpers/math'
import { useAssetBySymbol } from '@/hooks/useAssets'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import { coin } from '@cosmjs/amino'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import useStakeState from './useStakeState'
import { useMemo } from 'react'
import { useChainRoute } from '@/hooks/useChainRoute'
type UseStake = {}

const useStakeing = ({ }: UseStake) => {
  const { chainName } = useChainRoute()
  const { address } = useWallet(chainName)
  const mbrnAsset = useAssetBySymbol('MBRN')
  const { stakeState } = useStakeState()
  const { amount, txType } = stakeState

  console.log("STAKE AMOUNT", amount)

  type QueryData = {
    msgs: MsgExecuteContractEncodeObject[] | undefined
  }
  const { data: queryData } = useQuery<QueryData>({
    queryKey: ['staking', 'msg', address, mbrnAsset?.base, contracts.staking, amount, txType],
    queryFn: async () => {
      if (!address || !mbrnAsset) return { msgs: undefined }

      const messageComposer = new StakingMsgComposer(address, contracts.staking)
      const macroAmount = shiftDigits(amount, mbrnAsset?.decimal).toString()
      const funds = [coin(macroAmount, mbrnAsset?.base)]
      var msgs = [] as MsgExecuteContractEncodeObject[]

      if (txType === 'Stake') msgs.push(messageComposer.stake({ user: address }, funds))
      else if (txType === 'Unstake') msgs.push(messageComposer.unstake({ mbrnAmount: macroAmount }))
      else return { msgs: undefined }

      return { msgs }
    },
    enabled: !!address,
  })

  const { msgs }: QueryData = useMemo(() => {
    if (!queryData) return { msgs: undefined }
    else return queryData
  }, [queryData])

  const onInitialSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['staked'] })
    queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
  }

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['manage_staking', (msgs?.toString() ?? "0")],
      onSuccess: onInitialSuccess,
      enabled: !!msgs,
    })
  }
}

export default useStakeing
