import { Button, Grid, GridItem, Stack, useBreakpointValue } from '@chakra-ui/react'
import { StatsCard } from '../StatsCard'
import SPCard from './QASPCard'
import EarnCard from './QAEarnCard'
import LPCard from './QALPCard'

import React, { useEffect, useState } from "react"
import CDTSwapSliderCard from './CDTSwapSlider'
import RangeBoundLPCard from './RangeBoundLPCard'
import RangeBoundVisual from './RangeBoundVisual'


const Home = React.memo(() => {
  const isMobile = useBreakpointValue({ base: true, md: false }) ?? false
  const [sign, setSign] = React.useState("on");
  
  return (
    <Stack>
      <Stack>
        <StatsCard />
      </Stack>
      <Stack>
        <div className="paddingBottom" onMouseEnter={()=>{setSign("on")}} onMouseLeave={()=>{setSign("on")}}>
          <h5 className={`neonSign${sign}`}>
            <b>
              <a>E</a><span>X</span><a>P</a><span>E</span><a>R</a><span>I</span><a>M</a><span>E</span><a>N</a><span>T</span><a>A</a><span>L</span>
              &nbsp;
              <a>V</a><span>A</span><a>U</a><span>L</span><a>T</a><span>S</span>
            </b>
          </h5>
        </div>
        {/* CDT Swap Card */}
        {/* <CDTSwapSliderCard /> */}
        <Stack direction={'row'}>          
          <RangeBoundVisual />          
          {/* RangeBoundLP Card */}
          <RangeBoundLPCard />
          <Stack direction={'row'} justifyContent="center"> 
            {/* autoSPVault Card */}
            <SPCard />
            {/* Earn Vault Card */}
            <EarnCard />
          </Stack>      
        </Stack>
      </Stack>
    </Stack>
  )
})

export default Home
