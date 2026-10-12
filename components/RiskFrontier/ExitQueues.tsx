// Exit queues (lib/position-sim/exitQueueAxis.ts). A liquidation recalls only what is liquid
// inside the call, and a queue pays nothing there, whatever its length (owner, 2026-10-12). So
// the finding is the held −25% step with recall = the vault buffer, at target and drained. Each
// row's measured queue time says how long the rest stays locked. A stale ledger is hatched with
// its age and runs nothing (DESIGN_RULES §4); the headline is suppressed while it is stale.

import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import type { VenueKey } from '@/lib/exitQueue/types'

import { GlyphMark, HATCH, Panel, SectionHead } from './atoms'
import { EXIT_QUEUE_STEP, type ExitQueueRow, type FrontierModel } from './viewModel'

const STEP = `−${Math.round(EXIT_QUEUE_STEP * 100)}%`

// Phones keep the venue and its p90; p50 and the queue fold into the venue's second line.
const COLS = {
  base: 'minmax(0, 1fr) auto',
  md: 'minmax(0, 1.6fr) 72px 72px minmax(0, 1.4fr)',
}

/** A light hatch for a whole stale row: the figures stay legible on it. */
const ROW_HATCH = `repeating-linear-gradient(135deg, transparent 0 7px, ${SEMANTIC_COLORS.borderSubtle} 7px 8px)`

const Cell: React.FC<{ children: React.ReactNode; hideBase?: boolean; muted?: boolean }> = ({
  children,
  hideBase,
  muted,
}) => (
  <Text
    display={hideBase ? { base: 'none', md: 'block' } : 'block'}
    minW={0}
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize={TYPOGRAPHY.xs}
    color={muted ? SEMANTIC_COLORS.textTertiary : SEMANTIC_COLORS.textPrimary}
    overflowWrap="anywhere"
    sx={{ fontVariantNumeric: 'tabular-nums' }}
  >
    {children}
  </Text>
)

const HeadCell: React.FC<{ children: React.ReactNode; hideBase?: boolean }> = ({
  children,
  hideBase,
}) => (
  <Text
    display={hideBase ? { base: 'none', md: 'block' } : 'block'}
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize={TYPOGRAPHY.label}
    letterSpacing="0.2em"
    textTransform="uppercase"
    color={SEMANTIC_COLORS.textTertiary}
  >
    {children}
  </Text>
)

const Row: React.FC<{ row: ExitQueueRow; active: boolean; onPick: () => void }> = ({
  row,
  active,
  onPick,
}) => {
  const live = row.state === 'live'
  return (
    <Box
      as="button"
      type="button"
      onClick={onPick}
      aria-pressed={active}
      aria-label={`${row.name}: p90 ${row.p90Text}${row.stateNote ? `, ${row.stateNote}` : ''}. Pick as where your recall sits.`}
      display="grid"
      gridTemplateColumns={COLS}
      gap={SPACING.sm}
      alignItems="baseline"
      textAlign="left"
      w="100%"
      minH="44px"
      px={SPACING.sm}
      py={SPACING.sm}
      borderTop="1px solid"
      borderColor={active ? SEMANTIC_COLORS.textSecondary : SEMANTIC_COLORS.borderSubtle}
      // Stale and unknown rows are hatched, never coloured: the last reading is not live.
      bgImage={live ? undefined : ROW_HATCH}
      cursor="pointer"
      _hover={{ bg: live ? SEMANTIC_COLORS.bgTertiary : undefined }}
      _focusVisible={FOCUS_STYLES.ring}
      transition={TRANSITIONS.colors}
    >
      <Box minW={0}>
        <Box display="flex" gap={SPACING.sm} alignItems="baseline" minW={0}>
          {!live && <GlyphMark glyph="░" tone="muted" size="12px" title={row.stateNote ?? ''} />}
          <Cell muted={!live}>
            {row.name}
            <Text as="span" color={SEMANTIC_COLORS.textTertiary}>
              {' '}
              · {row.asset}
            </Text>
          </Cell>
        </Box>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.label}
          color={SEMANTIC_COLORS.textTertiary}
          mt={SPACING.xs}
        >
          {/* on phones the p50 and queue columns fold in here */}
          <Box as="span" display={{ base: 'inline', md: 'none' }}>
            p50 {row.p50Text} · {row.queueText} ·{' '}
          </Box>
          {row.stateNote ?? row.ageText}
          {row.oldestText ? ` · ${row.oldestText}` : ''}
        </Text>
      </Box>
      <Cell hideBase muted={!live}>
        {row.p50Text}
      </Cell>
      <Cell muted={!live}>{row.p90Text}</Cell>
      <Cell hideBase muted>
        {row.queueText}
      </Cell>
    </Box>
  )
}

