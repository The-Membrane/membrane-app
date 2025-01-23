import { HStack, Stack, Text } from '@chakra-ui/react'
import ProposalsTable from './ProposalsTable'
import SubmitProposal from './SubmitProposal'
import React from "react"

const Governance = React.memo(() => {
  return (
    <Stack w="full">
      <HStack justifyContent="space-between" w="full">
        <Text variant="title">Proposals</Text>
        {/* <SubmitProposal /> */}
      </HStack>
      <ProposalsTable />
    </Stack>
  )
})

export default Governance
