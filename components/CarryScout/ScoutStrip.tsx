// "New this week" — the top 3 NEW rows of the weekly carry scout, mounted on /carry right
// after the route board. A link, not a recommendation: the numbers are the spread measured
// at the last scan, and Membrane carry is a ceiling until a curator sets its share.
// The venue APY opens its sources on hover, focus or tap (./ApySources.tsx).

import React from 'react'
import { Box, HStack, Text } from '@chakra-ui/react'
import { useQuery } from '@tanstack/react-query'
import NextLink from 'next/link'

import { Eyebrow } from '@/components/Carry/atoms'
import { ClassTag } from '@/components/NetApy/BreakdownRows'
import { Card } from '@/components/ui/Card'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { useChainRoute } from '@/hooks/useChainRoute'
import { formatCarryB, pct, spread } from '@/lib/carryScan/format'
import { NOT_DEPLOYABLE_LABEL } from '@/lib/carryScan/readiness'
import type { StripPayload } from '@/lib/carryScan/strip'

import { ApySources, methodTag, RAISE_WHEN_OPEN } from './ApySources'
import { NOT_DEPLOYABLE_FILTER } from './ScoutRow'

export const ScoutStrip: React.FC = () => {
  const { chainName } = useChainRoute()
  const q = useQuery<StripPayload>({
    queryKey: ['carry_scan_strip'],
    queryFn: async () => {
      const r = await fetch('/api/carry-scan?view=strip')
      if (!r.ok) throw new Error(`carry-scan ${r.status}`)
      return (await r.json()) as StripPayload
    },
    staleTime: 1000 * 60 * 30,
  })
  const d = q.data
  if (!d) return null
  const href = `/${chainName}/carry-scout`

  return (
    <Card variant="default" p={SPACING.base} mt={SPACING.base}>
      <HStack justify="space-between" align="baseline" flexWrap="wrap" spacing={SPACING.sm}>
        <Eyebrow>
          Carry scout · new this week · {d.week}
          {d.source === 'fallback' ? ' · snapshot' : ''}
        </Eyebrow>
        <NextLink href={href} style={{ textDecoration: 'underline' }}>
          <Text
            as="span"
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="11px"
            color={SEMANTIC_COLORS.textSecondary}
          >
            all {d.ranked} ranked →
          </Text>
        </NextLink>
      </HStack>
      {d.rows.length ? (
        <Box
          mt={SPACING.sm}
          display="grid"
          gridTemplateColumns="repeat(auto-fit, minmax(220px, 1fr))"
          gap={SPACING.sm}
        >
          {d.rows.map((r) => (
            <Box
              key={r.key ?? r.label}
              borderTop="1px solid"
              borderColor={SEMANTIC_COLORS.borderSubtle}
              pt={SPACING.xs}
              filter={r.notDeployable ? NOT_DEPLOYABLE_FILTER : undefined}
              sx={RAISE_WHEN_OPEN}
            >
              <Text
                fontFamily={TYPOGRAPHY.fontDisplay}
                fontSize="15px"
                color={SEMANTIC_COLORS.textPrimary}
              >
                {r.label}
              </Text>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="10.5px"
                color={SEMANTIC_COLORS.textSecondary}
              >
                {r.protocol} · {r.stable}
                {r.notDeployable ? ` · ${NOT_DEPLOYABLE_LABEL}` : ''}
              </Text>
              {r.venueApy && r.venueNet ? (
                // A payload cached before schema 2 has no venueApy: the line is left out.
                <Box
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize="11px"
                  color={SEMANTIC_COLORS.textSecondary}
                  sx={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  <Text as="span">venue @ $100K </Text>
                  <ApySources
                    venueApy={r.venueApy}
                    atSize={r.venueNet}
                    sizeUsd={100_000}
                    rowLabel={r.label}
                  >
                    <Text as="span" color={SEMANTIC_COLORS.textPrimary}>
                      {r.venueNet.apy === null ? (r.venueNet.note ?? '—') : pct(r.venueNet.apy)}
                    </Text>{' '}
                    <Text as="span" fontSize="9.5px" color={SEMANTIC_COLORS.textTertiary}>
                      {methodTag(r.venueApy)}
                    </Text>
                  </ApySources>{' '}
                  <ClassTag c={r.venueNet.labelClass} />
                </Box>
              ) : null}
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="11px"
                color={SEMANTIC_COLORS.textPrimary}
                sx={{ fontVariantNumeric: 'tabular-nums' }}
              >
                (a) {spread(r.carryA?.apy)}
                {r.carryA ? (
                  <>
                    {' '}
                    <ClassTag c={r.carryA.labelClass} />
                  </>
                ) : null}{' '}
                · (b) {formatCarryB(r.carryB.base)} <ClassTag c={r.carryB.base.labelClass} />
              </Text>
            </Box>
          ))}
        </Box>
      ) : (
        <Text
          mt={SPACING.xs}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="11px"
          color={SEMANTIC_COLORS.textTertiary}
        >
          No new venues this week.
        </Text>
      )}
      <Text
        mt={SPACING.xs}
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="9.5px"
        color={SEMANTIC_COLORS.textTertiary}
      >
        Ethereum stables only · not exhaustive · spreads measured at the last scan, not a promise
        {d.banner ? ` · ${d.banner}` : ''}
      </Text>
    </Card>
  )
}

export default ScoutStrip
