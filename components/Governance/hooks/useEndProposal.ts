import { useQuery } from '@tanstack/react-query'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import { governanceAbi } from '@/contracts/abis/governance'
import { getContractAddress } from '@/config/evm/contracts'
import type { EvmCall } from '@/services/chain/types'

type Props = {
  proposalId: number
  /**
   * Total system voting power for the quorum tally. Governance.sol takes this as
   * a caller-supplied argument (no on-chain view — it is a Staking-organ figure).
   * TODO(evm-migration): thread the live staked total from the Staking read
   * service; until then the call is gated off when absent.
   */
  totalVotingPower?: string | number | bigint
}

/**
 * End (tally) an Active proposal whose voting period has elapsed.
 * Was a seam bypass (built its own SigningCosmWasmClient); now builds an
 * EvmCall[] fed through the standard simulate → broadcast pipeline.
 */
const onSuccess = () => {
  queryClient.invalidateQueries({ queryKey: ['proposal'] })
  queryClient.invalidateQueries({ queryKey: ['user voting power'] })
  queryClient.invalidateQueries({ queryKey: ['proposals'] })
}

const useEndProposal = ({ proposalId, totalVotingPower }: Props) => {
  const { address, chain } = useWallet()

  const { data: msgs } = useQuery<EvmCall[]>({
    queryKey: ['msg', 'end proposal', address, chain.id, proposalId, totalVotingPower?.toString()],
    queryFn: () => {
      const govAddress = getContractAddress(chain.id, 'governance')
      if (!address || !proposalId || !govAddress || totalVotingPower == null) return []
      return [
        {
          address: govAddress,
          abi: governanceAbi,
          functionName: 'endProposal',
          args: [BigInt(proposalId), BigInt(totalVotingPower)],
        },
      ]
    },
    enabled: !!address && !!proposalId,
  })

  return useSimulateAndBroadcast({
    msgs,
    queryKey: ['end proposal sim', proposalId?.toString(), msgs?.length ? '1' : '0'],
    enabled: true,
    onSuccess,
  })
}

export default useEndProposal
