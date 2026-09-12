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
//  3. THE NON-SAVES RENDER TOO. "Liquidated anyway — 30% instead of 100%" and BROKE
//     both get a row, in gold and blood. Reporting the losses is what makes the saves
//     believable, and hiding them would make this block advertising.
//
// Every number here comes from /api/sim/history/[address], which replays REAL decoded
// LiquidationCall events against real Chainlink rounds. This file computes nothing.

import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { tabular } from '@/components/Builder/styles'
import type { HistoryEvent, ReplayVerdict } from '@/lib/position-sim/history'

import { useSimHistory } from './hooks/useSimHistory'
import { usd } from './format'

const HEAD = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: '10px',
  letterSpacing: '0.2em',
  textTransform: 'uppercase' as const,
  color: SEMANTIC_COLORS.textSecondary,
}

/** "12 Mar 2024" — these are calendar events, not minutes of a stress window, so the
 *  date is the unit and the clock is noise. */
export const historyDate = (ts: number): string => {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  return `${d.getUTCDate()} ${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${d.getUTCFullYear()}`
}

/** The verdict tag, in the words the brief asked for. `null` share prints no percent. */
export function verdictTag(e: HistoryEvent): { text: string; color: string } {
  switch (e.verdict) {
    case 'saved':
      return { text: 'SAVED — nothing sold', color: SEMANTIC_COLORS.success }
    case 'partial':
      return {
        text:
          e.membraneShare === null
            ? 'liquidated anyway — Membrane repays only to the borrow cap'
            : `liquidated anyway — ${Math.round(e.membraneShare * 100)}% instead of 100%`,
        color: SEMANTIC_COLORS.warning,
      }
    case 'broke':
      return {
        text:
          e.membraneShare === null
            ? 'BROKE the 4% band — immediate sale'
            : `BROKE the 4% band — ${Math.round(e.membraneShare * 100)}% instead of 100%`,
        color: SEMANTIC_COLORS.danger,
      }
    default:
      return { text: 'unpriced — not counted', color: SEMANTIC_COLORS.textTertiary }
  }
}

const VERDICT_ORDER: Record<ReplayVerdict, number> = { saved: 0, partial: 1, broke: 2, unknown: 3 }

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
  const events = h.events
    .slice()
    .sort((a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] || b.ts - a.ts)

  // ------------------------------------------------------ no events on record
  // ONE line, plain, no number. Rule 2 of the brief.
  if (h.events.length === 0) {
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
          No liquidations on record for this address since Aave V3 launched.
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
            {savedCount} liquidation{savedCount === 1 ? '' : 's'}
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
          The 8-hour window would not have saved any of this address&apos;s {h.events.length}{' '}
          liquidation{h.events.length === 1 ? '' : 's'}
          {firstTs ? ` since ${historyDate(firstTs)}` : ''}. Here is what it would have changed.
        </Text>
      )}

      <Box display="grid" gap={SPACING.xs}>
        {events.map((e, i) => {
          const tag = verdictTag(e)
          return (
            <Box
              key={`${e.ts}-${e.collateral}-${i}`}
              display="grid"
              gridTemplateColumns={{ base: '1fr', md: '110px 78px 1fr auto' }}
              gap={{ base: SPACING.xs, md: SPACING.md }}
              alignItems="baseline"
              borderTop={i === 0 ? undefined : '1px solid'}
              borderColor={SEMANTIC_COLORS.borderSubtle}
              pt={i === 0 ? 0 : SPACING.xs}
            >
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="12px"
                color={SEMANTIC_COLORS.textSecondary}
                {...tabular}
              >
                {historyDate(e.ts)}
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
                sold {usd(e.actualSeizedUsd)} {e.collateral}
              </Text>
              <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={tag.color}>
                {tag.text}
              </Text>
            </Box>
          )
        })}
      </Box>

      {h.totals.partialCount > 0 && (
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="12px"
          color={SEMANTIC_COLORS.textSecondary}
          lineHeight={1.6}
        >
          On the {h.totals.partialCount} it could not save, Membrane would still have kept{' '}
          {usd(h.totals.partialUsd)} of collateral by repaying only to the borrow cap.
        </Text>
      )}

      {(h.notScanned ?? []).length > 0 && (
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="11.5px"
          color={SEMANTIC_COLORS.textTertiary}
          lineHeight={1.6}
        >
          Not scanned: {(h.notScanned ?? []).join(', ')}. Aave V3 only.
        </Text>
      )}
    </Box>
  )
}

export default HistoryProof
