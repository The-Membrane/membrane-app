// THE COLLECT-DUST SLIP. One order slip, on the same paper as a lever's (SlipFrame), that
// sweeps every dust supply position an address holds on the supported venues: Morpho Blue
// withdraw by shares, Aave V3 withdraw of the whole balance (lib/position-exec/dust.ts).
//
//   head        ORDER SLIP · COLLECT DUST                                       DRAFT
//               If you collect dust from  4 positions
//   cleared     each position, with a tick: what it holds, what you receive (often 0,
//               said so), and that the withdraw clears it. A row that pays nothing starts
//               unticked, one that pays something ticked (owner, Q27 round 5); the totals,
//               the steps and the gas follow the ticks; none ticked is "Nothing selected"
//   totals      what you receive in all, in dollars; the gas at today's fee; a ▲ warning
//               when nothing comes back or the gas costs more than what does
//   left alone  supply positions held that are not dust (worth $1 or more, or unpriced)
//   steps       one withdraw per position, as the wallet shows it
//   checks      venue switches, wallet, owner, chain, simulation
//
// Presentational: the design-states page renders it from captured reads. No signing here.

import React, { useMemo, useState } from 'react'
import { Box } from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES } from '@/config/transitions'
import { NEWS, NEWS_FONT } from '@/components/NewsEdition/tokens'
import type { SheetView } from '@/lib/position-exec/sheet'
import type { SimResult } from '@/lib/position-exec/simulate'
import {
  aboutUsd,
  defaultPicks,
  dustRow,
  dustTotals,
  dustWarningText,
  picked,
  pickedSim,
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
  /** The sheet for the ticked positions and their cut simulation (lib/position-exec/dust.ts dustSheet). */
  sheetFor: (chosen: DustCandidate[], sim: SimResult | null) => SheetView
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
  sheetFor,
  txHash,
  busy,
  onButton,
  onClose,
  onExplorer,
  harness,
}) => {
  const [picks, setPicks] = useState<boolean[]>(() => defaultPicks(dust))
  const chosen = useMemo(() => picked(dust, picks), [dust, picks])
  const cutSim = useMemo(() => pickedSim(sim, picks), [sim, picks])
  const sheet = sheetFor(chosen, cutSim)
  const t = dustTotals(chosen, cutSim, ethUsd)
  const warning = dustWarningText(t)
  const gas = gasLine(cutSim)
  const venues = [...new Set(dust.map((c) => VENUE_NAME[c.venue]))].join(' + ')
  const all = dust.map(dustRow)
  const toggle = (i: number) => setPicks((ps) => ps.map((v, j) => (j === i ? !v : v)))

  const body = (
    <Box display="grid" gap={SPACING.base} minW={0}>
      <Section title={`Positions · ${chosen.length} of ${dust.length} ticked`}>
        <Small pt={SPACING.xs}>
          A position that pays nothing starts unticked: collecting it only clears it, for gas.
        </Small>
        {all.map((r, i) => (
          <Box
            as="label"
            key={i}
            display="grid"
            gridTemplateColumns="44px minmax(0, 1fr)"
            alignItems="start"
            py={SPACING.xs}
            borderBottom={RULE}
            minW={0}
            cursor="pointer"
            data-testid="dust-row"
            data-picked={picks[i] ? 'on' : 'off'}
          >
            <Box display="flex" alignItems="center" justifyContent="center" minH="44px" position="relative">
              {/* The native box stays (keyboard, screen readers); the paper box draws it. */}
              <Box
                as="input"
                type="checkbox"
                checked={picks[i]}
                onChange={() => toggle(i)}
                aria-label={`Collect ${r.label}: ${r.receive}`}
                position="absolute"
                opacity={0}
                w="44px"
                h="44px"
                m={0}
                cursor="pointer"
                data-testid="dust-pick"
                sx={{ '&:focus-visible + span': FOCUS_STYLES.ring }}
              />
              <Box
                as="span"
                aria-hidden
                display="inline-flex"
                alignItems="center"
                justifyContent="center"
                w="20px"
                h="20px"
                border={`1.5px solid ${NEWS.ink}`}
                bg={picks[i] ? NEWS.ink : NEWS.paper}
                color={NEWS.paper}
                fontFamily={NEWS_FONT.mono}
                fontSize={TYPE.body}
                fontWeight={700}
                lineHeight={1}
                pointerEvents="none"
              >
                {picks[i] ? '✓' : ''}
              </Box>
            </Box>
            <Box minW={0} py={SPACING.xs} color={picks[i] ? NEWS.ink : NEWS.muted}>
              <Box
                display="grid"
                gridTemplateColumns="minmax(0, 1fr) auto"
                columnGap={SPACING.sm}
                alignItems="baseline"
              >
                <Mono overflowWrap="anywhere" color="inherit">
                  {r.label}
                </Mono>
                <Mono fontWeight={700} textAlign="right" whiteSpace="nowrap" color="inherit">
                  {r.receive}
                </Mono>
              </Box>
              <Small overflowWrap="anywhere" color="inherit">
                {picks[i] ? r.line : `Left as it is · ${r.line.charAt(0).toLowerCase()}${r.line.slice(1)}`}
              </Small>
            </Box>
          </Box>
        ))}
      </Section>

      <Box border={`1px solid ${NEWS.ink}`} px={SPACING.sm} py={SPACING.xs} minW={0} data-testid="dust-totals">
        <Box display="grid" gridTemplateColumns="minmax(0, 1fr) auto" columnGap={SPACING.sm}>
          <Small color={NEWS.ink2}>You receive, in all</Small>
          <Mono fontWeight={700} textAlign="right" data-testid="dust-receive">
            {chosen.length === 0 ? '—' : t.receiveUsd === 0 ? '$0 · nothing' : aboutUsd(t.receiveUsd)}
          </Mono>
          <Small color={NEWS.ink2}>Gas, est. at today&apos;s fee</Small>
          <Mono textAlign="right" data-testid="dust-gas">
            {chosen.length === 0 ? '—' : t.gasUsd !== null ? aboutUsd(t.gasUsd) : 'after the simulation'}
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

      <Section title={`Steps · ${chosen.length} · each shows in your wallet`}>
        {chosen.length === 0 && <Small pt={SPACING.xs}>Nothing ticked: no step to sign.</Small>}
        {chosen.map((c, i) => {
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
      headline={<Headline kind="collect dust from" amount={String(chosen.length)} symbol={chosen.length === 1 ? 'position' : 'positions'} />}
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
          {sim?.ok && chosen.length > 0 && chosen.length < dust.length
            ? ' · gas for the ticked calls, from each call in the simulated batch'
            : ''}
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
