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
 * Execute a Passed proposal (dispatches its (target,data) messages on-chain).
 * Was a seam bypass (built its own SigningCosmWasmClient); now builds an
 * EvmCall[] fed through the standard simulate → broadcast pipeline.
 */
const useExecuteProposal = ({ proposalId }: Props) => {
  const { address, chain } = useWallet()

  const { data: msgs } = useQuery<EvmCall[]>({
    queryKey: ['msg', 'execute proposal', address, chain.id, proposalId],
    queryFn: () => {
      const govAddress = getContractAddress(chain.id, 'governance')
      if (!address || !proposalId || !govAddress) return []
      return [
        {
          address: govAddress,
          abi: governanceAbi,
          functionName: 'executeProposal',
          args: [BigInt(proposalId)],
        },
      ]
    },
    enabled: !!address && !!proposalId,
  })

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['proposal'] })
    queryClient.invalidateQueries({ queryKey: ['user voting power'] })
    queryClient.invalidateQueries({ queryKey: ['proposals'] })
  }

  return useSimulateAndBroadcast({
    msgs,
    queryKey: ['execute proposal sim', proposalId?.toString(), msgs?.length ? '1' : '0'],
    enabled: true,
    onSuccess,
  })
}

export default useExecuteProposal
