import { ProposalResponse } from '@/services/governance'
import React, { Fragment } from 'react'
import RemoveButton from './RemoveButton'
import ExecuteButton from './ExecuteButton'
import VoteButton from './VoteButton'
import { ProposalVoteOption } from '@/contracts/codegen/governance/Governance.types'
import useWallet from '@/hooks/useWallet'
import { ConnectButton } from '@/components/WallectConnect'
import { HStack } from '@chakra-ui/react'
import EndProposalButton from './EndProposalButton'

type Props = {
  proposal: ProposalResponse
  isRemoveAllowed: boolean
  isExecuteAllowed: boolean
  isVoteAllowed: boolean
  isPending: boolean
  vote?: ProposalVoteOption | null
}

const ActionButtons = ({
  proposal,
  isExecuteAllowed,
  isRemoveAllowed,
  isVoteAllowed,
  isPending,
  vote,
}: Props) => {
  const { isWalletConnected, connect } = useWallet()

  const { days, hours, minutes } = proposal?.daysLeft || {}
  const isEnded = !days && !hours && !minutes

  if (!isWalletConnected) {
    return <ConnectButton w="200px" onClick={connect}/>
  }


  return (
    <Fragment>
      <RemoveButton show={isRemoveAllowed} proposalId={proposal.proposal_id} />
      <EndProposalButton show={isEnded && !isExecuteAllowed} proposalId={proposal.proposal_id} />
      <ExecuteButton show={isExecuteAllowed} proposalId={proposal.proposal_id} />
      <VoteButton
        show={isVoteAllowed || isPending}
        vote={vote}
        proposalId={proposal.proposal_id}
        isEnded={isEnded}
      />
    </Fragment>
  )
}

export default ActionButtons
