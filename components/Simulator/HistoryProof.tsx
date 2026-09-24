// THE SECONDARY PROOF — what the delay infrastructure would have done to THIS wallet's
// real liquidations, from its first one to now.
//
// Owner brief 2026-09-12. The Oct 10 hero is a counterfactual about one day; this block
// is about days that actually happened to the address on screen. Three rules, taken
// straight from the brief and enforced here rather than in a comment:
//
//  1. A DOLLAR FIGURE, NOT A COUNT. The visible total is actual collateral seized minus
//     what Membrane would seize across every priced episode. The count is supporting context.
//  2. NO MANUFACTURED NEAR-MISS. A wallet with no liquidation history gets ONE plain
//     sentence and no number at all. Not a zero in big type — a sentence.
//  3. THE NON-SAVES RENDER TOO. "Liquidated anyway — 2 Membrane liquidations, 30%
//     sold / would have sold / you keep"), BROKE, and WORSE all get a row, in gold and blood. Reporting
//     the losses is what makes the saves believable, and hiding them would make this
//     block advertising.
//  4. THE ROW IS AN EPISODE, NOT AN EVENT (owner ruling 2026-09-12). Events within 24h
//     of each other are one crash and one Membrane replay, and that replay is a CHAIN:
//     a repay-to-cap leaves the position 3pp under its line, so a still-falling price
//     re-liquidates it. Every row therefore carries a Membrane liquidation COUNT.
//
// Every number here comes from /api/sim/history/[address], which replays REAL decoded
// liquidation events against real Chainlink rounds. This file computes nothing.

import Stamp from './Stamp'
import { stamp as stampFn } from '@/lib/position-sim/types'
import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { tabular } from '@/components/Builder/styles'
import type { EpisodeVerdict, HistoryEpisode } from '@/lib/position-sim/history'

import { useSimHistory } from './hooks/useSimHistory'
import { usd } from './format'

const HEAD = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: '10px',
  letterSpacing: '0.24em',
  textTransform: 'uppercase' as const,
  color: SEMANTIC_COLORS.textSecondary,
}

/** date · venue · sold · membrane would sell · you keep · verdict */
const COLS = '118px 70px 130px 130px 110px 1fr'

/** "12 Mar 2024" — these are calendar events, not minutes of a stress window, so the
 *  date is the unit and the clock is noise. */
export const historyDate = (ts: number): string => {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  return `${d.getUTCDate()} ${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${d.getUTCFullYear()}`
}

/** The verdict word. The comparison lives in the columns beside it (sold / Membrane
 *  would sell / you keep), so the tag stays short. The liquidation COUNT rides with it
 *  on every non-save: one repay-to-cap and three are different outcomes. */
export function verdictTag(e: HistoryEpisode): { text: string; color: string } {
  const n = e.membraneLiquidations
  const times = `${n} liquidation${n === 1 ? '' : 's'}`
  switch (e.verdict) {
    case 'saved':
      return { text: 'SAVED — nothing sold', color: SEMANTIC_COLORS.success }
    case 'partial':
      return { text: `liquidated anyway — ${times}`, color: SEMANTIC_COLORS.warning }
    case 'broke':
      return { text: `BROKE the 4% band — ${times}`, color: SEMANTIC_COLORS.danger }
    case 'worse':
      return { text: `worse on Membrane — ${times}`, color: SEMANTIC_COLORS.danger }
    default:
      return { text: 'unpriced — not counted', color: SEMANTIC_COLORS.textTertiary }
  }
}

/** Signed "you keep" for an episode: actual − Membrane. null when unpriced. */
export const keptUsd = (e: HistoryEpisode): number | null =>
  e.verdict === 'unknown' ? null : e.actualSeizedUsd - e.membraneSeizedUsd

const EpisodeCell: React.FC<{
  label: string
  children: React.ReactNode
  color: string
}> = ({ label, children, color }) => (
  <Box
    minW={0}
    display={{ base: 'grid', md: 'block' }}
    gridTemplateColumns="minmax(0, 1fr) minmax(0, 2fr)"
    gap={SPACING.md}
    alignItems="baseline"
  >
    <Text {...HEAD} display={{ base: 'block', md: 'none' }}>
      {label}
    </Text>
    <Text
      minW={0}
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize="12px"
      color={color}
      textAlign={{ base: 'right', md: 'left' }}
      overflowWrap="anywhere"
      {...tabular}
    >
      {children}
    </Text>
  </Box>
)

