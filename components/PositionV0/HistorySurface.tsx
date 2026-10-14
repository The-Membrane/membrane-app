// HISTORY, directly under the hero: one drawn surface, one row per horizon on one shared
// axis (DESIGN_RULES §6). Stated as history with its period and n, never as odds (§4, §5b).

import React from 'react'
import { Box } from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'
import { NEWS } from '@/components/NewsEdition/tokens'
import { fmtInt } from '@/lib/position/format'
import { formatFrequency } from '@/lib/position/touch'
import { HORIZON_WORDS } from '@/lib/position/touchHistory'

import { Credit, Headline, Kicker, Mono, Section, Small } from './primitives'
import { TYPE } from './typeScale'
import { TouchGradientSlot } from './TouchGradientSlot'
import type { HistoryView, PositionView } from './viewModel'

const AXIS_TICKS = [0, 25, 50, 75, 100] as const

/**
 * Columns: horizon · the slot · the figure. The figure column never hides (§8). Fixed
 * tracks keep every row on one shared axis. Widths come from JetBrains Mono's 0.6em
 * advance: "within 30 days" is 14 ch and "100% of days" 12 ch — 92 / 79 px at 11px on a
 * phone, 109 / 94 px at 13px from 768px.
 */
const ROW_GRID = { base: '96px minmax(0, 1fr) 84px', md: '120px minmax(0, 1fr) 112px' }
const ROW_SIZE = { base: TYPE.label, md: TYPE.body }

const Rows: React.FC<{ h: HistoryView; priced: string[] }> = ({ h, priced }) => {
  const verb = h.direction === 'fall' ? 'fell' : 'rose'
  const ns = h.rows.map((r) => r.n)
  const from = h.rows.reduce((m, r) => (r.period.from < m ? r.period.from : m), h.rows[0].period.from)
  const to = h.rows.reduce((m, r) => (r.period.to > m ? r.period.to : m), h.rows[0].period.to)
  return (
    <>
      <Headline>
        How often {h.asset} {verb} {h.level}% or more
      </Headline>
      <Box role="table" aria-label={`Share of days ${h.asset} ${verb} ${h.level}% or more, by horizon`} display="grid" gap={SPACING.xs} minW={0}>
        {h.rows.map((r) => (
          <Box key={r.horizon} role="row" display="grid" gridTemplateColumns={ROW_GRID} alignItems="center" columnGap={SPACING.sm} minH="28px">
            <Mono role="rowheader" fontSize={ROW_SIZE} whiteSpace="nowrap">
              within {HORIZON_WORDS[r.horizon]}
            </Mono>
            <Box role="cell" minW={0}>
              <TouchGradientSlot
                horizon={r.horizon}
                pct={r.pct}
                touched={r.touched}
                n={r.n}
                period={r.period}
                confidence={r.confidence}
              />
            </Box>
            <Mono role="cell" fontSize={ROW_SIZE} textAlign="right" whiteSpace="nowrap">
              {formatFrequency(r.touched, r.n)} of days
            </Mono>
          </Box>
        ))}
        {/* The shared axis, ticked once under every row. The last label is right-anchored. */}
        <Box display="grid" gridTemplateColumns={ROW_GRID} columnGap={SPACING.sm} aria-hidden="true">
          <Box />
          <Box position="relative" h="16px">
            {AXIS_TICKS.map((t) => (
              <Small
                key={t}
                position="absolute"
                top={0}
                left={t === 100 ? undefined : `${t}%`}
                right={t === 100 ? 0 : undefined}
                transform={t === 0 || t === 100 ? undefined : 'translateX(-50%)'}
              >
                {t}%
              </Small>
            ))}
          </Box>
          <Box />
        </Box>
      </Box>
      <Small>
        Daily starts {from} → {to} · n = {fmtInt(Math.min(...ns))}–{fmtInt(Math.max(...ns))} per row ·{' '}
        {priced.join(', ')} {h.label}
      </Small>
      <Credit>{h.credit}</Credit>
    </>
  )
}

export const HistorySurface: React.FC<{ view: PositionView }> = ({ view }) => {
  const h = view.history
  const kicker = <Kicker>History, not a forecast{h ? ` · ${h.years}` : ''}</Kicker>

  if (view.hero.kind === 'no-debt' || view.hero.kind === 'past' || view.hero.kind === 'unreachable') return null

  if (!h) {
    return (
      <Section id="history">
        {kicker}
        <Mono color={NEWS.ink2}>{view.historyAbsent ?? 'No price history for this position.'}</Mono>
      </Section>
    )
  }

  if (h.lookup !== 'row') {
    const verb = h.direction === 'fall' ? 'fall' : 'rise'
    return (
      <Section id="history">
        {kicker}
        <Mono color={NEWS.ink2}>
          {h.lookup === 'within'
            ? `Your line is under 1% away: closer than any row.`
            : `A ${verb} past 60% is beyond the table.`}
        </Mono>
        <Credit>{h.credit}</Credit>
      </Section>
    )
  }

  return (
    <Section id="history">
      {kicker}
      <Rows h={h} priced={view.model && view.model.moving.length ? view.model.moving : [view.model?.symbol ?? h.asset]} />
    </Section>
  )
}
