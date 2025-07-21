import { Box, VStack, Button, Stack } from '@chakra-ui/react'
import BidAction from './BidAction'
import Risk from './Risk'
import React, { useState } from "react"
import QASPCard from '../Home/QASPCard'
import LiquidateButton from '../Nav/LiquidateButton'

export const CheckLiquidations = () => {
  const [enabled, setEnabled] = useState(false)
  return (
    <Box mt={4} w="100%">
      {!enabled ? (
        <Box display="flex" justifyContent="center">
          <Button onClick={() => setEnabled(true)}>
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
  return (
    <Box w="full" px={{ base: 2, md: 8 }} py={{ base: 4, md: 8 }}>
      <VStack align="stretch" spacing={8} w="full" maxW="1200px" mx="auto">
        <Stack
          direction={{ base: 'column', md: 'row' }}
          spacing={8}
          alignItems="flex-start"
          w="full"
        >
          <VStack gap={8} minW={{ base: 'auto', md: '435px' }} w={{ base: '100%', md: '50%' }} align="stretch">
            <Risk />
            <BidAction />
          </VStack>
          <Box
            w={{ base: '100%', md: '50%' }}
            display={{ base: 'none', md: 'block' }}
          >
            <QASPCard width="100%" title="Compounding Omni-Pool" />
            <CheckLiquidations />
          </Box>
        </Stack>
      </VStack>
    </Box>
  )
})

export default Bid
