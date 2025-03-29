import useWallet from '@/hooks/useWallet'
import useAppState from '@/persisted-state/useAppState'
import { getAllocation, getUnlocked } from '@/services/vesting'
import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'next/router'

const useAllocation = (run: boolean = true) => {
  const { address } = useWallet()
  const { appState } = useAppState()
  const router = useRouter()


  return useQuery({
    queryKey: ['allocations', address, appState.rpcUrl, run, router.pathname],
    queryFn: async () => {
      if (router.pathname != "/lockdrop" && !run) return
      if (!address) return null

      const allocations = await getAllocation(address, appState.rpcUrl)
      const unlocked = await getUnlocked(address, appState.rpcUrl)

      return {
        ...allocations,
        unlocked: unlocked.unlocked_amount,
      }
    },
    enabled: !!address,
  })
}

export default useAllocation
