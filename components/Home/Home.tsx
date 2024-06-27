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
      //Mobile has 3 rows and 1 column, Desktop has 1 row and 3 columns
      templateRows={{base: 'repeat(3, 1fr)', md: 'repeat(1, 1fr)',}} 
      templateColumns={{base: 'repeat(1, 1fr)', md: 'repeat(3, 1fr)',}}
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
        <GridItem colSpan={1} h='10'> 
          {/* scatter collateral icons & hover to show symbol name */}
        </GridItem>
        </Grid>
    </Stack>
  )
})

export default Home
