import { stakingAbi } from '@/contracts/abis/staking'
import { getContractAddress } from '@/config/evm/contracts'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import type { EvmCall } from '@/services/chain/types'
import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'next/router'

const onSuccess = () => {
  queryClient.invalidateQueries({ queryKey: ['staked'] })
  queryClient.invalidateQueries({ queryKey: ['balances'] })
}

/**
 * Withdraw matured unbonding deposits. EVM rewire: the CosmWasm flow re-sent
 * `unstake({ mbrnAmount: '0' })` to finalize; Staking.sol splits mark/finalize, so the
 * finalize step is the dedicated `withdrawMatured()` call.
 */
export const useClaimUnstake = ({
  address,
  sim = true,
  run = true,
}: {
  address: string | undefined
  sim: boolean
  run: boolean
}) => {
  const router = useRouter()
  const { chain } = useWallet()
  const stakingAddr = chain ? getContractAddress(chain.id, 'staking') : undefined

  const { data: msgs } = useQuery<EvmCall[] | undefined>({
    queryKey: ['staking', 'unstaking_claims_msg', address, stakingAddr, run, router.pathname],
    queryFn: () => {
      if (router.pathname != '/bid' && !run) return undefined
      if (!address || !stakingAddr) return undefined

      return [
        {
          address: stakingAddr,
          abi: stakingAbi,
          functionName: 'withdrawMatured',
          args: [],
        },
      ]
    },
    enabled: !!address && !!stakingAddr,
  })

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['claim_unstake', address ?? ''],
      enabled: sim && !!msgs?.length,
      onSuccess,
    }),
    msgs,
  }
}

export default useClaimUnstake
