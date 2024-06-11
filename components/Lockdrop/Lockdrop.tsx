import { HStack, Stack } from '@chakra-ui/react'
import Info from './Info'
import LockChart from './LockChart'
import LoackdropPane from './LockdropPane'
import TokenAllocation from '@/components/Lockdrop/TokenAllocation'
import React from "react"

const Lockdrop = React.memo(() => {
  return (
    <Stack gap="5">
      <Info />
      <LockChart />
      {/* <LoackdropPane /> */}
      <TokenAllocation />
    </Stack>
  )
})

export default Lockdrop
