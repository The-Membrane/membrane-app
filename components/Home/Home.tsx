import { HStack, Stack } from '@chakra-ui/react'
import { StatsCard } from '../StatsCard'
import QuickActionWidget from './QuickActionWidget'

import React from "react"
import { range } from 'lodash'
import { MAX_CDP_POSITIONS } from '@/config/defaults'
import PerformanceStats from './PerformanceStats'

const Home = React.memo(() => {
  return (
    <Stack >
      <StatsCard />
      <HStack>
        {range(0, MAX_CDP_POSITIONS).map((index) => <PerformanceStats key={index} positionIndex={index} />)}
        <QuickActionWidget />
      </HStack>
    </Stack>
  )
})

export default Home