export const ExitQueues: React.FC<{
  model: FrontierModel
  onPick: (venue: VenueKey) => void
}> = ({ model, onPick }) => {
  const q = model.exitQueue
  const sel = q.selected
  return (
    <Panel>
      <SectionHead
        title="Exit queues"
        kicker={`a liquidation uses only what is liquid · held ${STEP} step · pick where your recall sits`}
      />
      {q.dateline && (
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.label}
          letterSpacing="0.12em"
          textTransform="uppercase"
          color={SEMANTIC_COLORS.textTertiary}
          pb={SPACING.sm}
        >
          {q.dateline}
        </Text>
      )}
      {q.missing ? (
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
          color={SEMANTIC_COLORS.textTertiary}
        >
          No exit queue shown: {q.missing}.
        </Text>
      ) : (
        <>
          {/* The finding: live only. While stale the headline is suppressed (§4). */}
          {sel && sel.state === 'live' && sel.finding && (
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={{ base: TYPOGRAPHY.small, md: TYPOGRAPHY.h4 }}
              lineHeight={1.35}
              color={SEMANTIC_COLORS.textPrimary}
            >
              {sel.finding}
            </Text>
          )}
          {sel && sel.state !== 'live' && (
            <Box
              border="1px solid"
              borderColor={SEMANTIC_COLORS.borderStrong}
              bgImage={HATCH}
              px={SPACING.sm}
              py={SPACING.sm}
            >
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.xs}
                color={SEMANTIC_COLORS.textSecondary}
                bg={SEMANTIC_COLORS.bgSecondary}
                display="inline"
              >
                {sel.state === 'stale'
                  ? `${sel.name}: last reading ${sel.ageText}. Stale, not live: nothing is run on it.`
                  : `${sel.name}: ${sel.stateNote}.`}
              </Text>
            </Box>
          )}
          {q.note && (
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textSecondary}
            >
              {q.note}
            </Text>
          )}
          {sel && sel.state === 'live' && q.comparison && (
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.label}
              color={SEMANTIC_COLORS.textSecondary}
              mt={SPACING.sm}
            >
              {q.comparison}
            </Text>
          )}

          <Box mt={SPACING.md} role="group" aria-label="Exit-queue venues">
            <Box
              display="grid"
              gridTemplateColumns={COLS}
              gap={SPACING.sm}
              px={SPACING.sm}
              pb={SPACING.xs}
            >
              <HeadCell>venue</HeadCell>
              <HeadCell hideBase>p50</HeadCell>
              <HeadCell>p90</HeadCell>
              <HeadCell hideBase>queue now</HeadCell>
            </Box>
            {q.rows.map((row) => (
              <Row
                key={row.venue}
                row={row}
                active={sel?.venue === row.venue}
                onPick={() => onPick(row.venue)}
              />
            ))}
          </Box>
          {sel?.credit && (
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.label}
              color={SEMANTIC_COLORS.textTertiary}
              textAlign="right"
              mt={SPACING.sm}
            >
              {sel.credit} · the queue time is not in the run · † modelled, not a guarantee
            </Text>
          )}
        </>
      )}
    </Panel>
  )
}
