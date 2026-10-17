// THE COLLECT-DUST SLIP. One order slip, on the same paper as a lever's (SlipFrame), that
// sweeps every dust supply position an address holds on the supported venues: Morpho Blue
// withdraw by shares, Aave V3 withdraw of the whole balance (lib/position-exec/dust.ts).
//
//   head        ORDER SLIP · COLLECT DUST                                       DRAFT
//               If you collect dust from  4 positions
//   cleared     each position: what it holds, what you receive (often 0, said so), and
//               that the withdraw clears it
//   totals      what you receive in all, in dollars; the gas at today's fee; a ▲ warning
//               when nothing comes back or the gas costs more than what does
//   left alone  supply positions held that are not dust (worth $1 or more, or unpriced)
//   steps       one withdraw per position, as the wallet shows it
//   checks      venue switches, wallet, owner, chain, simulation
//
// Presentational: the design-states page renders it from captured reads. No signing here.

import React from 'react'
import { Box } from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'
import { NEWS, NEWS_FONT } from '@/components/NewsEdition/tokens'
import type { SheetView } from '@/lib/position-exec/sheet'
import type { SimResult } from '@/lib/position-exec/simulate'
import {
  dustTotals,
  dustWarningText,
  fmtDustUsd,
  type DustCandidate,
} from '@/lib/position-exec/dust'
import { fmtUnits } from '@/lib/position-exec/amount'
import { fmtInt, fmtUtc } from '@/lib/position/format'

import { Headline, Section, SlipFrame, gasLine, short } from './LeverSheet'
import { Mono, Small } from './primitives'
import { TYPE } from './typeScale'

const RULE = `1px solid ${NEWS.rule}`

const VENUE_NAME: Record<DustCandidate['venue'], string> = {
  'morpho-blue': 'Morpho Blue',
  'aave-v3': 'Aave V3',
  spark: 'Spark',
}

/** One withdraw, the way the wallet will show it. */
function stepOf(c: DustCandidate, owner: string): { title: string; detail: string } {
  if (c.venue === 'morpho-blue') {
    return {
      title: `Morpho Blue · withdraw`,
      detail: `market ${short(c.marketId)} · assets 0, shares ${fmtUnits(c.shares, 0, 0)} (all of them) · to ${short(owner)}`,
    }
  }
  return {
    title: `${VENUE_NAME[c.venue]} Pool · withdraw`,
    detail: `${c.symbol} · amount type(uint256).max, the whole balance · to ${short(owner)}`,
  }
}

export interface DustSlipProps {
  owner: `0x${string}`
  dust: DustCandidate[]
  /** Supply positions held that are not dust, and why. */
  kept: { c: DustCandidate; why: 'unpriced' | 'worth' }[]
  sim: SimResult | null
  ethUsd: number | null
  block: number
  /** Time of the read, ms. */
  at: number
  source: string
  sheet: SheetView
  txHash: `0x${string}` | null
  busy: boolean
  onButton: () => void
  onClose: () => void
  onExplorer: () => void
  harness?: React.ReactNode
}

