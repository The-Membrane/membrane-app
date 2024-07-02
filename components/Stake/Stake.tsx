import Governance from '@/components/Governance'
import { HStack, Stack, Text, useBreakpointValue } from '@chakra-ui/react'
import ManageStake from './ManageStake'
import Delegate from '@/components/Governance/Delegate'
import React from "react"
import AuctionClaim from './AuctionClaim'

const Stake = React.memo(() => {  
  const isMobile = useBreakpointValue({ base: true, md: false })
  
  return (
    <Stack direction={{base: "column", md: "row"}} gap="5" w="full" alignItems="flex-start">
      <Stack w="full" gap="5">
        <Text variant="title">Governance</Text>
        <ManageStake />
        {!isMobile ? <>
        <Delegate />
        <AuctionClaim />
        </>
      : null}
      </Stack>
      <Governance />
    </Stack>
  )
})

export default Stake
