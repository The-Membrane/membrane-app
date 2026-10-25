// THE FORECAST LAYER. Three columns, each a short label and its numbers. Each reading is
// shown only as its registry cell allows: a probability with its class label (shortest
// form on the page, the engine's full label in the tooltip), a history count (never a %),
// nothing where the cell says DO NOT SHOW. Explanations live in the one Details below.

import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { fmtLocalDayClock, useLocalZone } from '@/components/Simulator/localClock'
import {
  fmtHorizon,
  shortClass,
  shown,
  type DelayStep,
  type ForwardReach,
  type HistoryReading,
  type Shown,
  type Slot,
} from '@/lib/landing/forecastLayer'

import Details, { DetailLine } from './Details'
import { credit, kicker, rule, small, tabularNums } from './styles'

export interface ForecastPanelProps {
  delay: Slot<DelayStep[]>
  history: Slot<HistoryReading[]>
  reach: Slot<ForwardReach>
  isDemo: boolean
  /** "Binance spot 1h klines · fetched HH:MM", once a series has loaded. */
  stamp: string | null
}

const Pending: React.FC<{ reason: string }> = ({ reason }) => (
  <Text {...small} data-testid="forecast-pending" title={reason}>
    Model pending
  </Text>
)

/**
 * One reading: "3d · −7% · 23%  calibrated · not proven better". An upper bound (the
 * line is deeper than the nearest shown level) is written "≥ −7%": at least as far as.
 */
const ShownLine: React.FC<{ s: Shown; upperBound?: boolean }> = ({ s, upperBound }) => {
  if (s.kind === 'none') return null
  return (
    <Text {...small} {...tabularNums} color={SEMANTIC_COLORS.textPrimary}>
      {s.kind === 'probability' ? (
        <>
          {fmtHorizon(s.horizonH)} · {upperBound ? '≥ ' : ''}−{Math.abs(s.levelPct)}% · {s.text}{' '}
          <Text as="span" color={SEMANTIC_COLORS.textSecondary} title={[s.label, s.caveat].filter(Boolean).join(' · ')}>
            {shortClass(s.cls, s.label)}
          </Text>
        </>
      ) : (
        <Text as="span" title={s.label}>
          {s.text}
        </Text>
      )}
    </Text>
  )
}

const Block: React.FC<{ title: string; testId: string; first?: boolean; children: React.ReactNode }> = ({ title, testId, first, children }) => (
  <Box
    data-testid={testId}
    display="grid"
    gap={0}
    minW={0}
    alignContent="start"
    py={SPACING.sm}
    px={{ base: 0, lg: first ? 0 : SPACING.base }}
    borderLeft={{ base: 'none', lg: first ? 'none' : rule }}
    borderTop={{ base: first ? 'none' : rule, lg: 'none' }}
  >
    <Text {...kicker}>{title}</Text>
    {children}
  </Box>
)

/** Plain text of one reading, for the Details list. */
const readingText = (s: Shown, upperBound = false): string =>
  s.kind === 'probability'
    ? `${fmtHorizon(s.horizonH)} · ${upperBound ? '≥ ' : ''}−${Math.abs(s.levelPct)}% · ${s.text} · ${s.label}${s.caveat ? ` · ${s.caveat}` : ''}`
    : s.kind === 'count'
      ? s.text
      : ''

