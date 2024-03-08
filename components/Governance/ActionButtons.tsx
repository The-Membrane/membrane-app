import { ProposalResponse } from '@/services/governance'
import React, { Fragment } from 'react'
import RemoveButton from './RemoveButton'
import ExecuteButton from './ExecuteButton'
import VoteButton from './VoteButton'
import { ProposalVoteOption } from '@/contracts/codegen/governance/Governance.types'
import useWallet from '@/hooks/useWallet'
import { ConnectButton } from '@/components/WallectConnect'

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
  const { isWalletConnected } = useWallet()

  if (!isWalletConnected) {
    return <ConnectButton w="200px" />
  }

  return (
    <Fragment>
      <RemoveButton show={isRemoveAllowed} proposalId={proposal.proposal_id} />
      <ExecuteButton show={isExecuteAllowed} proposalId={proposal.proposal_id} />
      <VoteButton show={isVoteAllowed || isPending} vote={vote} proposalId={proposal.proposal_id} />
    </Fragment>
  )
}

export default ActionButtons
