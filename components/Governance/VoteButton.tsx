import { CheckIcon } from '@chakra-ui/icons'
import { Button } from '@chakra-ui/react'
import React from 'react'
import useCastVote from './hooks/useCastVote'
import { ProposalVoteOption } from '@/contracts/codegen/governance/Governance.types'
import { TxButton } from '@/components/TxButton'

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

  if (!show) return null
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
