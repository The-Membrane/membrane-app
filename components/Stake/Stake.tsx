import Governance from '@/components/Governance'
import { HStack, Stack, Text } from '@chakra-ui/react'
import ManageStake from './ManageStake'
import Delegate from '@/components/Governance/Delegate'
import React from "react"

const Stake = React.memo(() => {
  return (
    <HStack gap="5" w="full" alignItems="flex-start">
      <Stack w="full" gap="5">
        <Text variant="title">Governance</Text>
        <ManageStake />
        <Delegate />
        <AuctionClaim />
      </Stack>
      <Governance />
    </HStack>
  )
})

export default Stake
