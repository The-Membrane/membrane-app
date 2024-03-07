import { getProposals } from '@/services/governance'
import { useQuery } from '@tanstack/react-query'

const useProposals = () => {
  return useQuery({
    queryKey: ['proposals'],
    queryFn: async () => {
      return getProposals()
    },
  })
}

export default useProposals
