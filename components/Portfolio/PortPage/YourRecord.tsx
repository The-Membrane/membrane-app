import React from 'react'
import { Box, Grid, Text } from '@chakra-ui/react'
import NextLink from 'next/link'

import { Card } from '@/components/ui/Card'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { DemoBanner } from '@/components/demo'
import useDemoMode from '@/hooks/useDemoMode'
import { useChainRoute } from '@/hooks/useChainRoute'
import { ENCOUNTERS } from '@/components/Position/fixtures'
import { renderEmphasis } from '@/components/Position/utils'

import { usePositionEvents, PositionEvent } from './hooks/usePositionEvents'

/**
 * "Your record" — the retrospective leads the Portfolio page (Badass rule 2:
 * retrospective before prospective; rule 3: rescues render with attribution).
 *
 * States:
 *  - demo (no wallet): the fixture encounters render under DemoBanner as
 *    perceptual exposure (rule 6) — clearly not yours.
 *  - connected, no events: honest empty state pointing at the practice
 *    surfaces; nothing is fabricated.
 *  - connected, events: real events from usePositionEvents. Redemption events
 *    render "debt −$X · collateral untouched" as numbers, not prose.
 */

interface RecordRow {
  when: string
  bad: boolean
  title: string
  body: string
  stamp: string
  debtDeltaUsd?: number
  collateralDeltaUsd?: 0
}

const Row: React.FC<{ row: RecordRow; last: boolean }> = ({ row, last }) => (
  <Grid
    gridTemplateColumns={{ base: '1fr', md: '118px 1fr' }}
    gap={{ base: SPACING.xs, md: SPACING.base }}
    py={SPACING.md}
    borderBottom={last ? 'none' : '1px solid'}
    borderColor={SEMANTIC_COLORS.borderSubtle}
  >
    <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" letterSpacing="0.16em" textTransform="uppercase" color={SEMANTIC_COLORS.textTertiary}>
      {row.when}
    </Text>
    <Box>
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="13px" color={row.bad ? SEMANTIC_COLORS.warning : SEMANTIC_COLORS.textPrimary}>
        {row.title}
      </Text>
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11.5px" color={SEMANTIC_COLORS.textSecondary} mt="4px" lineHeight={1.65}>
        {renderEmphasis(row.body)}
      </Text>
      {row.debtDeltaUsd !== undefined && (
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11.5px" mt="4px">
          <Text as="span" color={SEMANTIC_COLORS.warning}>
            debt −${Math.abs(row.debtDeltaUsd).toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </Text>
          <Text as="span" color={SEMANTIC_COLORS.textSecondary}> · </Text>
          <Text as="span" color={SEMANTIC_COLORS.success}>
            collateral untouched −$0
          </Text>
        </Text>
      )}
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9.5px" color={SEMANTIC_COLORS.textTertiary} mt="6px">
        {row.stamp}
      </Text>
    </Box>
  </Grid>
)

const toRow = (e: PositionEvent): RecordRow => ({
  when: e.when,
  bad: e.bad,
  title: e.title,
  body: e.body,
  stamp: e.stamp,
  debtDeltaUsd: e.kind === 'redemption' ? e.debtDeltaUsd : undefined,
  collateralDeltaUsd: e.kind === 'redemption' ? 0 : undefined,
})

export const YourRecord: React.FC = () => {
  const { isDemo } = useDemoMode()
  const { chainName } = useChainRoute()
  const { data: events } = usePositionEvents()

  const rows: RecordRow[] = isDemo ? ENCOUNTERS : (events ?? []).map(toRow)

  return (
    <Box>
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.label}
        textTransform="uppercase"
        letterSpacing="0.28em"
        color={SEMANTIC_COLORS.textSecondary}
        mb={SPACING.sm}
      >
        01 / Your record
      </Text>
      {isDemo && <DemoBanner note="connect a wallet to see your own record" />}
      {rows.length > 0 ? (
        <Card>
          <Box>
            {rows.map((row, i) => (
              <Row key={i} row={row} last={i === rows.length - 1} />
            ))}
          </Box>
        </Card>
      ) : (
        <Card>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11.5px" color={SEMANTIC_COLORS.textSecondary} lineHeight={1.65}>
            No recorded events yet — your record starts with your first position. Until then the
            reps are in the{' '}
            <NextLink href={`/${chainName}`} style={{ textDecoration: 'underline' }}>
              cohort archive
            </NextLink>{' '}
            and the{' '}
            <NextLink href={`/${chainName}/builder`} style={{ textDecoration: 'underline' }}>
              gauntlet
            </NextLink>
            .
          </Text>
        </Card>
      )}
    </Box>
  )
}

export default YourRecord
