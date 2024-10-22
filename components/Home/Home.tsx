import { Button, Grid, GridItem, Stack, useBreakpointValue } from '@chakra-ui/react'
import { StatsCard } from '../StatsCard'
import SPCard from './QASPCard'
import EarnCard from './QAEarnCard'

import React, { useState } from "react"
import { range } from 'lodash'
import { MAX_CDP_POSITIONS } from '@/config/defaults'
import PerformanceStats from './PerformanceStats'
import useWallet from '@/hooks/useWallet'

const Home = React.memo(() => {
  const isMobile = useBreakpointValue({ base: true, md: false }) ?? false

  return (
    <Stack>
      <Stack>
        <StatsCard />
      </Stack>
      <Stack direction={isMobile ? 'column' : 'row'} justifyContent="center"> 
        {/* autoSPVault Card */}
        <SPCard />
        {/* Earn Vault Card */}
        {/* <EarnCard /> */}
        {/* Peg is _? WID Card */}
      </Stack>
    </Stack>
  )
})

export default Home
