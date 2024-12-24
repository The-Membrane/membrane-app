import { Button, Grid, GridItem, Text, Stack, useBreakpointValue } from '@chakra-ui/react'
import { StatsCard } from '../StatsCard'
import SPCard from './QASPCard'
import EarnCard from './QAEarnCard'

import React, { useEffect, useMemo, useState } from "react"
import RangeBoundLPCard from './RangeBoundLPCard'
import RangeBoundVisual from './RangeBoundVisual'
import { FaArrowDown, FaArrowUp } from 'react-icons/fa6'
import useVaultSummary from '../Mint/hooks/useVaultSummary'
import { MAX_CDP_POSITIONS } from '@/config/defaults'
import { useUserPositions } from '@/hooks/useCDP'
import useToaster from '@/hooks/useToaster'
import { num } from '@/helpers/num'
import useMintState from '../Mint/hooks/useMintState'
import NeuroGuardCard from './NeuroGuardCard'


const Home = React.memo(() => {
  const isMobile = useBreakpointValue({ base: true, md: false }) ?? false
  const [sign, setSign] = useState("on");
  const [isExpanded, setIsExpanded] = useState(false)
  const onExpansion = () => {
    setIsExpanded(!isExpanded)
  }

  
  ////Setting up the Toaster for all position Costs////
  const toaster = useToaster()
  const { data: basketPositions } = useUserPositions()
  
  const { setMintState } = useMintState()
  const [positionNum, setPositionNum] = useState(0)
  const totalPositions = useMemo(() => {
    if (!basketPositions) return undefined
    return Math.min(basketPositions[0].positions.length - 1, MAX_CDP_POSITIONS)
  }, [basketPositions])  
  //Memoize 
  const { data } = useVaultSummary()
  const summary = useMemo(() => {
    return data || {
      debtAmount: 0,
      cost: 0,
      discountedCost: 0,
      tvl: 0,
      ltv: 0,
      borrowLTV: 0,
      liquidValue: 0,
      liqudationLTV: 0,
      costRatios: []
    }
  }, [data])
  
  const currentPositionCost = useMemo(() => {
    return summary.discountedCost
  }, [summary.discountedCost])
  const ratesOverTen = useMemo(() => {
    //Find any rate costs Over 10%
    return summary.costRatios.filter((rate: any) => {
      return num(rate.rate).times(100).toNumber() >= 10
    })
  }, [summary.costRatios])
  const health = useMemo(() => {
    if (summary.ltv === 0) return 100
    return num(1).minus(num(summary.ltv).dividedBy(summary.liqudationLTV)).times(100).dp(0).toNumber()
  }, [summary.ltv, summary.liqudationLTV])
  useEffect(() => {
    if (summary.cost != 0 && totalPositions != undefined && currentPositionCost != undefined) {
      // console.log("costy")
      //Toast
      toaster.message({
        title: `Position ${positionNum+1}`,
        message: <><Text>Health: <a style={health <= 10 ? {fontWeight:"bold", color:"rgb(231, 58, 58)"} : {}}>{Math.min(health, 100)}%</a></Text>
        <Text>Cost: <a style={num(currentPositionCost).times(100).toNumber() >= 10 ? {fontWeight:"bold", color:"rgb(231, 58, 58)"} : {}}>{num(currentPositionCost).times(100).toFixed(2)}</a>%</Text>
        
        {ratesOverTen.length > 0 ? <>
          <Text style={{marginTop:"5%"}}>{`\n`}Your Collateral Rates Over 10%:</Text>
          {ratesOverTen.map((rate: any) => {
            return <Text key={rate.symbol}>{rate.symbol}: {num(rate.rate).times(100).toFixed(2)}% ({num(rate.ratio).toFixed(2)}% of CDP)</Text>
          })}
        </> : null}
        </>
      })
      //Go to next position
      if (positionNum < totalPositions) {
        setPositionNum(positionNum + 1)
        setMintState({ positionNumber: positionNum + 1 })
      }
    } console.log("why costy", currentPositionCost)
    // else console.log("no costy", summary.cost, totalPositions, currentPositionCost)
  }, [currentPositionCost])
  
  
  
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
        <NeuroGuardCard />
        <Stack >          
          <Stack direction={isMobile ? 'column' : 'row'} width="100%" marginBottom={isExpanded ? "3vh" : "0"}>  
            <RangeBoundVisual />          
            <RangeBoundLPCard />  
          </Stack>
          {/* <Stack >
            <Stack direction={isMobile ? 'column' : 'row'} justifyContent="center">
              {isExpanded ? <>
                <SPCard />
                <EarnCard /> 
              </> : null }    
            </Stack>
            <Button 
              variant="ghost" 
              width={"fit-content"} 
              padding={"16px"} 
              alignSelf={"center"}
              margin={"2%"}
              rightIcon={!isExpanded ? <FaArrowDown /> : undefined} 
              leftIcon={isExpanded ? <FaArrowUp /> : undefined}
              onClick={onExpansion} 
            > {!isExpanded ? "More" : "Less"} Vaults </Button>
          </Stack>       */}
        </Stack>
      </Stack>
    </Stack>
  )
})

export default Home