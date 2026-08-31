import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { Card } from '@/components/ui/Card'

import { SectionHeading, Stamp } from './Primitives'

const strong = { fontWeight: 400 as const, color: SEMANTIC_COLORS.textPrimary }

const ITEMS: { head: string; body: string }[] = [
  {
    head: 'Venue recalls are not modeled.',
    body:
      ' Live positions can pull deployed capital back to repay debt before collateral sells. The sim has no such lever, so live outcomes should beat sim outcomes in shallow breaches. If they do not, that is signal.',
  },
  {
    head: 'Sim edge is not live edge.',
    body:
      ' Calibration drifts from the moment it is measured. The vault chart above is the correction, updated as live data settles.',
  },
  {
    head: 'Rebreach timers are simulated both ways',
    body:
      ' — with and without reset — because the shipping behavior is an open decision. Your score shows both columns.',
  },
]

export const SimCannotSee: React.FC = () => (
  <>
    <SectionHeading index="06" title="What the sim cannot see" />
    <Card p={SPACING.base}>
      <Box display="grid">
        {ITEMS.map((it, i) => (
          <Box
            key={i}
            display="grid"
            gridTemplateColumns="26px 1fr"
            gap={SPACING.sm}
            py={SPACING.sm}
            borderBottom={i < ITEMS.length - 1 ? '1px solid' : undefined}
            borderColor={SEMANTIC_COLORS.borderSubtle}
            fontSize="11.5px"
            color={SEMANTIC_COLORS.textSecondary}
          >
            <Text as="span" color={SEMANTIC_COLORS.warning}>
              ●
            </Text>
            <Text as="span" fontFamily={TYPOGRAPHY.fontMono}>
              <Text as="b" {...strong}>
                {it.head}
              </Text>
              {it.body}
            </Text>
          </Box>
        ))}
      </Box>
      <Stamp>
        calibration: backtest v5 · 27 files · Chainlink rounds · 3,111 Aave + 886 Morpho liquidation
        events · protocol params at block 23,543,615 · USDe trade-level data · Curve depth
      </Stamp>
    </Card>
  </>
)

export default SimCannotSee
