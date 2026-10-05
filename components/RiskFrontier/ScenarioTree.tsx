// The branching scenario tree (design §3): "now" on the left, one equal-width branch per named
// scenario, each drawn along a time track to its leaf. Venue branches fork off the −25% step
// at its first breach (a freeze counts from it). No weights, no odds: branch width and order
// carry no meaning. Changed branches redraw; unchanged ones stay put.

import React from 'react'
import { Box, HStack, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

import { GlyphMark, HATCH, Legend, REDUCED_MOTION_SX, TONE_COLOR } from './atoms'
import { TIME_TICKS, duration, timeX, type Lane, type LaneEvent, type Selection } from './viewModel'

const GRID = {
  display: 'grid',
  gridTemplateColumns: { base: '40px minmax(0,1fr) auto', md: '40px 150px minmax(0,1fr) 176px' },
  gridTemplateAreas: {
    base: `"conn label leaf" "conn track track"`,
    md: `"conn label track leaf"`,
  },
  columnGap: { base: SPACING.sm, md: SPACING.md },
  alignItems: 'center',
} as const

const TRUNK_X = 8
const FORK_X = 24
const line = SEMANTIC_COLORS.borderStrong

const pctX = (x: number) => `${Math.max(0, Math.min(1, x)) * 100}%`

const EVENT_GLYPH: Record<LaneEvent['kind'], { glyph: string; tone: keyof typeof TONE_COLOR }> = {
  breach: { glyph: '│', tone: 'recall' },
  // hollow: the venue answering after a freeze is an event, not the ◆ outcome
  recall: { glyph: '◇', tone: 'recall' },
  arm: { glyph: '▲', tone: 'armed' },
  sale: { glyph: '✖', tone: 'sold' },
}

/** Decorative tree lines in the first column. */
const Connector: React.FC<{
  lane: Lane
  lastTop: boolean
  lastChild: boolean
  hasChildren: boolean
  trunkContinues: boolean
}> = ({ lane, lastTop, lastChild, hasChildren, trunkContinues }) => {
  const top = lane.parent === null
  return (
    <Box gridArea="conn" position="relative" alignSelf="stretch" minH="44px" aria-hidden>
      {/* trunk */}
      {(top || trunkContinues) && (
        <Box
          position="absolute"
          left={`${TRUNK_X}px`}
          top={0}
          h={top && lastTop ? '50%' : '100%'}
          borderLeft="1px solid"
          borderColor={line}
        />
      )}
      {top && (
        <Box
          position="absolute"
          left={`${TRUNK_X}px`}
          top="50%"
          w={`${40 - TRUNK_X}px`}
          borderTop="1px solid"
          borderColor={line}
        />
      )}
      {/* fork down to the venue sub-branches */}
      {hasChildren && (
        <Box
          position="absolute"
          left={`${FORK_X}px`}
          top="50%"
          bottom={0}
          borderLeft="1px solid"
          borderColor={line}
        />
      )}
      {!top && (
        <>
          <Box
            position="absolute"
            left={`${FORK_X}px`}
            top={0}
            h={lastChild ? '50%' : '100%'}
            borderLeft="1px solid"
            borderColor={line}
          />
          <Box
            position="absolute"
            left={`${FORK_X}px`}
            top="50%"
            w={`${40 - FORK_X}px`}
            borderTop="1px solid"
            borderColor={line}
          />
        </>
      )}
    </Box>
  )
}

// No draw-in, pop or fade entrances: app UI moves by colour and border only (CLAUDE.md,
// Animations — no scale, no glow, no ambient motion outside atmosphere layers).
const Track: React.FC<{ lane: Lane; delayed: boolean }> = ({ lane, delayed }) => {
  const nm = !lane.result || lane.result.outcome === 'not_modelled'
  return (
    <Box gridArea="track" position="relative" h="28px" minW={0}>
      {/* time guides */}
      {TIME_TICKS.slice(1).map((t) => (
        <Box
          key={t.s}
          position="absolute"
          left={pctX(timeX(t.s))}
          top={0}
          bottom={0}
          borderLeft="1px dashed"
          borderColor={
            t.s === 8 * 3600 && delayed
              ? SEMANTIC_COLORS.borderStrong
              : SEMANTIC_COLORS.borderSubtle
          }
          opacity={0.6}
        />
      ))}
      {/* base line */}
      <Box
        position="absolute"
        left={pctX(lane.startX)}
        w={`calc(${pctX(lane.endX)} - ${pctX(lane.startX)})`}
        top="13px"
        h="1px"
        bg={SEMANTIC_COLORS.borderSubtle}
      />
      {nm ? (
        <Box
          position="absolute"
          left={pctX(lane.startX)}
          right={0}
          top="9px"
          h="10px"
          bgImage={HATCH}
          border="1px solid"
          borderColor={SEMANTIC_COLORS.borderSubtle}
        />
      ) : (
        lane.segments.map((s, i) => (
          <Box
            key={i}
            position="absolute"
            left={pctX(s.from)}
            w={`calc(${pctX(s.to)} - ${pctX(s.from)})`}
            top={s.tone === 'idle' ? '13px' : '11px'}
            h={s.tone === 'idle' ? '1px' : '5px'}
            bg={TONE_COLOR[s.tone]}
          />
        ))
      )}
      {/* events */}
      {lane.events.map((e) => {
        const g = EVENT_GLYPH[e.kind]
        return (
          <Text
            key={`${e.kind}-${e.seconds}`}
            position="absolute"
            left={pctX(e.x)}
            top={e.kind === 'breach' ? '6px' : '5px'}
            transform="translateX(-50%)"
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={e.kind === 'breach' ? TYPOGRAPHY.xs : TYPOGRAPHY.small}
            lineHeight={1}
            color={TONE_COLOR[g.tone]}
            title={`${e.label} at ${duration(e.seconds)}`}
          >
            {g.glyph}
          </Text>
        )
      })}
      {/* the leaf at the end of the walk: the outcome's own glyph, so shape carries it too */}
      {!nm && (
        <Text
          position="absolute"
          left={pctX(lane.endX)}
          top="14px"
          transform="translate(-50%, -50%)"
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.small}
          lineHeight={1}
          color={TONE_COLOR[lane.leaf.tone]}
          aria-hidden
        >
          {lane.leaf.glyph}
        </Text>
      )}
    </Box>
  )
}

