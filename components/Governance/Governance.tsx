import React from 'react'
import useProposals from './hooks/useProposals'
import { Box, Button, HStack, Stack, Text } from '@chakra-ui/react'
import ProposalsTable from './ProposalsTable'
import SubmitProposal from './SubmitProposal'

type Props = {}

const Governance = (props: Props) => {
  const { data } = useProposals()

  console.log({ data })
  return (
    <Stack w="full">
      <HStack justifyContent="space-between" w="full">
        <Text variant="title">Proposals</Text>
        <SubmitProposal />
      </HStack>

      <ProposalsTable />

      {/* <Stack>
        {data?.map((proposal) => (
          <HStack
            key={proposal.proposal_id}
            px="3"
            py="1"
            bg="whiteAlpha.200"
            borderRadius="lg"
            gap="4"
            // justifyContent="space-between"
          >
            <Badge bg={badgeColors[proposal.status]}>{proposal.status}</Badge>
            <Stack gap="0" m="none" p="none" flexGrow={1} pr="10">
              <Text noOfLines={1}>{proposal.title}</Text>
              <Text color="gray" fontSize="sm" noOfLines={1}>
                {proposal.description}
              </Text>
            </Stack>
            <Button minW="fit-content" w="fit-content" size="sm" fontSize="sm">
              View proposal
            </Button>
          </HStack>
        ))}
      </Stack> */}
    </Stack>
  )
}

export default Governance
