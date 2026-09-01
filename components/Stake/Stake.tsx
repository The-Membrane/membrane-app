import Governance from '@/components/Governance'
import { Box, VStack, Heading, useBreakpointValue } from '@chakra-ui/react'
import ManageStake from './ManageStake'
import Delegate from '@/components/Governance/Delegate'
import React from "react"
import AuctionClaim from './AuctionClaim'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { SPACING } from '@/config/spacing'

const Stake = React.memo(function Stake() {
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
        <Heading
          as="h1"
          fontFamily={TYPOGRAPHY.fontDisplay}
          fontSize={TYPOGRAPHY.h1}
          color={SEMANTIC_COLORS.textPrimary}
          fontWeight={TYPOGRAPHY.bold}
          mb={SPACING.sm}
        >
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
