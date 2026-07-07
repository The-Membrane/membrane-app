import { stakingAbi } from '@/contracts/abis/staking'
import { getContractAddress } from '@/config/evm/contracts'
import { shiftDigits } from '@/helpers/math'
import { useAssetBySymbol } from '@/hooks/useAssets'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import type { EvmCall } from '@/services/chain/types'
import { queryClient } from '@/pages/_app'
import { useQuery } from '@tanstack/react-query'

type UseUnstake = {
  amount: string
}

/** Mark deposits for unbonding. EVM rewire (was StakingMsgComposer.unstake). */
const useUnstake = ({ amount }: UseUnstake) => {
  const { address, chain } = useWallet()
  const mbrnAsset = useAssetBySymbol('MBRN')
  const stakingAddr = chain ? getContractAddress(chain.id, 'staking') : undefined

  const { data: unstakeMsgs } = useQuery<EvmCall[] | undefined>({
    queryKey: ['staking', 'unstake_msg', address, stakingAddr, amount],
    queryFn: () => {
      if (!address || !mbrnAsset || !stakingAddr) return undefined
      const microAmount = BigInt(shiftDigits(amount, mbrnAsset.decimal).dp(0).toString())

      return [
        {
          address: stakingAddr,
          abi: stakingAbi,
          functionName: 'unstake',
          args: [microAmount, false],
        },
      ]
    },
    enabled: !!address && !!mbrnAsset && !!stakingAddr && Number(amount) > 0,
  })

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['staked'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
  }

  const { simulate, tx } = useSimulateAndBroadcast({
    msgs: unstakeMsgs,
    amount,
    queryKey: ['unstake', address ?? '', amount],
    enabled: !!unstakeMsgs?.length,
    onSuccess,
  })

  return {
    simulate,
    tx,
  }
}

export default useUnstake
