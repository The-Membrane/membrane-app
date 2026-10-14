// "MOVE YOUR LINE" (FORECAST_VISUALS.md): the reverse solve on the same model and the
// selected horizon, written as levers — "Repay $X · line −Y% · Z% (lo–hi)", "Add N ETH ·
// …" — each ending at the protocol's own app (root links only; no unverified deep link),
// then "Alert me at $P".

import React from 'react'
import { Box, Link } from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'
import { TRANSITIONS } from '@/config/transitions'
import { NEWS } from '@/components/NewsEdition/tokens'
import { REVERSE_SOLVE_TARGETS_PCT } from '@/lib/position/reverseSolve'
import { HORIZON_WORDS, type HorizonId } from '@/lib/position/touchHistory'

import { AlertMeSlot } from './AlertMeSlot'
import { Kicker, Mono, Section, Small } from './primitives'
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

export const Actions: React.FC<{ view: PositionView; horizon: HorizonId; address: string }> = ({ view, horizon, address }) => {
  if (view.hero.kind === 'no-debt') return null
  const venue = view.label.split(' · ')[0]
  const rows = view.forecast?.byHorizon[horizon].actions ?? []
  const strictest = Math.min(...REVERSE_SOLVE_TARGETS_PCT)

  let empty: string | null = null
  if (rows.length === 0) {
    empty =
      view.basis.kind !== 'history'
        ? 'No action rows without a forecast.'
        : view.hero.kind === 'unreachable'
          ? 'A fall alone does not reach this line.'
          : `The chance at your line within ${HORIZON_WORDS[horizon]} is already ${strictest}% or less.`
  }

  return (
    <Section id="actions">
      <Kicker>Move your line · within {HORIZON_WORDS[horizon]}</Kicker>
      {empty === null ? (
        <Box display="grid" gridTemplateColumns={{ base: '1fr', lg: '1fr 1fr' }} columnGap={SPACING.lg} minW={0}>
          {(['repay', 'add'] as const).map((kind) => {
            const group = rows.filter((a) => a.kind === kind)
            if (group.length === 0) return null
            return (
              <Box key={kind} borderTop={`1px solid ${NEWS.rule}`} minW={0}>
                {group.map((a) =>
                  view.appUrl ? (
                    <VenueLink key={a.text} href={view.appUrl} venue={venue} label={`${a.text}†`} />
                  ) : (
                    <Mono key={a.text} minH="44px" py={SPACING.xs} borderBottom={`1px solid ${NEWS.rule}`}>
                      {a.text}†
                    </Mono>
                  ),
                )}
              </Box>
            )
          })}
        </Box>
      ) : (
        <Box display="grid" gap={SPACING.xs}>
          <Mono color={NEWS.ink2}>{empty}</Mono>
          {view.appUrl && (
            <VenueLink href={view.appUrl} venue={venue} label="Manage this position" top />
          )}
        </Box>
      )}
      <AlertMeSlot view={view} address={address} />
    </Section>
  )
}
