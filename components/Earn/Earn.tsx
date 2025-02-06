import { HStack, Stack, useBreakpointValue } from '@chakra-ui/react'
import React from "react"
import Deposit from './Deposit'

// export const FOUR_WEEK_TREASURY_YIELD = 0.0529;

const Earn = React.memo(() => {
  return (
    <HStack display={"inline"}>
      <Deposit />
    </HStack>
  )
})

export default Earn
