import { CheckIcon } from '@chakra-ui/icons'
import { Text } from '@chakra-ui/react'
import React from 'react'
import useCastVote from './hooks/useCastVote'
import { ProposalVoteOption } from '@/contracts/codegen/governance/Governance.types'
import { TxButton } from '@/components/TxButton'
import useVotingPower from './hooks/useVotingPower'

type Props = {
  show: boolean
  vote?: ProposalVoteOption | null
  proposalId: string
}

const VoteButton = ({ show, vote, proposalId }: Props) => {
  const castVote = useCastVote({
    proposalId: Number(proposalId),
    vote,
  })

  const { data: votingPower, isLoading } = useVotingPower(Number(proposalId))

  if (!show || isLoading) return null

  if (Number(votingPower) === 0)
    return <Text color="gray">You have no voting power for this proposal</Text>

  return (
    <TxButton
      leftIcon={<CheckIcon />}
      px="5"
      w="fit-content"
      fontSize="sm"
      isDisabled={!!!vote}
      isLoading={castVote.isPending}
      onClick={() => castVote.mutate()}
    >
      Vote
    </TxButton>
  )
}

export default VoteButton
