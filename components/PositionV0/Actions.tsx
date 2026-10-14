// ACTIONS (DESIGN_RULES §5b, §7): the reverse solve written as levers, each ending at the
// protocol's own app. Root links only; no deep link this page has not verified.

import React from 'react'
import { Box, Link } from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'
import { TRANSITIONS } from '@/config/transitions'
import { NEWS } from '@/components/NewsEdition/tokens'
import { REVERSE_SOLVE_HORIZON, REVERSE_SOLVE_TARGETS_PCT } from '@/lib/position/reverseSolve'

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

export const Actions: React.FC<{ view: PositionView }> = ({ view }) => {
  if (view.hero.kind === 'no-debt') return null
  const venue = view.label.split(' · ')[0]
  const strictest = Math.min(...REVERSE_SOLVE_TARGETS_PCT)

  return (
    <Section id="actions">
      <Kicker>Move your line · {REVERSE_SOLVE_HORIZON} history at the new line</Kicker>
      {view.actions.length > 0 ? (
        <Box display="grid" gridTemplateColumns={{ base: '1fr', lg: '1fr 1fr' }} columnGap={SPACING.lg} minW={0}>
          {(['repay', 'add'] as const).map((kind) => {
            const rows = view.actions.filter((a) => a.kind === kind)
            if (rows.length === 0) return null
            return (
              <Box key={kind} borderTop={`1px solid ${NEWS.rule}`} minW={0}>
                {rows.map((a) =>
                  view.appUrl ? (
                    <Link key={a.text} href={view.appUrl} isExternal rel="noopener noreferrer" {...ROW_LINK}>
                      <Mono as="span" color="inherit">
                        {a.text}
                      </Mono>
                      <Small as="span" color="inherit" whiteSpace="nowrap">
                        on {venue} ↗
                      </Small>
                    </Link>
                  ) : (
                    <Mono key={a.text} minH="44px" py={SPACING.xs} borderBottom={`1px solid ${NEWS.rule}`}>
                      {a.text}
                    </Mono>
                  ),
                )}
              </Box>
            )
          })}
        </Box>
      ) : (
        <Box display="grid" gap={SPACING.xs}>
          <Mono color={NEWS.ink2}>
            {view.basis.kind !== 'history'
              ? 'No action rows without a price history.'
              : view.hero.kind === 'unreachable'
                ? 'A fall alone does not reach this line.'
                : `${REVERSE_SOLVE_HORIZON} history at your line is already ${strictest}% or less.`}
          </Mono>
          {view.appUrl && (
            <Link href={view.appUrl} isExternal rel="noopener noreferrer" {...ROW_LINK} borderTop={`1px solid ${NEWS.rule}`}>
              <Mono as="span" color="inherit">
                Manage this position
              </Mono>
              <Small as="span" color="inherit" whiteSpace="nowrap">
                on {venue} ↗
              </Small>
            </Link>
          )}
        </Box>
      )}
      <AlertMeSlot view={view} />
    </Section>
  )
}
