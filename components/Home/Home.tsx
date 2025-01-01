import { Button, Grid, GridItem, Text, Stack, useBreakpointValue } from '@chakra-ui/react'
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


// Memoize child components
const MemoizedRangeBoundVisual = React.memo(RangeBoundVisual)
const MemoizedRangeBoundLPCard = React.memo(RangeBoundLPCard)


interface CostRatio {
  symbol: string;
  rate: string;
  ratio: string;
}

interface VaultSummary {
  debtAmount: number;
  cost: number;
  discountedCost: number;
  tvl: number;
  ltv: number;
  borrowLTV: number;
  liquidValue: number;
  liqudationLTV: number;
  costRatios: CostRatio[];
}


interface PositionCostManagerProps {
  summary: VaultSummary;
  totalPositions?: number;
}

// Extract position cost logic to a separate component
const PositionCostManager = React.memo(({ summary, totalPositions }: PositionCostManagerProps) => {
  const toaster = useToaster()
  const { setMintState } = useMintState()
  const [positionNum, setPositionNum] = React.useState(1)

  const health = useMemo(() => {
    if (summary.ltv === 0) return 100
    return num(1)
      .minus(num(summary.ltv).dividedBy(summary.liqudationLTV))
      .times(100)
      .dp(0)
      .toNumber()
  }, [summary.ltv, summary.liqudationLTV])

  const ratesOverTen = useMemo(() => {
    return summary.costRatios.filter((rate) =>
      num(rate.rate).times(100).toNumber() >= 10
    )
  }, [summary.costRatios])

  useEffect(() => {
    if (summary.cost === 0 || !totalPositions || !summary.discountedCost) return

    const showToast = () => {
      toaster.message({
        title: `Position ${positionNum}`,
        message: (
          <>
            <Text>
              Health: <a style={health <= 10 ? { fontWeight: "bold", color: colors.alert } : {}}>
                {Math.min(health, 100)}%
              </a>
            </Text>
            <Text>
              Cost: <a style={num(summary.discountedCost).times(100).toNumber() >= 10 ?
                { fontWeight: "bold", color: colors.alert } : {}}>
                {num(summary.discountedCost).times(100).toFixed(2)}
              </a>%
            </Text>
            {ratesOverTen.length > 0 && (
              <>
                <Text style={{ marginTop: "5%" }}>Your Collateral Rates Over 10%:</Text>
                {ratesOverTen.map((rate) => (
                  <Text key={rate.symbol}>
                    {rate.symbol}: {num(rate.rate).times(100).toFixed(2)}%
                    ({num(rate.ratio).toFixed(2)}% of CDP)
                  </Text>
                ))}
              </>
            )}
          </>
        )
      })
    }

    showToast()

    if (positionNum < totalPositions) {
      setPositionNum(prev => prev + 1)
      setMintState({ positionNumber: positionNum + 1 })
    }
  }, [summary.discountedCost, totalPositions, positionNum, health, ratesOverTen])

  return null
})

PositionCostManager.displayName = 'PositionCostManager'


const Home = () => {
  const isMobile = useBreakpointValue({ base: true, md: false }) ?? false
  const { data: basketPositions } = useUserPositions()
  const { data: vaultSummary } = useVaultSummary()

  const totalPositions = useMemo(() => {
    if (!basketPositions) return undefined
    return Math.min(basketPositions[0].positions.length, MAX_CDP_POSITIONS)
  }, [basketPositions])

  const summary = useMemo(() => {
    return vaultSummary || {
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
  }, [vaultSummary])

  return (
    <Stack>
      <StatsCard />
      <Stack>
        <NeuroGuardCard />
        <Stack>
          <Text variant="title" fontFamily="Inter" fontSize="xl" letterSpacing="1px"
            display="flex" color={colors.earnText}>
            The Membrane
          </Text>
          <Stack direction={isMobile ? 'column' : 'row'} width="100%">
            <MemoizedRangeBoundVisual />
            <MemoizedRangeBoundLPCard />
          </Stack>
        </Stack>
      </Stack>
      <PositionCostManager summary={summary} totalPositions={totalPositions} />
    </Stack>
  )
}

export default React.memo(Home)