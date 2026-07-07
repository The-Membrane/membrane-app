import { stakingAbi } from '@/contracts/abis/staking'
import { getContractAddress } from '@/config/evm/contracts'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import type { EvmCall } from '@/services/chain/types'
import { useQuery } from '@tanstack/react-query'

/**
 * Restake — clear the unbonding flag on all the caller's deposits. EVM rewire off the
 * former SigningCosmWasmClient seam bypass and onto the standard EvmCall pipeline.
 *
 * NOTE: Staking.sol `restake()` takes no amount (it un-marks every unbonding deposit);
 * the legacy `mbrnAmount` arg is kept for call-site compatibility but is advisory only.
 */
const useRestake = (mbrnAmount?: string) => {
  const { address, chain } = useWallet()
  const stakingAddr = chain ? getContractAddress(chain.id, 'staking') : undefined

  const { data: msgs } = useQuery<EvmCall[] | undefined>({
    queryKey: ['staking', 'restake_msg', address, stakingAddr],
    queryFn: () => {
      if (!address || !stakingAddr) return undefined
      return [
        {
          address: stakingAddr,
          abi: stakingAbi,
          functionName: 'restake',
          args: [],
        },
      ]
    },
    enabled: !!address && !!stakingAddr,
  })

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['staked'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
  }

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['restake', address ?? ''],
      enabled: !!msgs?.length,
      onSuccess,
    }),
  }
}

export default useRestake
