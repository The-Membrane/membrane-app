import React, { useMemo } from 'react'
import { Box, SimpleGrid, Text, HStack, Badge } from '@chakra-ui/react'
import { SPACING } from '@/config/spacing'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { Card } from '@/components/ui/Card'
import type { SimTick, SimPhase } from './engine/types'

const PHASE_BADGE_COLORS: Record<SimPhase, string> = {
  awaiting: 'gray',
  deposit: 'cyan',
  withdrawal: 'yellow',
  'post-withdrawal': 'purple',
  cliff: 'gray',
}

const PHASE_LABELS: Record<SimPhase, string> = {
  awaiting: 'Awaiting',
  deposit: 'Deposit',
  withdrawal: 'Withdrawal',
  'post-withdrawal': 'Post-Withdrawal',
  cliff: 'Cliff',
}

function formatCompact(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toFixed(2)
}

interface SimStateCardsProps {
  ticks: SimTick[]
  cursorDay: number | null
}

export const SimStateCards: React.FC<SimStateCardsProps> = ({
  ticks,
  cursorDay,
}) => {
  const tick = useMemo(() => {
    if (ticks.length === 0) return null
    if (cursorDay === null) return ticks[ticks.length - 1]

    // Find closest tick to cursor
    let closest = ticks[0]
    let minDist = Math.abs(ticks[0].day - cursorDay)
    for (let i = 1; i < ticks.length; i++) {
      const dist = Math.abs(ticks[i].day - cursorDay)
      if (dist < minDist) {
        minDist = dist
        closest = ticks[i]
      }
    }
    return closest
  }, [ticks, cursorDay])

  if (!tick) return null

  const cards = [
    {
      label: 'PHASE',
      value: (
        <Badge
          colorScheme={PHASE_BADGE_COLORS[tick.phase]}
          fontSize={TYPOGRAPHY.small}
          px={SPACING.sm}
          py={SPACING.xs}
          borderRadius="6px"
        >
          {PHASE_LABELS[tick.phase]}
        </Badge>
      ),
      sub: `Day ${tick.day.toFixed(1)}`,
    },
    {
      label: 'POOL',
      value: `${formatCompact(tick.accruedPool)} uMBRN`,
      sub: tick.poolMaxed ? 'MAXED' : tick.isAccruing ? 'Accruing' : 'Paused',
      subColor: tick.poolMaxed
        ? SEMANTIC_COLORS.warning
        : tick.isAccruing
          ? SEMANTIC_COLORS.success
          : SEMANTIC_COLORS.textTertiary,
    },
    {
      label: 'RATE',
      value: `${tick.currentRate.toFixed(2)} /sec`,
      sub: `${formatCompact(tick.currentRate * 86400)} /day`,
    },
    {
      label: 'UTILIZATION',
      value: `${(tick.utilization * 100).toFixed(1)}%`,
      sub: tick.isAccruing ? 'Above target' : 'Below target',
      subColor: tick.isAccruing
        ? SEMANTIC_COLORS.success
        : SEMANTIC_COLORS.warning,
    },
    {
      label: 'BUMP RATE',
      value: `${(tick.bumpRate * 100).toFixed(2)}%`,
      sub: `CDP +${(tick.cdpRateImpact * 100).toFixed(2)}%`,
      subColor:
        tick.cdpRateImpact > 0.01
          ? SEMANTIC_COLORS.warning
          : SEMANTIC_COLORS.textTertiary,
    },
    {
      label: 'EFFICIENCY',
      value: tick.efficiency > 0 ? tick.efficiency.toFixed(2) : '—',
      sub: tick.efficiencyClamped
        ? `Budget: ${formatCompact(tick.acquisitionBudget ?? 0)}`
        : `Deposits: ${formatCompact(tick.totalGrossDeposits)}`,
      subColor: tick.efficiencyClamped
        ? SEMANTIC_COLORS.danger
        : SEMANTIC_COLORS.textSecondary,
    },
  ]

  return (
    <SimpleGrid columns={{ base: 2, sm: 3, lg: 6 }} spacing={SPACING.md}>
      {cards.map((card) => (
        <Card key={card.label} variant="subtle" p={SPACING.md}>
          <Text
            fontSize={TYPOGRAPHY.label}
            textTransform="uppercase"
            color={SEMANTIC_COLORS.textTertiary}
            mb={SPACING.xs}
          >
            {card.label}
          </Text>
          {typeof card.value === 'string' ? (
            <Text
              fontSize={TYPOGRAPHY.h4}
              fontWeight={TYPOGRAPHY.semibold}
              color={SEMANTIC_COLORS.textPrimary}
            >
              {card.value}
            </Text>
          ) : (
            card.value
          )}
          <Text
            fontSize={TYPOGRAPHY.xs}
            color={card.subColor ?? SEMANTIC_COLORS.textSecondary}
            mt={SPACING.xs}
          >
            {card.sub}
          </Text>
        </Card>
      ))}
    </SimpleGrid>
  )
}
