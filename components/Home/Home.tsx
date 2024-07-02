import { Grid, GridItem, Stack, useBreakpointValue } from '@chakra-ui/react'
import { StatsCard } from '../StatsCard'
import QuickActionWidget from './QuickActionWidget'

import React from "react"
import { range } from 'lodash'
import { MAX_CDP_POSITIONS } from '@/config/defaults'
import PerformanceStats from './PerformanceStats'
import useWallet from '@/hooks/useWallet'

const Home = React.memo(() => {
  const isMobile = useBreakpointValue({ base: true, md: false })
  const { isWalletConnected } = useWallet()
  return (
    <Stack >
      <StatsCard />
      <Grid      
      h='200px'
      //Mobile has 3 rows and 1 column, Desktop has 1 row and 3 columns
      templateRows={{base: 'repeat(3, 1fr)', md: 'repeat(1, 1fr)'}} 
      templateColumns={{base: 'repeat(1, 1fr)', md: 'repeat(3, 1fr)'}}
      gap={{base: 56, md: 4}}
    >
        {isWalletConnected && !isMobile ? <GridItem colSpan={{base: "auto", md: 1}} rowSpan={{base: 1, md: "auto"}} h='10'> 
        <Stack flexWrap="wrap" alignContent="center" >
          {range(0, MAX_CDP_POSITIONS).map((index) => <PerformanceStats key={index} positionIndex={index} />)}          
        </Stack>
        </GridItem> : null}
        <GridItem colSpan={{base: "auto", md: 1}} rowSpan={{base: 1, md: "auto"}} h='10' > 
          <QuickActionWidget />
        </GridItem>
        </Grid>
    </Stack>
  )
})

export default Home