export const DustSlip: React.FC<DustSlipProps> = ({
  owner,
  dust,
  kept,
  sim,
  ethUsd,
  block,
  at,
  source,
  sheet,
  txHash,
  busy,
  onButton,
  onClose,
  onExplorer,
  harness,
}) => {
  const t = dustTotals(dust, sim, ethUsd)
  const warning = dustWarningText(t)
  const gas = gasLine(sim)
  const venues = [...new Set(dust.map((c) => VENUE_NAME[c.venue]))].join(' + ')

  const body = (
    <Box display="grid" gap={SPACING.base} minW={0}>
      <Section title={`Positions cleared · ${t.rows.length}`}>
        {t.rows.map((r, i) => (
          <Box key={i} py={SPACING.xs} borderBottom={RULE} minW={0} data-testid="dust-row">
            <Box
              display="grid"
              gridTemplateColumns="minmax(0, 1fr) auto"
              columnGap={SPACING.sm}
              alignItems="baseline"
            >
              <Mono overflowWrap="anywhere">{r.label}</Mono>
              <Mono fontWeight={700} textAlign="right" whiteSpace="nowrap">
                {r.receive}
              </Mono>
            </Box>
            <Small overflowWrap="anywhere">{r.line}</Small>
          </Box>
        ))}
      </Section>

      <Box border={`1px solid ${NEWS.ink}`} px={SPACING.sm} py={SPACING.xs} minW={0} data-testid="dust-totals">
        <Box display="grid" gridTemplateColumns="minmax(0, 1fr) auto" columnGap={SPACING.sm}>
          <Small color={NEWS.ink2}>You receive, in all</Small>
          <Mono fontWeight={700} textAlign="right">
            {t.receiveUsd === 0
              ? '$0 · nothing'
              : t.receiveUsd < 0.01
                ? fmtDustUsd(t.receiveUsd)
                : `about ${fmtDustUsd(t.receiveUsd)}`}
          </Mono>
          <Small color={NEWS.ink2}>Gas, est. at today&apos;s fee</Small>
          <Mono textAlign="right">
            {t.gasUsd !== null ? `about ${fmtDustUsd(t.gasUsd)}` : 'after the simulation'}
          </Mono>
        </Box>
        {warning && (
          <Box
            display="grid"
            gridTemplateColumns="2em minmax(0, 1fr)"
            mt={SPACING.xs}
            pt={SPACING.xs}
            borderTop={`1px solid ${NEWS.warning}`}
            role="note"
            data-testid="dust-warning"
          >
            <Mono aria-hidden color={NEWS.warning} fontWeight={700}>
              ▲
            </Mono>
            <Mono fontWeight={700} overflowWrap="anywhere">
              <Box as="span" srOnly>
                Warning:{' '}
              </Box>
              {warning}
            </Mono>
          </Box>
        )}
      </Box>

      {kept.length > 0 && (
        <Section title={`Left alone · ${kept.length} · not dust`}>
          {kept.map(({ c, why }, i) => (
            <Box
              key={i}
              display="grid"
              gridTemplateColumns="minmax(0, 1fr) auto"
              columnGap={SPACING.sm}
              py={SPACING.xs}
              borderBottom={RULE}
            >
              <Small color={NEWS.ink2} overflowWrap="anywhere">
                {c.label}
              </Small>
              <Small textAlign="right">
                {why === 'worth' && c.priceUsd !== null
                  ? `worth about $${fmtInt(Math.floor((Number(c.assets) / 10 ** c.decimals) * c.priceUsd))}`
                  : 'no price read'}
              </Small>
            </Box>
          ))}
        </Section>
      )}

      <Section title={`Steps · ${dust.length} · each shows in your wallet`}>
        {dust.map((c, i) => {
          const s = stepOf(c, owner)
          return (
            <Box key={i} display="grid" gridTemplateColumns="2em minmax(0, 1fr)" py={SPACING.xs} borderBottom={RULE}>
              <Mono color={NEWS.ink2}>{i + 1}</Mono>
              <Box minW={0}>
                <Mono>{s.title}</Mono>
                <Small overflowWrap="anywhere">{s.detail}</Small>
              </Box>
            </Box>
          )
        })}
        {gas && (
          <Box display="grid" gridTemplateColumns="2em minmax(0, 1fr)" py={SPACING.xs} borderBottom={RULE}>
            <Mono color={NEWS.ink2}>≈</Mono>
            <Mono overflowWrap="anywhere">Gas, est. {gas}</Mono>
          </Box>
        )}
      </Section>
    </Box>
  )

  return (
    <SlipFrame
      testId="dust-sheet"
      kicker="Order slip · Collect dust"
      headline={<Headline kind="collect dust from" amount={String(dust.length)} symbol={dust.length === 1 ? 'position' : 'positions'} />}
      subtitle={
        <>
          {short(owner)} · {venues} · supply positions that pay out nothing or under $1
        </>
      }
      body={body}
      reading="Reading every supply position at one block…"
      showChecks={sheet.checks.length > 0}
      footnote={
        <Box as="span" fontFamily={NEWS_FONT.mono} fontSize={TYPE.label}>
          Read at block {fmtInt(block)} · {fmtUtc(at)} · {source}
          {sim ? ` · simulated with ${sim.method}` : ''}
        </Box>
      }
      sheet={sheet}
      txHash={txHash}
      owner={owner}
      busy={busy}
      onButton={onButton}
      onClose={onClose}
      onExplorer={onExplorer}
      harness={harness}
    />
  )
}
