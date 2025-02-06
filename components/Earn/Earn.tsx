import { HStack, Stack, useBreakpointValue } from '@chakra-ui/react'
import React from "react"
import Deposit from './Deposit'
import RangeBoundLPCard from '../Home/RangeBoundLPCard'

// export const FOUR_WEEK_TREASURY_YIELD = 0.0529;

const Earn = React.memo(() => {
  const isMobile = useBreakpointValue({ base: true, md: false })
  return (
    <HStack display={"inline"}>
      <Deposit />
      <RangeBoundLPCard />
    </HStack>
  )
})

export default Earn