export const ForecastPanel: React.FC<ForecastPanelProps> = ({ delay, history, reach, stamp, isDemo }) => {
  const zone = useLocalZone()
  const more: string[] = []

  // ---- In the window: one reading on the page, the rest in Details.
  let delayHead: React.ReactNode = null
  if (delay.status === 'ready') {
    let shownOne = false
    for (const step of delay.value) {
      const when = fmtLocalDayClock(step.ts, zone)
      const rows = (step.reach?.rows ?? []).filter((row) => shown(row.result).kind !== 'none')
      const where = step.alreadyPast
        ? 'already past the sale point'
        : step.toBreakPct === null
          ? 'no price'
          : `sale point −${Math.floor(Math.abs(step.toBreakPct))}%`
      if (!shownOne && (step.alreadyPast || rows.length > 0)) {
        shownOne = true
        delayHead = (
          <>
            <Text {...small} {...tabularNums}>
              {when} · {where}
            </Text>
            {rows[0] && <ShownLine s={shown(rows[0].result)} upperBound={rows[0].isUpperBound} />}
          </>
        )
        rows.slice(1).forEach((row) => more.push(`In the window, ${when}: ${readingText(shown(row.result), row.isUpperBound)}`))
      } else {
        if (rows.length === 0) more.push(`In the window, ${when}: ${where}`)
        rows.forEach((row) => more.push(`In the window, ${when}: ${where} · ${readingText(shown(row.result), row.isUpperBound)}`))
      }
    }
  }

  // ---- History: one reading on the page.
  let historyHead: React.ReactNode = null
  if (history.status === 'ready') {
    history.value.forEach((h, k) => {
      const when = `${fmtLocalDayClock(h.episodeStartTs, zone)} · ${h.collateral} liquidated`
      const res = h.results.filter((r) => r.kind !== 'none')
      if (k === 0) {
        historyHead = (
          <>
            <Text {...small} {...tabularNums}>
              {when}
            </Text>
            {res[0] && <ShownLine s={res[0]} />}
          </>
        )
        res.slice(1).forEach((r) => more.push(`History, ${when}: ${readingText(r)}`))
      } else {
        res.forEach((r) => more.push(`History, ${when}: ${readingText(r)}`))
      }
    })
  }

  // ---- From today: one reading on the page.
  let reachHead: React.ReactNode = null
  if (reach.status === 'ready') {
    const rv = reach.value
    if (rv.reach.throughLine) {
      reachHead = (
        <Text {...small} color={SEMANTIC_COLORS.textPrimary} data-testid="forecast-act-now">
          {isDemo ? 'Demo: through its line. Act now.' : 'Through your line. Act now.'}
        </Text>
      )
    } else {
      const inside = rv.reach.rows.filter((row) => row.status === 'inside' && shown(row.result).kind !== 'none')
      const beyond = rv.reach.rows.filter((row) => row.status === 'beyond').map((row) => fmtHorizon(row.horizonH))
      reachHead = (
        <>
          <Text {...small} {...tabularNums}>
            {isDemo ? 'Demo line' : 'Your line'} −{Math.floor(Math.abs(rv.distancePct ?? 0))}%
          </Text>
          {inside[0] ? (
            <ShownLine s={shown(inside[0].result)} upperBound={inside[0].isUpperBound} />
          ) : beyond.length > 0 ? (
            <Text {...small}>out of model range</Text>
          ) : null}
        </>
      )
      inside.slice(1).forEach((row) => more.push(`From today: ${readingText(shown(row.result), row.isUpperBound)}`))
      if (beyond.length) more.push(`From today: the line is past what the model may speak about at ${beyond.join(', ')}.`)
    }
  }

  return (
    <Box role="group" aria-label="Forecast layer" data-testid="landing-forecast" display="grid" gap={SPACING.xs} borderTop={rule} borderBottom={rule}>
      <Box display="grid" gap={0} gridTemplateColumns={{ base: 'minmax(0, 1fr)', lg: 'repeat(3, minmax(0, 1fr))' }}>
        <Block title="In the window" testId="forecast-delay" first>
          {delay.status === 'pending' ? <Pending reason={delay.reason} /> : delayHead ?? <Pending reason="no displayable reading" />}
        </Block>
        <Block title={isDemo ? 'Its history' : 'Your history'} testId="forecast-history">
          {history.status === 'pending' ? <Pending reason={history.reason} /> : historyHead}
        </Block>
        <Block title="From today" testId="forecast-reach">
          {reach.status === 'pending' ? <Pending reason={reach.reason} /> : reachHead}
        </Block>
      </Box>
      <Box display="flex" gap={SPACING.md} alignItems="center" flexWrap="wrap" justifyContent="space-between">
      <Details testId="forecast-details">
        <DetailLine>
          † Forecasts are of the Binance spot price touching a level within a horizon, not of your venue’s oracle. Each reading
          shows only what its registry cell allows (Q26 confidence map); not a guarantee. “≥ −X%” is the nearest level the
          model may show, an upper bound for a deeper line. “In the window” reads each hour of the armed window from the
          engine’s spot; “From today” uses the position’s amounts at the latest spot.
        </DetailLine>
        {more.map((m, k) => (
          <DetailLine key={k}>{m}</DetailLine>
        ))}
        {delay.status === 'pending' && <DetailLine>In the window: {delay.reason}</DetailLine>}
        {history.status === 'pending' && <DetailLine>History: {history.reason}</DetailLine>}
        {reach.status === 'pending' && <DetailLine>From today: {reach.reason}</DetailLine>}
      </Details>
      {stamp && <Text {...credit} textAlign="left">{stamp}</Text>}
      </Box>
    </Box>
  )
}

export default ForecastPanel
