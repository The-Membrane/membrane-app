import { useQuery } from '@tanstack/react-query'
import { ProposalVoteOption } from '@/contracts/codegen/governance/Governance.types'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import { governanceAbi } from '@/contracts/abis/governance'
import { getContractAddress } from '@/config/evm/contracts'
import type { EvmCall } from '@/services/chain/types'

// Governance.sol VoteOption enum (For=0, Against=1, Amend=2, Remove=3, Align=4).
const VOTE_OPTION: Record<ProposalVoteOption, number> = {
  for: 0,
  against: 1,
  amend: 2,
  remove: 3,
  align: 4,
}

type CastVoteParams = {
  proposalId: number
  vote?: ProposalVoteOption | null
  /**
   * Caller's (pre-quadratic) voting power. Governance.castVote takes this as an
   * argument — the contract does NOT read it from Staking itself.
   * TODO(evm-migration): VoteButton should pass the value it already fetches via
   * useVotingPower; the call is gated off while it is absent/zero.
   */
  votingPower?: string | number | bigint
}

const onSuccess = () => {
  queryClient.invalidateQueries({ queryKey: ['proposal'] })
  queryClient.invalidateQueries({ queryKey: ['user voting power'] })
  queryClient.invalidateQueries({ queryKey: ['proposals'] })
}

const useCastVote = ({ proposalId, vote, votingPower }: CastVoteParams) => {
  const { address, chain } = useWallet()

  const { data: msgs } = useQuery<EvmCall[]>({
    // NOTE: the Cosmos hook bundled points checkClaims/givePoints around the vote
    // in one atomic tx. On EVM multi-call is non-atomic (one signature each) and
    // Points is a separate migration domain, so this hook casts the vote only.
    // TODO(evm-migration): re-add Points integration once that domain lands (via
    // a router/multicall, since separate EvmCalls are not atomic).
    queryKey: ['msg', 'vote on proposal', address, chain.id, proposalId, vote, votingPower?.toString()],
    queryFn: () => {
      const govAddress = getContractAddress(chain.id, 'governance')
      if (!address || !vote || !govAddress || votingPower == null || BigInt(votingPower) === 0n) {
        return []
      }
      return [
        {
          address: govAddress,
          abi: governanceAbi,
          functionName: 'castVote',
          args: [BigInt(proposalId), VOTE_OPTION[vote], BigInt(votingPower)],
        },
      ]
    },
    enabled: !!address && !!vote,
  })

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['vote proposal sim', proposalId?.toString(), msgs?.length ? '1' : '0'],
      enabled: true,
      onSuccess,
    }),
    msgs,
  }
}

export default useCastVote
