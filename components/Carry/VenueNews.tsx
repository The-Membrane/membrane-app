import React from 'react'
import { Box, Grid, HStack, Link, Text } from '@chakra-ui/react'
import { useQuery } from '@tanstack/react-query'

import { Card } from '@/components/ui/Card'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

import { SectionHeading, Stamp } from './atoms'

/**
 * VENUE NEWS — raw external headlines for the carry venues Membrane offers,
 * pulled from Google News RSS by scripts/fetch-venue-news.mjs and served by
 * /api/venues/news. This section is INFORMATION, not endorsement: it shows the
 * headline, its outlet and its date VERBATIM. We do NOT summarize, score, or run
 * any model over them — the words are the internet's, not ours.
 *
 * (X/Twitter search has no keyless API and is deferred to a later paid/API
 * decision, so v1 is NEWS-only.)
 *
 * Standalone section — the orchestrator (Carry.tsx) mounts it; this file does
 * not wire itself in.
 */

type VenueNewsItem = {
  venue: string
  title: string
  source: string
  url: string
  publishedAt: string | null
  fetchedAt: string
}

const fmtDate = (iso: string | null): string => (iso ? new Date(iso).toISOString().slice(0, 10) : '—')

const fmtStamp = (iso: string | undefined): string =>
  iso ? new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + 'Z' : 'never'

export const VenueNews: React.FC = () => {
  const { data } = useQuery<{ items: VenueNewsItem[] }>({
    queryKey: ['venue_news'],
    queryFn: async () => {
      const r = await fetch('/api/venues/news')
      if (!r.ok) throw new Error(`venue news ${r.status}`)
      return r.json()
    },
    staleTime: 1000 * 60 * 15,
    // The app-wide default is refetchOnMount: false with a 24h gcTime — an
    // errored/empty first fetch would otherwise stick for the whole session.
    refetchOnMount: true,
  })

  const items = data?.items ?? []

  // Venue chips derived from what the feed actually returned (stable order).
  const venues = React.useMemo(() => {
    const seen: string[] = []
    for (const it of items) if (!seen.includes(it.venue)) seen.push(it.venue)
    return seen
  }, [items])

  const [filter, setFilter] = React.useState<string | null>(null)
  const shown = filter ? items.filter((it) => it.venue === filter) : items

  // Newest fetch across the shown rows → the provenance timestamp.
  const lastFetched = shown.reduce<string | undefined>(
    (acc, it) => (!acc || it.fetchedAt > acc ? it.fetchedAt : acc),
    undefined,
  )

  return (
    <Box>
      <SectionHeading
        index="07 /"
        title="What's being said"
        note="raw headlines, newest first — information, not endorsement; we do not summarize or score"
      />
      <Card p={SPACING.base}>
        {venues.length > 0 && (
          <HStack spacing={SPACING.sm} flexWrap="wrap" mb={SPACING.base}>
            <Chip label="all" active={filter === null} onClick={() => setFilter(null)} />
            {venues.map((v) => (
              <Chip key={v} label={v} active={filter === v} onClick={() => setFilter(v)} />
            ))}
          </HStack>
        )}

        {shown.length === 0 ? (
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11.5px" color={SEMANTIC_COLORS.textSecondary}>
            Nothing yet — headlines appear once the news fetcher has run for these venues.
          </Text>
        ) : (
          <Box>
            {shown.map((it, i) => (
              <Grid
                key={`${it.venue}-${it.url}`}
                templateColumns={{ base: '1fr', md: '92px 130px 1fr' }}
                gap={SPACING.base}
                py={SPACING.sm}
                borderBottom={i === shown.length - 1 ? 'none' : '1px solid'}
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
                  {fmtDate(it.publishedAt)}
                </Text>
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize="10px"
                  letterSpacing="0.06em"
                  color={SEMANTIC_COLORS.textSecondary}
                  title={filter ? undefined : it.venue}
                >
                  {it.source}
                </Text>
                <Link
                  href={it.url}
                  isExternal
                  rel="noopener noreferrer"
                  target="_blank"
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize="11.5px"
                  color={SEMANTIC_COLORS.textPrimary}
                  transition={TRANSITIONS.colors}
                  _hover={{ color: SEMANTIC_COLORS.success, textDecoration: 'underline' }}
                  _focus={FOCUS_STYLES.ring}
                >
                  {it.title}
                </Link>
              </Grid>
            ))}
          </Box>
        )}

        <Stamp>
          Google News RSS · fetched {fmtStamp(lastFetched)} · membrane offers these venues; headlines
          are the internet&apos;s, not ours
        </Stamp>
      </Card>
    </Box>
  )
}

/** Small mono filter chip — hairline border, phosphor when active/hovered. */
const Chip: React.FC<{ label: string; active: boolean; onClick: () => void }> = ({ label, active, onClick }) => (
  <Box
    as="button"
    type="button"
    onClick={onClick}
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="9.5px"
    letterSpacing="0.14em"
    textTransform="uppercase"
    px="8px"
    py="2px"
    borderRadius={0}
    border="1px solid"
    borderColor={active ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.borderSubtle}
    color={active ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.textTertiary}
    bg="transparent"
    transition={TRANSITIONS.colors}
    _hover={{ color: SEMANTIC_COLORS.success, borderColor: SEMANTIC_COLORS.success }}
    _focus={FOCUS_STYLES.ring}
  >
    {label}
  </Box>
)

export default VenueNews
