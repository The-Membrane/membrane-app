import Governance from '@/components/Governance'
import { Box, VStack, Heading, useBreakpointValue } from '@chakra-ui/react'
import ManageStake from './ManageStake'
import Delegate from '@/components/Governance/Delegate'
import React from "react"
import AuctionClaim from './AuctionClaim'

const Stake = React.memo(() => {  
  const isMobile = useBreakpointValue({ base: true, md: false })
  
  return (
    <Box w="full" px={{ base: 2, md: 8 }} py={{ base: 4, md: 8 }}>
      <VStack
        align="stretch"
        spacing={8}
        w="full"
        maxW="1200px"
        mx="auto"
      >
        <Heading as="h1" size="lg" color="white" fontWeight="bold" mb={2}>
          Governance
        </Heading>
        <ManageStake />
        {!isMobile && (
          <Box>
            <Delegate />
            {/* <AuctionClaim /> */}
          </Box>
        )}
        <Box>
          <Governance />
        </Box>
      </VStack>
    </Box>
  )
})

export default Stake
