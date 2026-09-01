import React from 'react'
import { VStack, Text, Grid, GridItem } from '@chakra-ui/react'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { PRIMARY_PURPLE } from './constants'
import { StatCard } from './StatCard'

/* ── Acquisition Metrics ── */
export const MetricsSection: React.FC<{
  acquisitionLoading: boolean
  totalDeposits: number
  depositorCount: number
}> = ({ acquisitionLoading, totalDeposits, depositorCount }) => (
  <VStack spacing={SPACING.md} align="stretch">
    <Text
      fontSize="sm"
      fontWeight="bold"
      color={PRIMARY_PURPLE}
      fontFamily="mono"
      letterSpacing="1px"
      textTransform="uppercase"
    >
      Acquisition Metrics
    </Text>
    <Grid
      templateColumns={{ base: '1fr', md: 'repeat(2, 1fr)' }}
      gap={SPACING_PATTERNS.sectionGap}
    >
      <GridItem>
        <StatCard
          label="Total Deposits"
          value={
            acquisitionLoading
              ? 'Loading...'
              : `${totalDeposits.toLocaleString(undefined, { maximumFractionDigits: 0 })} CDT`
          }
        />
      </GridItem>
      <GridItem>
        <StatCard
          label="Depositors"
          value={depositorCount.toString()}
          valueColor={PRIMARY_PURPLE}
        />
      </GridItem>
    </Grid>
  </VStack>
)
