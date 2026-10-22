// "MOVE YOUR LINE" (FORECAST_VISUALS.md): the reverse solve on the same model and the
// selected horizon, written as levers — "If you repay N USDC · line −Y% · Z% (lo–hi)",
// "If you add N ETH · …" — each ending at the protocol's own app (root links only; no
// unverified deep link), then "Alert me at $P".

import React from 'react'
import { Box, Link } from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'
import { TRANSITIONS } from '@/config/transitions'
import { NEWS } from '@/components/NewsEdition/tokens'
import { HORIZON_WORDS, TOUCH_TABLE, type HorizonId } from '@/lib/position/touchHistory'

import { AlertMeSlot } from './AlertMeSlot'
import { Kicker, Mono, Section, Small, StaleTag } from './primitives'
import type { PositionView } from './viewModel'

const ROW_LINK = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  alignItems: 'center',
  columnGap: SPACING.sm,
  minH: '44px',
  py: SPACING.xs,
  borderBottom: `1px solid ${NEWS.rule}`,
  color: NEWS.ink,
  transition: TRANSITIONS.colors,
  _hover: { color: NEWS.accent, textDecoration: 'none', borderColor: NEWS.ruleStrong },
} as const

/** A lever row linking to the venue's app. On a phone the venue name folds to ↗. */
const VenueLink: React.FC<{ href: string; venue: string; label: string; top?: boolean }> = ({ href, venue, label, top }) => (
  <Link
    href={href}
    isExternal
    rel="noopener noreferrer"
    {...ROW_LINK}
    borderTop={top ? `1px solid ${NEWS.rule}` : undefined}
    aria-label={`${label} on ${venue}`}
  >
    <Mono as="span" color="inherit">
      {label}
    </Mono>
    <Small as="span" color="inherit" whiteSpace="nowrap">
      <Box as="span" display={{ base: 'none', md: 'inline' }}>
        on {venue}{' '}
      </Box>
      ↗
    </Small>
  </Link>
)

/**
 * Why there are no rows, in one sentence the reader can check. While STALE, the reasons
 * that quote the model's chances ("already 5% or less") give way to the withheld line.
 */
function emptyCopy(view: PositionView, horizon: HorizonId, stale: boolean): string | null {
  if (view.hero.kind === 'unsplit') return null // the hero already says why
  if (view.basis.kind !== 'history' || !view.forecast) return 'No action rows without a forecast.'
  if (view.hero.kind === 'unreachable') return `A ${view.hero.direction} alone does not reach this line.`
  const { reason, met, beyond, pastTable } = view.forecast.byHorizon[horizon].solve
  if (stale && (reason === 'met' || reason === 'beyond')) return null
  if (reason === 'no-lever') return 'No repay or top-up fits this position.'
  if (reason === 'beyond-table') {
    const lever = pastTable.length > 1 ? 'repay or top-up' : pastTable[0] === 'repay' ? 'repay' : 'top-up'
    return `A small ${lever} moves the line past ${TOUCH_TABLE.levels.max}%, beyond the table.`
  }
  const parts: string[] = []
  if (met.length > 0) parts.push(`already ${Math.min(...met)}% or less`)
  if (beyond.length > 0) parts.push(`no line within the table's ${TOUCH_TABLE.levels.max}% gets under ${Math.min(...beyond)}%`)
  return `Within ${HORIZON_WORDS[horizon]}: ${parts.join('; ')}.`
}

export const Actions: React.FC<{
  view: PositionView
  horizon: HorizonId
  address: string
  /** Days since the forecast's data ended, when it is STALE: its chances are withheld. */
  staleDays: number | null
}> = ({ view, horizon, address, staleDays }) => {
  if (view.hero.kind === 'no-debt') return null
  const venue = view.label.split(' · ')[0]
  const stale = staleDays !== null && view.forecast !== null
  const rows = view.forecast?.byHorizon[horizon].actions ?? []
  const empty = rows.length === 0 ? emptyCopy(view, horizon, stale) : null
  // STALE hides the model's numbers (DESIGN_RULES §4): the action and its line stay.
  const label = (a: (typeof rows)[number]) => (stale ? `${a.action} · ${a.line}†` : `${a.text}†`)

  return (
    <Section id="actions">
      <Kicker>Move your line · within {HORIZON_WORDS[horizon]}</Kicker>
      {stale && (
        <Small color={NEWS.ink2}>
          <StaleTag /> · chances withheld · forecast data {staleDays} days old
        </Small>
      )}
      {rows.length > 0 ? (
        <Box display="grid" gridTemplateColumns={{ base: '1fr', lg: '1fr 1fr' }} columnGap={SPACING.lg} minW={0}>
          {(['repay', 'add'] as const).map((kind) => {
            const group = rows.filter((a) => a.kind === kind)
            if (group.length === 0) return null
            return (
              <Box key={kind} borderTop={`1px solid ${NEWS.rule}`} minW={0}>
                {group.map((a) =>
                  view.appUrl ? (
                    <VenueLink key={a.text} href={view.appUrl} venue={venue} label={label(a)} />
                  ) : (
                    <Mono key={a.text} minH="44px" py={SPACING.xs} borderBottom={`1px solid ${NEWS.rule}`}>
                      {label(a)}
                    </Mono>
                  ),
                )}
              </Box>
            )
          })}
        </Box>
      ) : (
        <Box display="grid" gap={SPACING.xs}>
          {empty && <Mono color={NEWS.ink2}>{empty}</Mono>}
          {view.appUrl && (
            <VenueLink href={view.appUrl} venue={venue} label="Manage this position" top />
          )}
        </Box>
      )}
      <AlertMeSlot view={view} address={address} />
    </Section>
  )
}