const SummaryMetric: React.FC<{
  label: string
  value: string
  color?: string
  lead?: boolean
  testId?: string
}> = ({ label, value, color = SEMANTIC_COLORS.textPrimary, lead = false, testId }) => (
  <Box
    minW={0}
    display="grid"
    gap={SPACING.xs}
    p={{ base: SPACING.md, md: SPACING.base }}
    borderLeft={{ base: 'none', md: lead ? 'none' : '1px solid' }}
    borderTop={{ base: lead ? 'none' : '1px solid', md: 'none' }}
    borderColor={SEMANTIC_COLORS.borderSubtle}
  >
    <Text {...HEAD}>{label}</Text>
    <Text
      data-testid={testId}
      minW={0}
      fontFamily={lead ? TYPOGRAPHY.fontDisplay : TYPOGRAPHY.fontMono}
      fontSize={lead ? 'clamp(28px, 5vw, 48px)' : 'clamp(18px, 2vw, 24px)'}
      lineHeight={lead ? 1 : 1.15}
      letterSpacing={lead ? '-0.015em' : undefined}
      color={color}
      overflowWrap="anywhere"
      {...tabular}
    >
      {value}
    </Text>
  </Box>
)

const HISTORY_PROV = stampFn(
  'onchain',
  'measured · mainnet logs',
  'Real LiquidationCall / Liquidate events for this address, replayed through the 4%/8h window at recorded Chainlink rounds.',
)

const VERDICT_ORDER: Record<EpisodeVerdict, number> = {
  saved: 0,
  partial: 1,
  broke: 2,
  worse: 3,
  unknown: 4,
}

/** "12 Mar 2024" for a one-day episode, "5–7 Apr 2025" when it spans more than one. */
export const episodeDate = (e: HistoryEpisode): string => {
  const a = historyDate(e.startTs)
  const b = historyDate(e.endTs)
  return a === b ? a : `${a} → ${b}`
}

export interface HistoryProofProps {
  /** The address on screen: the demo wallet on the demo, the pasted one after a read. */
  address: string | null
}

