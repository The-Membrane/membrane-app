import React, { useState } from 'react'
import { Box, Button, Grid, HStack, Text } from '@chakra-ui/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { Card } from '@/components/ui/Card'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { SectionHeading, Stamp } from '@/components/Carry/atoms'

// STRAT WATCHES + POST-EVENT RECAP. Track an address's carry strat over time and
// tell the story of what happened — including failure stories ("exit initiated —
// gated when it mattered"). Every beat is composed ONLY from chain logs + our
// recorded corpus (see pages/api/radar/recap/[address].ts + recapLogic.ts).
// Brand-clean, screenshot-first: each surface carries a self-documenting footer.

type BeatKind = 'entered' | 'exit_initiated' | 'exit_landed' | 'venue_param_changed' | 'context'
type Provenance = 'observed' | 'reconstructed' | 'chain-read' | 'recorded'

type Beat = {
  at: string
  venue: string
  kind: BeatKind
  text: string
  provenance: Provenance
}
type RecapResponse = {
  address: string
  watched_since: string | null
  label: string | null
  beats: Beat[]
  summary: string
  provenance: {
    window: string
    chain_logs: string
    recorded: string
    current_holdings: string
    modelled: null
  }
}
type WatchResponse = {
  address: string
  label: string | null
  watched_since: string
  entry_total_usd: number
  entry_venue_count: number
}

// A failure beat (a gated exit) reads in the warning tone — the story the owner
// most wants surfaced ("couldn't withdraw when it mattered").
const KIND_TONE: Record<BeatKind, 'warning' | 'normal'> = {
  entered: 'normal',
  exit_initiated: 'warning',
  exit_landed: 'normal',
  venue_param_changed: 'warning',
  context: 'normal',
}

const KIND_LABEL: Record<BeatKind, string> = {
  entered: 'entered',
  exit_initiated: 'exit gated',
  exit_landed: 'exit',
  venue_param_changed: 'venue',
  context: 'delta',
}

/** The self-documenting provenance footer every surface here carries. */
const ProvFooter: React.FC = () => (
  <Stamp>carry radar · recorded corpus · {new Date().toISOString().slice(0, 10)}</Stamp>
)

const ProvChip: React.FC<{ provenance: Provenance }> = ({ provenance }) => (
  <Text
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="9px"
    letterSpacing="0.14em"
    textTransform="uppercase"
    color={SEMANTIC_COLORS.textTertiary}
    textAlign={{ base: 'left', md: 'right' }}
  >
    {provenance}
  </Text>
)

export const RecapSection: React.FC<{ address: string }> = ({ address }) => {
  const queryClient = useQueryClient()
  const [watching, setWatching] = useState(false)
  const [watchError, setWatchError] = useState<string | null>(null)

  const { data, isFetching, error } = useQuery<RecapResponse>({
    queryKey: ['radar_recap', address],
    enabled: !!address,
    queryFn: async () => {
      const r = await fetch(`/api/radar/recap/${address}`)
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        throw new Error(body.error || `recap ${r.status}`)
      }
      return r.json()
    },
    staleTime: 1000 * 60 * 5,
    // Same override as the radar/venue-log surfaces: never serve a stale empty
    // first result for the whole session.
    refetchOnMount: true,
  })

  const trackAddress = async () => {
    setWatching(true)
    setWatchError(null)
    try {
      const r = await fetch('/api/radar/watch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address }),
      })
      if (!r.ok) {
        const body: Partial<WatchResponse> & { error?: string } = await r.json().catch(() => ({}))
        throw new Error(body.error || `watch ${r.status}`)
      }
      // Re-anchor the recap to the new watch instant.
      await queryClient.invalidateQueries({ queryKey: ['radar_recap', address] })
    } catch (e) {
      setWatchError((e as Error).message)
    } finally {
      setWatching(false)
    }
  }

  if (!address) return null

  const watchedSince = data?.watched_since

  return (
    <Box>
      <SectionHeading
        index="05 /"
        title="Track this strat"
        note={
          watchedSince
            ? `tracked since ${watchedSince.slice(0, 10)} — recap anchored to your entry snapshot`
            : 'not tracked yet — track to anchor the recap to a real entry baseline'
        }
      />

      <Card variant="subtle" p={SPACING.base} mb={SPACING.base}>
        <HStack justify="space-between" align="baseline" flexWrap="wrap" gap={SPACING.sm}>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.textSecondary} maxW="640px">
            {watchedSince
              ? `Watching this address. The recap below tells the story since ${watchedSince.slice(0, 10)}: entries, gated exits, and how each exit day ranked in our recorded corpus.`
              : 'Snapshot this address’s positions now, so a later recap can tell the "entered $X → now $Y" story against a real baseline.'}
          </Text>
          <Button
            onClick={trackAddress}
            isDisabled={watching}
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="12px"
            borderRadius={0}
            bg={SEMANTIC_COLORS.bgTertiary}
            color={SEMANTIC_COLORS.textPrimary}
            border="1px solid"
            borderColor={SEMANTIC_COLORS.borderStrong}
            transition={TRANSITIONS.colors}
            _hover={{ color: SEMANTIC_COLORS.success, borderColor: SEMANTIC_COLORS.success }}
            _focusVisible={FOCUS_STYLES.ring}
          >
            {watching ? 'tracking…' : watchedSince ? 'refresh baseline' : 'Track this address'}
          </Button>
        </HStack>
        {watchError && (
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11px" color={SEMANTIC_COLORS.danger} mt={SPACING.sm}>
            {watchError}
          </Text>
        )}
        <ProvFooter />
      </Card>

      {isFetching && (
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.textSecondary} mt={SPACING.md}>
          composing recap from chain logs + corpus…
        </Text>
      )}
      {error && (
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.danger} mt={SPACING.md}>
          {(error as Error).message}
        </Text>
      )}

      {data && (
        <>
          <SectionHeading index="06 /" title="What happened" note={data.provenance.window} />
          <Card p={SPACING.base}>
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.textPrimary} lineHeight={1.7} mb={SPACING.md}>
              {data.summary}
            </Text>
            {data.beats.length === 0 ? (
              <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11.5px" color={SEMANTIC_COLORS.textSecondary}>
                No recorded activity for this address in the window — no entries, exits, or venue changes to recount.
              </Text>
            ) : (
              <Box>
                {data.beats.map((b, i) => {
                  const tone = KIND_TONE[b.kind]
                  return (
                    <Grid
                      key={`${b.at}-${b.venue}-${b.kind}-${i}`}
                      templateColumns={{ base: '1fr', md: '170px 1fr 96px' }}
                      gap={SPACING.base}
                      py={SPACING.sm}
                      borderBottom={i === data.beats.length - 1 ? 'none' : '1px solid'}
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
                        {b.at.slice(0, 10)} · {b.venue || KIND_LABEL[b.kind]}
                      </Text>
                      <Text
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontSize="11.5px"
                        color={tone === 'warning' ? SEMANTIC_COLORS.warning : SEMANTIC_COLORS.textPrimary}
                      >
                        {b.text}
                      </Text>
                      <ProvChip provenance={b.provenance} />
                    </Grid>
                  )
                })}
              </Box>
            )}
            <Stamp>
              observed = on-chain event we filtered to this address · reconstructed = venue change derived from archive ·
              chain-read = live balances · recorded = corpus (venue_snapshots / venue_flows). Nothing modelled.
            </Stamp>
            <ProvFooter />
          </Card>
        </>
      )}
    </Box>
  )
}

export default RecapSection
