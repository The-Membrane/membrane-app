import { Button, Grid, GridItem, Text, Stack, useBreakpointValue, Checkbox } from '@chakra-ui/react'
import { StatsCard } from '../StatsCard'
import SPCard from './QASPCard'
import EarnCard from './QAEarnCard'

import React, { useEffect, useMemo, useState } from "react"
import RangeBoundLPCard from './RangeBoundLPCard'
import RangeBoundVisual from './RangeBoundVisual'
import { FaArrowDown, FaArrowUp } from 'react-icons/fa6'
import useVaultSummary from '../Mint/hooks/useVaultSummary'
import { colors, MAX_CDP_POSITIONS } from '@/config/defaults'
import { useUserPositions } from '@/hooks/useCDP'
import useToaster from '@/hooks/useToaster'
import { num } from '@/helpers/num'
import useMintState from '../Mint/hooks/useMintState'
import NeuroGuardCard from './NeuroGuardCard'
import { useUserBoundedIntents } from '../Earn/hooks/useEarnQueries'
import useNeuroState from './hooks/useNeuroState'


// Memoize child components
// const MemoizedRangeBoundVisual = React.memo(RangeBoundVisual)
// const MemoizedRangeBoundLPCard = React.memo(RangeBoundLPCard)
const MemoizedNeuroGuardCard = React.memo(NeuroGuardCard)

// interface CostRatio {
//   symbol: string;
//   rate: string;
//   ratio: string;
// }

// interface VaultSummary {
//   debtAmount: number;
//   cost: number;
//   discountedCost: number;
//   tvl: number;
//   ltv: number;
//   borrowLTV: number;
//   liquidValue: number;
//   liqudationLTV: number;
//   costRatios: CostRatio[];
//   positionId: string
// }


// interface PositionCostManagerProps {
//   summary: VaultSummary;
//   totalPositions?: number;
//   neuroGuards: {
//     desired_asset: string;
//     route: any | undefined;
//     yield_percent: string;
//     position_id: number | undefined;
//     slippage: string | undefined;
//   }[];
// }

// // Extract position cost logic to a separate component
// const PositionCostManager = React.memo(({ summary, totalPositions, neuroGuards }: PositionCostManagerProps) => {
//   const toaster = useToaster()
//   const { mintState, setMintState } = useMintState()
//   const [positionNum, setPositionNum] = React.useState(1)

//   const health = useMemo(() => {
//     if (summary.ltv === 0) return 100
//     return num(1)
//       .minus(num(summary.ltv).dividedBy(summary.liqudationLTV))
//       .times(100)
//       .dp(0)
//       .toNumber()
//   }, [summary.ltv, summary.liqudationLTV])

//   const ratesOverTen = useMemo(() => {
//     return summary.costRatios.filter((rate) =>
//       num(rate.rate).times(100).toNumber() >= 10
//     )
//   }, [summary.costRatios])

//   console.log("neuroGuards", neuroGuards)

//   useEffect(() => {
//     if (summary.cost === 0 || neuroGuards.find((guard) => (guard?.position_id ?? 1).toString() === summary.positionId) != undefined || !totalPositions || !summary.discountedCost || mintState.alreadyToasted) return

//     const showToast = () => {
//       toaster.message({
//         title: `Position ${positionNum}`,
//         message: (
//           <>
//             <Text>
//               Health: <a style={health <= 10 ? { fontWeight: "bold", color: colors.alert } : {}}>
//                 {Math.min(health, 100)}%
//               </a>
//             </Text>
//             <Text>
//               Cost: <a style={num(summary.discountedCost).times(100).toNumber() >= 10 ?
//                 { fontWeight: "bold", color: colors.alert } : {}}>
//                 {num(summary.discountedCost).times(100).toFixed(2)}
//               </a>%
//             </Text>
//             {ratesOverTen.length > 0 && (
//               <>
//                 <Text style={{ marginTop: "5%" }}>Your Collateral Rates Over 10%:</Text>
//                 {ratesOverTen.map((rate) => (
//                   <Text key={rate.symbol}>
//                     {rate.symbol}: {num(rate.rate).times(100).toFixed(2)}%
//                     ({num(rate.ratio).toFixed(2)}% of CDP)
//                   </Text>
//                 ))}
//               </>
//             )}
//           </>
//         )
//       })
//     }