export const ScenarioTree: React.FC<{
  lanes: Lane[]
  delayed: boolean
  selected: Selection | null
  onSelect: (s: Selection) => void
}> = ({ lanes, delayed, selected, onSelect }) => {
  const tops = lanes.filter((l) => l.parent === null)
  const lastTopId = tops[tops.length - 1]?.id
  return (
    <Box sx={REDUCED_MOTION_SX} role="group" aria-label="Scenario tree">
      {/* root row: "now" and the time axis */}
      <Box {...GRID} mb={SPACING.xs}>
        <Box gridArea="conn" position="relative" h="28px" aria-hidden>
          <Box
            position="absolute"
            left={`${TRUNK_X - 5}px`}
            top="9px"
            w="11px"
            h="11px"
            borderRadius="50%"
            bg={SEMANTIC_COLORS.success}
          />
          <Box
            position="absolute"
            left={`${TRUNK_X}px`}
            top="20px"
            bottom="-2px"
            borderLeft="1px solid"
            borderColor={line}
          />
        </Box>
        <Text
          gridArea="label"
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.label}
          letterSpacing="0.16em"
          color={SEMANTIC_COLORS.success}
        >
          NOW
        </Text>
        <Box gridArea="track" position="relative" h="16px" display={{ base: 'none', md: 'block' }}>
          {TIME_TICKS.filter((t) => t.s !== 60).map((t) => (
            <Text
              key={t.s}
              position="absolute"
              left={pctX(timeX(t.s))}
              transform={t.s === 0 ? 'none' : 'translateX(-50%)'}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.label}
              color={
                t.s === 8 * 3600 && delayed ? SEMANTIC_COLORS.warning : SEMANTIC_COLORS.textTertiary
              }
              whiteSpace="nowrap"
            >
              {t.s === 8 * 3600 && delayed ? '8h window' : t.label}
            </Text>
          ))}
        </Box>
        <Text
          gridArea="leaf"
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.label}
          letterSpacing="0.16em"
          color={SEMANTIC_COLORS.textTertiary}
          display={{ base: 'none', md: 'block' }}
        >
          LEAF
        </Text>
      </Box>

      {lanes.map((lane) => {
        const children = lanes.filter((l) => l.parent === lane.id)
        const siblings = lane.parent ? lanes.filter((l) => l.parent === lane.parent) : []
        const lastChild = lane.parent !== null && siblings[siblings.length - 1]?.id === lane.id
        const topIndex = tops.findIndex((t) => t.id === (lane.parent ?? lane.id))
        const trunkContinues = topIndex < tops.length - 1
        const active = selected?.kind === 'lane' && selected.id === lane.id
        const leafColor = TONE_COLOR[lane.leaf.tone]
        return (
          <Box
            key={`${lane.id}:${lane.signature}`}
            as="button"
            type="button"
            onClick={() => onSelect({ kind: 'lane', id: lane.id })}
            aria-pressed={active}
            aria-label={`${lane.label}, ${lane.sub}: ${lane.leaf.title}, ${lane.leaf.short}. Show detail.`}
            {...GRID}
            w="100%"
            textAlign="left"
            py={SPACING.xs}
            bg={active ? SEMANTIC_COLORS.bgTertiary : 'transparent'}
            boxShadow={active ? `inset 2px 0 0 ${leafColor}` : undefined}
            cursor="pointer"
            transition={TRANSITIONS.colors}
            _hover={{ bg: SEMANTIC_COLORS.bgTertiary }}
            _focusVisible={FOCUS_STYLES.ring}
          >
            <Connector
              lane={lane}
              lastTop={lane.id === lastTopId}
              lastChild={lastChild}
              hasChildren={children.length > 0}
              trunkContinues={trunkContinues}
            />
            <Box as="span" gridArea="label" display="block" minW={0} py={SPACING.xs}>
              <Text
                as="span"
                display="block"
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.xs}
                color={SEMANTIC_COLORS.textPrimary}
                noOfLines={1}
              >
                {lane.label}
              </Text>
              <Text
                as="span"
                display="block"
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.label}
                color={SEMANTIC_COLORS.textTertiary}
                noOfLines={2}
              >
                {lane.sub}
              </Text>
            </Box>
            <Track lane={lane} delayed={delayed} />
            <HStack as="span" gridArea="leaf" spacing={SPACING.sm} minW={0}>
              <GlyphMark
                glyph={lane.leaf.glyph}
                tone={lane.leaf.tone}
                size="15px"
                title={lane.leaf.title}
              />
              <Box as="span" display="block" minW={0}>
                <Text
                  as="span"
                  display="block"
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.label}
                  color={leafColor}
                  noOfLines={1}
                >
                  {lane.leaf.title}
                </Text>
                <Text
                  as="span"
                  display="block"
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.label}
                  color={SEMANTIC_COLORS.textSecondary}
                  noOfLines={1}
                  sx={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {lane.leaf.short}
                </Text>
              </Box>
            </HStack>
          </Box>
        )
      })}

      <Legend
        delayed={delayed}
        extra={
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.label}
            color={SEMANTIC_COLORS.textTertiary}
          >
            │ line crossed · ◇ venue answers · equal-width branches · no weights
          </Text>
        }
      />
    </Box>
  )
}
