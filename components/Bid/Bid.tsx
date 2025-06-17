import { Box, VStack, HStack, useBreakpointValue, Button } from '@chakra-ui/react'
import BidAction from './BidAction'
import Risk from './Risk'
import React, { useState } from "react"
import QASPCard from '../Home/QASPCard'
import LiquidateButton from '../Nav/LiquidateButton'

const CheckLiquidations = () => {
  const [enabled, setEnabled] = useState(false)
  return (
    <Box mt={4} w="100%">
      {!enabled ? (
        <Box display="flex" justifyContent="center">
          <Button colorScheme="blue" onClick={() => setEnabled(true)}>
            Check for Liquidations
          </Button>
        </Box>
      ) : (
        <LiquidateButton enabled={enabled} setEnabled={setEnabled} />
      )}
    </Box>
  )
}

const Bid = React.memo(() => {
  const isMobile = useBreakpointValue({ base: true, md: false })
  return (
    <Box w="full" px={{ base: 2, md: 8 }} py={{ base: 4, md: 8 }}>
      <VStack align="stretch" spacing={8} w="full" maxW="1200px" mx="auto">
        <HStack spacing={8} alignItems="flex-start" w="full">
          <VStack gap={8} minW="435px" w={isMobile ? '100%' : '50%'} align="stretch">
            <Risk />
            <BidAction />
          </VStack>
          {!isMobile && (
            <Box w="50%">
              <QASPCard width="100%" title="Compounding Omni-Pool" />
              <CheckLiquidations />
            </Box>
          )}
        </HStack>
      </VStack>
    </Box>
  )
})

export default Bid
