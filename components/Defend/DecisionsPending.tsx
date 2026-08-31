import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { Card } from '@/components/ui/Card'

import { SectionHeading } from './Primitives'

const strong = { fontWeight: 400 as const, color: SEMANTIC_COLORS.textPrimary }

const ITEMS: { head: string; body: string }[] = [
  {
    head: 'DIRECTION SET — two tiers:',
    body:
      ' on-chain winners are public policy (free, forkable, seed listings); offchain operator vaults carry the fees, because compute cost and unreadable models are the only durable moat. Remaining open: the exact split of what each tier may control.',
  },
  {
    head: 'Fee shape for operator vaults',
    body: ' (on-chain tier now feeless): ongoing vs performance — still open.',
  },
  { head: 'Bad-debt penalty coefficient', body: ' in the edge formula.' },
  { head: 'Runtime:', body: ' WASM preferred; languages supported.' },
  {
    head: 'Managed vaults at v1?',
    body:
      ' Each update invalidates the sim record; if offered, re-simulation before activation is mandatory.',
  },
  { head: 'Rebreach timer reset', body: ' — both variants simulated; one ships.' },
  {
    head: 'Anti-gaming:',
    body: ' rotating seed epochs and cooldowns proposed; not locked.',
  },
]

export const DecisionsPending: React.FC = () => (
  <>
    <SectionHeading index="08" title="Decisions pending — not resolved here" />
    <Card p={SPACING.base} display="grid">
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
          <Text as="span" fontFamily={TYPOGRAPHY.fontMono} color={SEMANTIC_COLORS.warning}>
            {i + 1}
          </Text>
          <Text as="span" fontFamily={TYPOGRAPHY.fontMono}>
            <Text as="b" {...strong}>
              {it.head}
            </Text>
            {it.body}
          </Text>
        </Box>
      ))}
    </Card>
  </>
)

export default DecisionsPending