export const HistoryProof: React.FC<HistoryProofProps> = ({ address }) => {
  const { data, isPending, isError } = useSimHistory(address)
  const [expandedAddress, setExpandedAddress] = React.useState<string | null>(null)
  const detailsId = React.useId()

  // ---------------------------------------------------------------- loading
  if (!address || (isPending && !data)) {
    return (
      <Box
        data-testid="sim-history"
        border="1px solid"
        borderColor={SEMANTIC_COLORS.borderSubtle}
        p={SPACING.base}
        display="grid"
        gap={SPACING.sm}
      >
        <Text {...HEAD}>what the delay would have done to your own history</Text>
        <Box
          h="34px"
          maxW="420px"
          bg={SEMANTIC_COLORS.borderSubtle}
          sx={{
            animation: 'simHistoryPulse 1.4s ease-in-out infinite',
            '@keyframes simHistoryPulse': {
              '0%,100%': { opacity: 0.35 },
              '50%': { opacity: 0.75 },
            },
          }}
        />
      </Box>
    )
  }

  // The scan itself failed. Say that; do not print a zero that means "outage".
  if (isError || data?.error) {
    return (
      <Box
        data-testid="sim-history"
        border="1px solid"
        borderColor={SEMANTIC_COLORS.borderSubtle}
        p={SPACING.base}
        display="grid"
        gap={SPACING.sm}
      >
        <Text {...HEAD}>what the delay would have done to your own history</Text>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="12.5px"
          color={SEMANTIC_COLORS.danger}
          lineHeight={1.6}
        >
          {data?.error ?? 'The liquidation-history scan could not be read.'}
        </Text>
      </Box>
    )
  }

  const h = data!
  const { savedCount } = h.totals
  const episodes = (h.episodes ?? [])
    .slice()
    .sort((a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] || b.startTs - a.startTs)

  // ------------------------------------------------------ no events on record
  // ONE line, plain, no number. Rule 2 of the brief.
  if (episodes.length === 0) {
    return (
      <Box
        data-testid="sim-history"
        border="1px solid"
        borderColor={SEMANTIC_COLORS.borderSubtle}
        p={SPACING.base}
        display="grid"
        gap={SPACING.sm}
      >
        <Text {...HEAD}>what the delay would have done to your own history</Text>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="14px"
          lineHeight={1.6}
          color={SEMANTIC_COLORS.textPrimary}
        >
          No liquidations on record for this address on Aave V3, Spark or Morpho Blue.
        </Text>
      </Box>
    )
  }

  const firstTs = h.since.firstEventTs
  const priced = episodes.filter((e) => e.verdict !== 'unknown')
  const sold = priced.reduce((sum, e) => sum + e.actualSeizedUsd, 0)
  const membrane = priced.reduce((sum, e) => sum + e.membraneSeizedUsd, 0)
  const netKept = sold - membrane
  const detailsOpen = expandedAddress === address
  const outcomeLabel = netKept < 0 ? 'Membrane cost you' : 'Membrane Saved You'
  const outcomeValue = netKept < 0 ? `−${usd(-netKept)}` : usd(netKept)
  const outcomeColor =
    netKept < 0
      ? SEMANTIC_COLORS.danger
      : netKept > 0
        ? SEMANTIC_COLORS.success
        : SEMANTIC_COLORS.textPrimary

  return (
    <Box
      data-testid="sim-history"
      border="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
      p={{ base: SPACING.base, md: SPACING.lg }}
      minW={0}
      display="grid"
      gridTemplateColumns="minmax(0, 1fr)"
      gap={SPACING.md}
    >
      <Box
        display="flex"
        justifyContent="space-between"
        alignItems="baseline"
        gap={SPACING.md}
        flexWrap="wrap"
      >
        <Text {...HEAD}>what the delay would have done to your own history</Text>
        <Stamp provenance={HISTORY_PROV} />
      </Box>

      <Box display="grid" gap={SPACING.xs} pb={SPACING.md}>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="11px"
          letterSpacing="0.06em"
          lineHeight={1.6}
          color={SEMANTIC_COLORS.textSecondary}
        >
          {episodes.length} liquidation episode{episodes.length === 1 ? '' : 's'}
          {firstTs ? ` since ${historyDate(firstTs)}` : ''}
          {savedCount === episodes.length
            ? ' · price was back inside the window'
            : savedCount > 0
              ? ` · price was back inside the window on ${savedCount} of them`
              : ' · price did not return inside the window'}
        </Text>
      </Box>

      {priced.length > 0 ? (
        <Box
          data-testid="sim-history-total"
          display="grid"
          gridTemplateColumns={{ base: '1fr', md: 'minmax(0, 1.3fr) repeat(2, minmax(0, 1fr))' }}
          border="1px solid"
          borderColor={SEMANTIC_COLORS.borderStrong}
          bg={SEMANTIC_COLORS.bgSecondary}
        >
          <SummaryMetric
            lead
            label={outcomeLabel}
            value={outcomeValue}
            color={outcomeColor}
            testId="sim-history-headline"
          />
          <SummaryMetric label="collateral sold" value={usd(sold)} />
          <SummaryMetric label="membrane would sell" value={usd(membrane)} />
        </Box>
      ) : (
        <Box
          data-testid="sim-history-total"
          border="1px solid"
          borderColor={SEMANTIC_COLORS.borderStrong}
          bg={SEMANTIC_COLORS.bgSecondary}
          p={SPACING.base}
        >
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="13px"
            color={SEMANTIC_COLORS.textPrimary}
          >
            No priced episodes. Open the breakdown to see why these events were excluded.
          </Text>
        </Box>
      )}

      <Box display="grid" gap={SPACING.sm}>
        <Box
          as="button"
          type="button"
          data-testid="sim-history-details-toggle"
          aria-expanded={detailsOpen}
          aria-controls={detailsId}
          onClick={() => setExpandedAddress(detailsOpen ? null : address)}
          display="flex"
          alignItems="center"
          justifyContent="space-between"
          gap={SPACING.md}
          width="100%"
          minH="44px"
          px={SPACING.md}
          py={SPACING.sm}
          border="1px solid"
          borderColor={detailsOpen ? SEMANTIC_COLORS.borderStrong : SEMANTIC_COLORS.borderMedium}
          bg="transparent"
          color={SEMANTIC_COLORS.textPrimary}
          textAlign="left"
          cursor="pointer"
          _hover={{ borderColor: SEMANTIC_COLORS.borderStrong }}
          _focusVisible={{ outline: `2px solid ${SEMANTIC_COLORS.success}`, outlineOffset: '2px' }}
        >
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" fontWeight={600}>
            {detailsOpen ? 'Hide' : 'Show'} {episodes.length} episode detail
            {episodes.length === 1 ? '' : 's'}
            {h.totals.worseCount > 0 && (
              <Text as="span" color={SEMANTIC_COLORS.danger}>
                {' '}
                · {h.totals.worseCount} worse on Membrane
              </Text>
            )}
          </Text>
          <Text aria-hidden="true" fontFamily={TYPOGRAPHY.fontMono} fontSize="16px">
            {detailsOpen ? '−' : '+'}
          </Text>
        </Box>

        {detailsOpen && (
          <Box id={detailsId} display="grid" gap={SPACING.md}>
            <Box
              display={{ base: 'none', md: 'grid' }}
              gridTemplateColumns={COLS}
              gap={SPACING.md}
              pb={SPACING.xs}
              borderBottom="1px solid"
              borderColor={SEMANTIC_COLORS.borderSubtle}
            >
              {[
                'date',
                'venue',
                'collateral sold',
                'membrane would sell',
                'you keep',
                'verdict',
              ].map((label) => (
                <Text key={label} {...HEAD}>
                  {label}
                </Text>
              ))}
            </Box>

            {episodes.map((e, i) => {
              const tag = verdictTag(e)
              const kept = keptUsd(e)
              return (
                <Box
                  key={`${e.startTs}-${e.collateral}-${i}`}
                  display="grid"
                  gap={SPACING.xs}
                  borderTop={i === 0 ? undefined : '1px solid'}
                  borderColor={SEMANTIC_COLORS.borderSubtle}
                  pt={i === 0 ? 0 : SPACING.xs}
                >
                  <Box
                    display="grid"
                    gridTemplateColumns={{ base: '1fr', md: COLS }}
                    gap={{ base: SPACING.xs, md: SPACING.md }}
                    alignItems="baseline"
                  >
                    <EpisodeCell label="date" color={SEMANTIC_COLORS.textSecondary}>
                      {episodeDate(e)}
                    </EpisodeCell>
                    <EpisodeCell label="venue" color={SEMANTIC_COLORS.textSecondary}>
                      {e.protocol}
                    </EpisodeCell>
                    <EpisodeCell label="collateral sold" color={SEMANTIC_COLORS.textPrimary}>
                      {usd(e.actualSeizedUsd)} {e.collateral}
                    </EpisodeCell>
                    <EpisodeCell label="membrane would sell" color={SEMANTIC_COLORS.textPrimary}>
                      {kept === null ? '—' : usd(e.membraneSeizedUsd)}
                    </EpisodeCell>
                    <EpisodeCell
                      label="you keep"
                      color={
                        kept === null
                          ? SEMANTIC_COLORS.textTertiary
                          : kept < 0
                            ? SEMANTIC_COLORS.danger
                            : SEMANTIC_COLORS.success
                      }
                    >
                      {kept === null ? '—' : kept < 0 ? `−${usd(-kept)}` : usd(kept)}
                    </EpisodeCell>
                    <EpisodeCell label="verdict" color={tag.color}>
                      {tag.text}
                    </EpisodeCell>
                  </Box>

                  {/* An episode of more than one real hit lists them, so "one row" never
                  hides two liquidations that actually happened. */}
                  {e.events.length > 1 && (
                    <Box display="grid" gap="2px" pl={{ base: 0, md: SPACING.md }}>
                      {e.events.map((ev, j) => (
                        <Text
                          key={`${ev.ts}-${ev.collateral}-${j}`}
                          fontFamily={TYPOGRAPHY.fontMono}
                          fontSize="11px"
                          color={SEMANTIC_COLORS.textTertiary}
                          {...tabular}
                        >
                          {historyDate(ev.ts)} · {ev.protocol} · {usd(ev.actualSeizedUsd)}{' '}
                          {ev.collateral} sold
                          {ev.debtRepaidUsd ? ` for ${usd(ev.debtRepaidUsd)} of loan` : ''}
                          {ev.unpriced ? ` · ${ev.why ?? 'unpriced'}` : ''}
                        </Text>
                      ))}
                    </Box>
                  )}
                </Box>
              )
            })}

            {h.totals.worseCount > 0 && (
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="12px"
                color={SEMANTIC_COLORS.danger}
                lineHeight={1.6}
              >
                On {h.totals.worseCount} episode{h.totals.worseCount === 1 ? '' : 's'} the Membrane
                chain would have cost MORE than the real liquidator did. That is printed, not netted
                away.
              </Text>
            )}

            {(h.notScanned ?? []).length > 0 && (
              <Box display="grid" gap="2px">
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize="11.5px"
                  color={SEMANTIC_COLORS.textTertiary}
                  lineHeight={1.6}
                >
                  Scanned: Aave V3, Spark, Morpho Blue.
                </Text>
              </Box>
            )}
          </Box>
        )}
      </Box>
    </Box>
  )
}

export default HistoryProof
