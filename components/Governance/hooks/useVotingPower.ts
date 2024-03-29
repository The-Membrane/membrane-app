import useWallet from '@/hooks/useWallet'
import { getUserVotingPower } from '@/services/governance'
import { getDelegatorInfo } from '@/services/staking'
import { useQuery } from '@tanstack/react-query'

const useVotingPower = (proposalId: number) => {
  const { address } = useWallet()
  return useQuery({
    queryKey: ['user voting power', address, proposalId],
    queryFn: async () => {
      if (!address) return Promise.reject('No address found')

      return getUserVotingPower(address, proposalId)
    },
    enabled: !!address && !!proposalId,
  })
}

export default useVotingPower
