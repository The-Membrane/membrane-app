import React from 'react'
import useProposals from './hooks/useProposals'
import { Box, Button, HStack, Stack, Text } from '@chakra-ui/react'
import ProposalsTable from './ProposalsTable'
import SubmitProposal from './SubmitProposal'

const Governance = () => {
  return (
    <Stack w="full">
      <HStack justifyContent="space-between" w="full">
        <Text variant="title">Proposals</Text>
        <SubmitProposal />
      </HStack>
      <ProposalsTable />
    </Stack>
  )
}

export default Governance
