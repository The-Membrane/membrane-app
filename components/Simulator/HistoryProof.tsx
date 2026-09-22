// THE SECONDARY PROOF — what the delay infrastructure would have done to THIS wallet's
// real liquidations, from its first one to now.
//
// Owner brief 2026-09-12. The Oct 10 hero is a counterfactual about one day; this block
// is about days that actually happened to the address on screen. Three rules, taken
// straight from the brief and enforced here rather than in a comment:
//
//  1. A DOLLAR FIGURE, NOT A COUNT. The headline is "$41,200 in collateral that would
//     still be yours." The count is the label underneath it.
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
  const { savedUsd, savedCount } = h.totals
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

  return (
    <Box
      data-testid="sim-history"
      border="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
      p={{ base: SPACING.base, md: SPACING.lg }}
      display="grid"
      gap={SPACING.md}
    >
      <Text {...HEAD}>what the delay would have done to your own history</Text>

      {savedUsd > 0 ? (
        <Box display="grid" gap={SPACING.xs}>
          <Text
            data-testid="sim-history-headline"
            fontFamily={TYPOGRAPHY.fontDisplay}
            fontSize="clamp(26px, 4vw, 44px)"
            lineHeight={1.08}
            letterSpacing="-0.015em"
            color={SEMANTIC_COLORS.success}
            sx={{ textWrap: 'balance' }}
          >
            {usd(savedUsd)} in collateral that would still be yours.
          </Text>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="11px"
            letterSpacing="0.06em"
            color={SEMANTIC_COLORS.textSecondary}
          >
            {savedCount} liquidation episode{savedCount === 1 ? '' : 's'}
            {firstTs ? ` since ${historyDate(firstTs)}` : ''} · price was back inside the window
          </Text>
        </Box>
      ) : (
        // Events exist, but the window saved none of them. That is a real result and it
        // is printed as one — never softened into a near-miss.
        <Text
          data-testid="sim-history-headline"
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="14px"
          lineHeight={1.6}
          color={SEMANTIC_COLORS.textPrimary}
        >
          The 8-hour window would not have saved any of this address&apos;s {episodes.length}{' '}
          liquidation episode{episodes.length === 1 ? '' : 's'}
          {firstTs ? ` since ${historyDate(firstTs)}` : ''}. Here is what it would have changed.
        </Text>
      )}

      <Box display="grid" gap={SPACING.xs}>
        {/* column labels — the numbers carry the comparison, the words stay short */}
        <Box
          display={{ base: 'none', md: 'grid' }}
          gridTemplateColumns={COLS}
          gap={SPACING.md}
          pb={SPACING.xs}
          borderBottom="1px solid"
          borderColor={SEMANTIC_COLORS.borderSubtle}
        >
          {['date', 'venue', 'collateral sold', 'membrane would sell', 'you keep', 'verdict'].map((h) => (
            <Text key={h} {...HEAD}>
              {h}
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
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize="12px"
                  color={SEMANTIC_COLORS.textSecondary}
                  {...tabular}
                >
                  {episodeDate(e)}
                </Text>
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize="12px"
                  color={SEMANTIC_COLORS.textSecondary}
                >
                  {e.protocol}
                </Text>
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize="12px"
                  color={SEMANTIC_COLORS.textPrimary}
                  {...tabular}
                >
                  {usd(e.actualSeizedUsd)} {e.collateral}
                </Text>
                <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.textPrimary} {...tabular}>
                  {kept === null ? '—' : usd(e.membraneSeizedUsd)}
                </Text>
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize="12px"
                  color={kept === null ? SEMANTIC_COLORS.textTertiary : kept < 0 ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.success}
                  {...tabular}
                >
                  {kept === null ? '—' : kept < 0 ? `−${usd(-kept)}` : usd(kept)}
                </Text>
                <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={tag.color}>
                  {tag.text}
                </Text>
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
      </Box>

      {/* totals row — same columns, unknown episodes excluded from all three */}
      {(() => {
        const priced = episodes.filter((e) => e.verdict !== 'unknown')
        if (priced.length === 0) return null
        const sold = priced.reduce((a, e) => a + e.actualSeizedUsd, 0)
        const membrane = priced.reduce((a, e) => a + e.membraneSeizedUsd, 0)
        const net = sold - membrane
        return (
          <Box
            data-testid="sim-history-net"
            display="grid"
            gridTemplateColumns={{ base: '1fr', md: COLS }}
            gap={{ base: SPACING.xs, md: SPACING.md }}
            pt={SPACING.xs}
            borderTop="1px solid"
            borderColor={SEMANTIC_COLORS.borderStrong}
            alignItems="baseline"
          >
            <Text {...HEAD}>total</Text>
            <Text />
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.textPrimary} {...tabular}>
              {usd(sold)}
            </Text>
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.textPrimary} {...tabular}>
              {usd(membrane)}
            </Text>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="12px"
              color={net < 0 ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.success}
              {...tabular}
            >
              {net < 0 ? `−${usd(-net)}` : usd(net)}
            </Text>
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.textSecondary}>
              {h.totals.membraneLiquidationsTotal} Membrane liquidation
              {h.totals.membraneLiquidationsTotal === 1 ? '' : 's'}
            </Text>
          </Box>
        )
      })()}

      {h.totals.worseCount > 0 && (
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="12px"
          color={SEMANTIC_COLORS.danger}
          lineHeight={1.6}
        >
          On {h.totals.worseCount} episode{h.totals.worseCount === 1 ? '' : 's'} the Membrane chain
          would have cost MORE than the real liquidator did. That is printed, not netted away.
        </Text>
      )}

      {/* Scanned: Aave V3, Spark, Morpho Blue. The rest is named WITH ITS REASON,
          verbatim from the scan — a bare list reads as "we forgot". */}
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
          {/* {(h.notScanned ?? []).map((n) => (
            <Text
              key={n.protocol}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="11.5px"
              color={SEMANTIC_COLORS.textTertiary}
              lineHeight={1.6}
            >
              Not scanned — {n.protocol}: {n.reason}
            </Text>
          ))} */}
        </Box>
      )}
    </Box>
  )
}

export default HistoryProof
