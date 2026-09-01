import { num } from '@/helpers/num'
import useWallet from '@/hooks/useWallet'
import { getUserStake, getUserRewards } from '@/services/chain/staking'
import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'next/router'
import type { Address } from '@/config/evm/contracts'

/**
 * Per-user staking snapshot. EVM rewire (was services/staking getStaked/getRewards over
 * the CosmWasm StakingQueryClient). Shape preserved for consumers:
 *   { staked (micro number), unstaking [{ amount, unstake_start_time }], rewards [] }
 */
const useStaked = (run: boolean) => {
  const { address, publicClient } = useWallet()
  const router = useRouter()

  return useQuery({
    queryKey: ['staked', address, run, router.pathname, publicClient?.chain?.id],
    queryFn: async () => {
      if (!router.pathname.endsWith('/stake') && !run) return
      if (!address || !publicClient) return null

      const data = await getUserStake(publicClient, address as Address)
      if (!data) return null

      const staking = data.deposits.filter((d) => d.unstakeStartTime === 0n)
      const unstaking = data.deposits.flatMap((d) =>
        d.unstakeStartTime !== 0n
          ? [{
              amount: d.amount.toString(),
              unstake_start_time: Number(d.unstakeStartTime),
            }]
          : []
      )

      const staked = staking
        .reduce((acc, d) => acc.plus(d.amount.toString()), num(0))
        .toNumber()

      // getUserRewards is a null stub on EVM (no pending-rewards view); keep the
      // rewards array so ClaimAndRestake renders its empty state cleanly.
      const rewards = (await getUserRewards(publicClient, address as Address)) ?? []

      return {
        staked,
        unstaking,
        rewards,
      }
    },
    enabled: !!address,
    staleTime: 1000 * 60 * 2,
  })
}

export default useStaked
