import { HStack, Stack, useBreakpointValue } from '@chakra-ui/react'
import BidAction from './BidAction'
import Risk from './Risk'
import React from "react"
import QASPCard from '../Home/QASPCard'

const Bid = React.memo(() => {
  // const isMobile = useBreakpointValue({ base: true, md: false })
  return (
    <HStack spacing="5" alignItems="flex-start">
      <Stack gap="5" minW="435px">
        <Risk />
        <BidAction />
      </Stack>
      <QASPCard width="100%" title='Compounding Omni-Pool'/>
    </HStack>
  )
})

export default Bid
