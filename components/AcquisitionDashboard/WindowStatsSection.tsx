import React from 'react'
import { VStack, Text, Grid, GridItem } from '@chakra-ui/react'
import { SPACING } from '@/config/spacing'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { PRIMARY_PURPLE } from './constants'
import { StatCard } from './StatCard'
import type { AcquisitionDashboardData } from './hooks'

type WindowStats = NonNullable<AcquisitionDashboardData['windowStats']>

/* ── Current Window Stats Overview ── */
export const WindowStatsSection: React.FC<{ windowStats: WindowStats }> = ({ windowStats }) => (
  <VStack spacing={SPACING.md} align="stretch">
    <Text
      fontSize="sm"
      fontWeight="bold"
      color={PRIMARY_PURPLE}
      fontFamily="mono"
      letterSpacing="1px"
      textTransform="uppercase"
    >
      Current Acquisition Window
    </Text>
    <Grid
      templateColumns={{ base: '1fr', sm: 'repeat(2, 1fr)', lg: 'repeat(4, 1fr)' }}
      gap={SPACING.base}
    >
      <GridItem>
        <StatCard label="New Deposits" value={`${windowStats.totalDepositAmount} CDT`} />
      </GridItem>
      <GridItem>
        <StatCard label="Acquisition Budget" value={`${windowStats.acquisitionBudget} MBRN`} valueColor={SEMANTIC_COLORS.primary} />
      </GridItem>
      <GridItem>
        <StatCard label="Current Rate" value={`${windowStats.currentRate}/s`} />
      </GridItem>
      <GridItem>
        <StatCard label="Bump Rate" value={windowStats.bumpRate} valueColor={SEMANTIC_COLORS.warning} />
      </GridItem>
    </Grid>
    <Grid
      templateColumns={{ base: '1fr', sm: 'repeat(2, 1fr)' }}
      gap={SPACING.base}
    >
      <GridItem>
        <StatCard label="Accrued Pool" value={`${windowStats.accruedPool} MBRN`} valueColor={windowStats.poolMaxed ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.info} />
      </GridItem>
      <GridItem>
        <StatCard
          label="Efficiency"
          value={`${windowStats.efficiency}${windowStats.efficiencyClamped ? ' (clamped)' : ''}`}
          valueColor={windowStats.efficiencyClamped ? SEMANTIC_COLORS.warning : SEMANTIC_COLORS.info}
        />
      </GridItem>
    </Grid>
  </VStack>
)
