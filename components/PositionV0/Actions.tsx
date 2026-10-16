// "MOVE YOUR LINE" (FORECAST_VISUALS.md): the reverse solve on the same model and the
// selected horizon, written as levers — "If you repay N USDC · line −Y% · Z% (lo–hi)",
// "If you add N ETH · …" — then "Alert me at $P".
//
// A lever never sends the reader away (owner, 2026-10-16: "think Bloomberg"): it opens the
// in-page order slip (LeverSheet), which re-reads the position and signs the repay or the
// top-up on the venue itself. Its rule is dashed: a dashed edge leads to a signature (T31).

import React from 'react'
import { Box } from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { NEWS } from '@/components/NewsEdition/tokens'
import { isExecProtocol } from '@/lib/position-exec/read'
import type { ActionRow } from '@/lib/position/reverseSolve'
import { HORIZON_WORDS, TOUCH_TABLE, type HorizonId } from '@/lib/position/touchHistory'

import { AlertMeSlot } from './AlertMeSlot'
import { Kicker, Mono, Section, Small, StaleTag } from './primitives'
import type { PositionView } from './viewModel'

/** A lever row: a button that opens the order slip. On a phone "Review" folds to ▸. */
const LeverButton: React.FC<{ label: string; venue: string; onOpen: () => void }> = ({ label, venue, onOpen }) => (
  <Box
    as="button"
    type="button"
    onClick={onOpen}
    aria-haspopup="dialog"
    aria-label={`${label}: review and sign on ${venue}`}
    display="grid"
    gridTemplateColumns="minmax(0, 1fr) auto"
    alignItems="center"
    columnGap={SPACING.sm}
    w="100%"
    minH="44px"
    py={SPACING.xs}
    textAlign="left"
    bg="transparent"
    borderRadius={0}
    borderBottom={`1px dashed ${NEWS.ruleStrong}`}
    color={NEWS.ink}
    cursor="pointer"
    transition={TRANSITIONS.colors}
    _hover={{ color: NEWS.accent, borderColor: NEWS.ink }}
    _focusVisible={FOCUS_STYLES.ring}
  >
    <Mono as="span" color="inherit">
      {label}
    </Mono>
    <Small as="span" color="inherit" whiteSpace="nowrap">
      <Box as="span" display={{ base: 'none', md: 'inline' }}>
        Review{' '}
      </Box>
      ▸
    </Small>
  </Box>
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
  /** Opens the order slip for one lever. */
  onLever: (row: ActionRow) => void
}> = ({ view, horizon, address, staleDays, onLever }) => {
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
                  isExecProtocol(view.protocol) ? (
                    <LeverButton key={a.text} venue={venue} label={label(a)} onOpen={() => onLever(a)} />
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
        empty && <Mono color={NEWS.ink2}>{empty}</Mono>
      )}
      <AlertMeSlot view={view} address={address} />
    </Section>
  )
}
