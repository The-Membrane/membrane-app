import { HStack, Stack, useBreakpointValue } from '@chakra-ui/react'
import BidAction from './BidAction'
import Filtration from './Filtration'
import Risk from './Risk'
import React from "react"

const Bid = React.memo(() => {
  const isMobile = useBreakpointValue({ base: true, md: false })
  return (
    <HStack spacing="5" alignItems="flex-start">
      <Stack gap="5" minW="435px">
        <Risk />
        <BidAction />
      </Stack>
      {!isMobile ? <Filtration /> : null}
    </HStack>
  )
})

export default Bid
