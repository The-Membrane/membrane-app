import { HStack, Stack, useBreakpointValue } from '@chakra-ui/react'
import React from "react"
import Deposit from './Deposit'

const Earn = React.memo(() => {
  const isMobile = useBreakpointValue({ base: true, md: false })
  return (
    <HStack spacing="5" alignItems="flex-start">
      <Stack gap="5" minW="435px">
        <Deposit />
      </Stack>
    </HStack>
  )
})

export default Earn
