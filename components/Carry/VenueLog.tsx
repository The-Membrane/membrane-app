import React from 'react'
import { Box, Grid, Text } from '@chakra-ui/react'
import { useQuery } from '@tanstack/react-query'
import NextLink from 'next/link'

import { Card } from '@/components/ui/Card'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { useChainRoute } from '@/hooks/useChainRoute'

import { SectionHeading, Stamp } from './atoms'
import { venueSlug } from './venueSlug'

/**
 * The venue state-change log — the "news tracker", rendered as consequences,
 * never headlines. Entries come from /api/venues/log: 'observed' rows are what
 * the hourly recorder witnessed; 'reconstructed' rows are discrete-param
 * transitions derived from archive snapshots. Terms-page text changes are
 * notices with unclassified exit impact, not verified withdrawal gate changes.
 */

import {
  Entry,
  consequence,
  alarmConsequence,
  isTermsOnlyNotice,
  termsSourceUrl,
} from './venueLogLogic'

export const VenueLog: React.FC = () => {
  const { chainName } = useChainRoute()
  const { data } = useQuery<{ entries: Entry[]; uncovered_footer?: string }>({
    queryKey: ['venue_log'],
    queryFn: async () => {
      const r = await fetch('/api/venues/log')
      if (!r.ok) throw new Error(`venue log ${r.status}`)
      return r.json()
    },
    staleTime: 1000 * 60 * 5,
    // The app-wide default is refetchOnMount: false with a 24h gcTime — an
    // errored/empty first fetch would otherwise stick for the whole session.
    refetchOnMount: true,
  })

  const entries = data?.entries ?? []

  return (
    <Box>
      <SectionHeading
        index="06 /"
        title="What the venues changed"
        note="recorded venue changes and alerts · terms-page text changes have unclassified exit impact"
      />
      <Card p={SPACING.base}>
        {entries.length === 0 ? (
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="11.5px"
            color={SEMANTIC_COLORS.textSecondary}
          >
            Nothing yet — the recorder logs its first entry when a venue actually changes something.
          </Text>
        ) : (
          <Box>
            {entries.map((e, i) => {
              const isAlarm = e.provenance === 'alarm'
              const c = isAlarm ? alarmConsequence(e) : consequence(e)
              const sourceUrl = termsSourceUrl(e)
              const textColor = isAlarm
                ? c.tone === 'danger'
                  ? SEMANTIC_COLORS.danger
                  : c.tone === 'notice'
                    ? SEMANTIC_COLORS.info
                    : SEMANTIC_COLORS.textTertiary
                : c.tone === 'warning'
                  ? SEMANTIC_COLORS.warning
                  : SEMANTIC_COLORS.textPrimary
              return (
                <Grid
                  key={`${e.venue}-${e.at}-${e.kind}`}
                  templateColumns={{ base: '1fr', md: '150px 1fr 110px' }}
                  gap={SPACING.base}
                  py={SPACING.sm}
                  borderBottom={i === entries.length - 1 ? 'none' : '1px solid'}
                  borderColor={SEMANTIC_COLORS.borderSubtle}
                  alignItems="baseline"
                >
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize="10px"
                    letterSpacing="0.14em"
                    textTransform="uppercase"
                    color={SEMANTIC_COLORS.textTertiary}
                  >
                    {new Date(e.at).toISOString().slice(0, 10)} ·{' '}
                    {venueSlug(e.venue) ? (
                      <NextLink
                        href={`/${chainName}/venue/${venueSlug(e.venue)}`}
                        style={{ textDecoration: 'underline' }}
                      >
                        <Text as="span" _hover={{ color: SEMANTIC_COLORS.success }}>
                          {e.venue}
                        </Text>
                      </NextLink>
                    ) : (
                      e.venue
                    )}
                  </Text>
                  <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11.5px" color={textColor}>
                    {c.text}
                    {sourceUrl && (
                      <Text
                        as="a"
                        href={sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        ml={SPACING.sm}
                        textDecoration="underline"
                        color={SEMANTIC_COLORS.info}
                      >
                        source terms ↗
                      </Text>
                    )}
                  </Text>
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize="9px"
                    letterSpacing="0.14em"
                    textTransform="uppercase"
                    color={
                      isAlarm && c.tone === 'danger'
                        ? SEMANTIC_COLORS.danger
                        : isAlarm && c.tone === 'notice'
                          ? SEMANTIC_COLORS.info
                          : SEMANTIC_COLORS.textTertiary
                    }
                    textAlign={{ base: 'left', md: 'right' }}
                  >
                    {isTermsOnlyNotice(e) ? 'notice' : e.provenance}
                  </Text>
                </Grid>
              )
            })}
          </Box>
        )}
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="10px"
          color={SEMANTIC_COLORS.textTertiary}
          mt={SPACING.sm}
          fontStyle="italic"
        >
          {/* per-venue blind spots from the ONE source (alarmRules.mjs coverageFor) */}
          {data?.uncovered_footer ?? 'blind spots unknown: coverage not loaded'}
        </Text>
        <Stamp>
          observed = witnessed live by the hourly recorder · reconstructed = derived from archive
          state; real transitions the recorder was not yet running to see · alarm = recorded alert;
          a terms-only alert is an unclassified page-text notice · withdrawn historical flow alerts
          appear muted
        </Stamp>
      </Card>
    </Box>
  )
}

export default VenueLog
