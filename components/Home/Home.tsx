import { Grid, GridItem, HStack, Stack } from '@chakra-ui/react'
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
      <Grid
      h='200px'
      templateRows='repeat(1, 1fr)'
      templateColumns='repeat(3, 1fr)'
      gap={4}
    >
        <GridItem colSpan={1} h='10'> 
        <Stack >
          {range(0, MAX_CDP_POSITIONS).map((index) => <PerformanceStats key={index} positionIndex={index} />)}          
        </Stack>
        </GridItem>
        <GridItem colSpan={1} h='10' > 
          <QuickActionWidget />
        </GridItem>
        </Grid>
    </Stack>
  )
})

export default Home
