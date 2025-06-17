import { num } from '@/helpers/num'
import { useChainRoute } from '@/hooks/useChainRoute'
import useWallet from '@/hooks/useWallet'
import { getRewards, getStaked, useStakingClient } from '@/services/staking'
import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'next/router'


const useStaked = (run: boolean) => {
  const { chainName } = useChainRoute()
  const { address } = useWallet(chainName)
  const router = useRouter()
  const { data: client } = useStakingClient()

  console.log("in staked")
  return useQuery({
    queryKey: ['staked', address, client, run, router.pathname, chainName],
    queryFn: async () => {
      if (!router.pathname.endsWith("/stake") && !run) return
      if (!address) return null

      // Check if we use stakeState or requery
      const data = await getStaked(address, client)
      console.log("staked data", data)

      const { deposit_list } = data
      console.log("deposit_list in query", deposit_list)
      const staking = deposit_list?.filter((s) => !s.unstake_start_time)
      const unstaking = deposit_list?.filter((s) => s.unstake_start_time)
      console.log("staking in query", staking)
      console.log("unstaking in query", unstaking)

      const staked = staking?.reduce((acc, s) => {
        return acc.plus(Number(s.amount))
      }, num(0)).toNumber()

      console.log("staked in query", staked)

      const rewards = await getRewards(address, client, chainName)
      console.log("rewards in query", rewards)
      //Reward query is erroring (?)
      return {
        staked,
        unstaking,
        rewards,
      }
    },
    enabled: !!address,
  })
}

export default useStaked