//     showToast()

//     if (positionNum < totalPositions) {
//       setPositionNum(prev => prev + 1)
//       setMintState({ positionNumber: positionNum + 1 })
//     } else {
//       console.log("Already toasted")
//       setMintState({ alreadyToasted: true })
//     }
//   }, [summary.discountedCost, totalPositions, positionNum, health, ratesOverTen])

//   return null
// })

// PositionCostManager.displayName = 'PositionCostManager'


const Home = () => {
  const { neuroState, setNeuroState } = useNeuroState()
  const [hasShownToast, setHasShownToast] = useState(false);
  const toaster = useToaster()
  // Function to handle cookie checkbox toggle
  const handleToggle = (event) => {
    setNeuroState({ setCookie: event.target.checked });
    console.log("setCookie", event.target.checked)
  };
  const showToast = () => {
    toaster.message({
      title: `Accept Cookies`,
      message: (
        <>
          <Checkbox
            checked={neuroState?.setCookie}
            onChange={handleToggle}
            fontFamily="Inter">
            Accept cookies to track profits
          </Checkbox>
        </>
      ), duration: null
    }
    )
  }
  useEffect(() => {
    // Only show toast if it hasn't been shown before
    if (!hasShownToast) {
      showToast();
      setHasShownToast(true);
    }
  }, []); // Empty dependency array means this runs once on mount
  // const isMobile = useBreakpointValue({ base: true, md: false }) ?? false
  // const { data: basketPositions } = useUserPositions()
  // const { data: vaultSummary } = useVaultSummary()
  // const { data: userIntents } = useUserBoundedIntents()

  //Iterate thru intents and find all intents that are for NeuroGuard (i.e. have a position ID)
  // const neuroGuardIntents = useMemo(() => {
  //   if (userIntents && userIntents[0] && userIntents[0].intent.intents.purchase_intents) {
  //     return userIntents[0].intent.intents.purchase_intents.filter((intent) => {
  //       return intent.position_id !== undefined
  //     })
  //   } else return []

  // }, [userIntents])

  // const totalPositions = useMemo(() => {
  //   if (!basketPositions) return undefined
  //   return Math.min(basketPositions[0].positions.length, MAX_CDP_POSITIONS)
  // }, [basketPositions])

  // const summary = useMemo(() => {
  //   return vaultSummary || {
  //     debtAmount: 0,
  //     cost: 0,
  //     discountedCost: 0,
  //     tvl: 0,
  //     ltv: 0,
  //     borrowLTV: 0,
  //     liquidValue: 0,
  //     liqudationLTV: 0,
  //     costRatios: [],
  //     positionId: "0"
  //   }
  // }, [vaultSummary])

  return (
    <Stack>
      <StatsCard />
      <Stack>
        <MemoizedNeuroGuardCard />
        {/* <Stack>
          <Text variant="title" textTransform={"capitalize"} fontFamily="Inter" fontSize="xl" letterSpacing="1px"
            display="flex" color={colors.earnText}>
            <a style={{ fontWeight: "bold", color: colors.rangeBoundBox }}>The Membrane: &nbsp;</a> Range Bound Liquidity Provision
          </Text>
          <Stack direction={isMobile ? 'column' : 'row'} width="100%">
            <MemoizedRangeBoundVisual />
            <MemoizedRangeBoundLPCard />
          </Stack>
        </Stack> */}
      </Stack>
      {/* <PositionCostManager summary={summary} totalPositions={totalPositions} neuroGuards={neuroGuardIntents} /> */}
    </Stack>
  )
}

export default React.memo(Home)