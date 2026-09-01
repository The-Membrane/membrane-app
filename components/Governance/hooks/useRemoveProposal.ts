import { useQuery } from '@tanstack/react-query'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import { governanceAbi } from '@/contracts/abis/governance'
import { getContractAddress } from '@/config/evm/contracts'
import type { EvmCall } from '@/services/chain/types'

type Props = {
  proposalId: number
}

/**
 * Garbage-collect a completed/rejected/expired proposal (or one's own).
 * Was a seam bypass (built its own SigningCosmWasmClient); now builds an
 * EvmCall[] fed through the standard simulate → broadcast pipeline.
 */
const onSuccess = () => {
  queryClient.invalidateQueries({ queryKey: ['proposal'] })
  queryClient.invalidateQueries({ queryKey: ['user voting power'] })
  queryClient.invalidateQueries({ queryKey: ['proposals'] })
}

const useRemoveProposal = ({ proposalId }: Props) => {
  const { address, chain } = useWallet()

  const { data: msgs } = useQuery<EvmCall[]>({
    queryKey: ['msg', 'remove proposal', address, chain.id, proposalId],
    queryFn: () => {
      const govAddress = getContractAddress(chain.id, 'governance')
      if (!address || !proposalId || !govAddress) return []
      return [
        {
          address: govAddress,
          abi: governanceAbi,
          functionName: 'removeCompletedProposal',
          args: [BigInt(proposalId)],
        },
      ]
    },
    enabled: !!address && !!proposalId,
  })

  return useSimulateAndBroadcast({
    msgs,
    queryKey: ['remove proposal sim', proposalId?.toString(), msgs?.length ? '1' : '0'],
    enabled: true,
    onSuccess,
  })
}

export default useRemoveProposal
