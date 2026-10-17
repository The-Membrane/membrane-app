// Distance to danger: one ruler per axis, "you are here" at the left, the edges ahead of it.
// Every figure is a whole unit rounded toward risk (frontier.ts `display`). Venue axes are
// solved at the named −25% step, never folded into one combined route (design §2).

import React from 'react'
import { Box, HStack, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { DEFAULT_MAX_FREEZE_HOURS } from '@/lib/position-sim/frontier'

import { HATCH, Panel, REDUCED_MOTION_SX, SectionHead, TONE_COLOR } from './atoms'
import {
  edgeView,
  usdShort,
  type EdgeView,
  type FrontierModel,
  type Selection,
  type Tone,
} from './viewModel'

type EdgeKey = 'breach' | 'arm' | 'sale'

interface RulerSpec {
  axis: 'price' | 'wick' | 'capacity' | 'freeze'
  name: string
  kicker: string
  max: number
  ticks: { v: number; label: string }[]
  edges: Partial<Record<EdgeKey, EdgeView>>
  /** "of collateral" readout for price axes. */
  collateralUsd?: number
}

const MARK: Record<EdgeKey, { glyph: string; tone: Tone; word: string }> = {
  breach: { glyph: '│', tone: 'recall', word: 'line' },
  arm: { glyph: '▲', tone: 'armed', word: 'window' },
  sale: { glyph: '✖', tone: 'sold', word: 'sale' },
}

const PCT_TICKS = [0, 0.25, 0.5, 0.75, 1].map((v) => ({ v, label: `${Math.round(v * 100)}` }))
const HOUR_TICKS = [0, 8, 24, 48, 72].map((v) => ({ v, label: `${v}h` }))

const Ruler: React.FC<{
  spec: RulerSpec
  selected: Selection | null
  onSelect: (s: Selection) => void
  index: number
}> = ({ spec, selected, onSelect, index }) => {
  const x = (v: number) => `${Math.max(0, Math.min(1, v / spec.max)) * 100}%`
  const order: EdgeKey[] = ['breach', 'arm', 'sale']
  const present = order.filter((k) => spec.edges[k])
  const allNa = present.length > 0 && present.every((k) => spec.edges[k]!.state === 'na')
  const first = present.map((k) => spec.edges[k]!).find((e) => e.state === 'already')
  const hereColor = first ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.success

  // Zones behind the track: each edge tints from itself to the next edge (or the end).
  const zones: { from: number; to: number; tone: Tone }[] = []
  const placed = present
    .map((k) => ({ k, e: spec.edges[k]! }))
    .filter(({ e }) => e.at !== null)
    .sort((a, b) => (a.e.at as number) - (b.e.at as number))
  placed.forEach(({ k, e }, i) => {
    const to = i + 1 < placed.length ? (placed[i + 1].e.at as number) : spec.max
    if (to > (e.at as number)) zones.push({ from: e.at as number, to, tone: MARK[k].tone })
  })

  const isSel = (k: EdgeKey) =>
    selected?.kind === 'edge' && selected.axis === spec.axis && selected.edge === k

  return (
    <Box
      display="grid"
      gridTemplateColumns={{ base: '1fr', md: '170px 1fr' }}
      gap={{ base: SPACING.sm, md: SPACING.md }}
      py={SPACING.sm}
      borderTop={index === 0 ? undefined : '1px solid'}
      borderColor={SEMANTIC_COLORS.borderSubtle}
    >
      <Box>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
          color={SEMANTIC_COLORS.textPrimary}
        >
          {spec.name}
        </Text>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.label}
          color={SEMANTIC_COLORS.textTertiary}
        >
          {spec.kicker}
        </Text>
      </Box>

      <Box position="relative" pt={SPACING['2xl']} pb={SPACING.xs} minW={0}>
        {/* track */}
        <Box
          position="relative"
          h="10px"
          border="1px solid"
          borderColor={SEMANTIC_COLORS.borderSubtle}
          bgImage={allNa ? HATCH : undefined}
          overflow="visible"
        >
          {!allNa &&
            zones.map((z, i) => (
              <Box
                key={i}
                position="absolute"
                top={0}
                bottom={0}
                left={x(z.from)}
                w={`calc(${x(z.to)} - ${x(z.from)})`}
                bg={TONE_COLOR[z.tone]}
                opacity={z.tone === 'sold' ? 0.28 : 0.18}
              />
            ))}
          {/* scale ticks */}
          {spec.ticks.map((t) => (
            <Box
              key={t.v}
              position="absolute"
              left={x(t.v)}
              top="100%"
              h="4px"
              borderLeft="1px solid"
              borderColor={SEMANTIC_COLORS.borderStrong}
            />
          ))}
          {/* you are here */}
          <Box
            position="absolute"
            left={0}
            top="50%"
            transform="translate(-50%, -50%)"
            w="12px"
            h="12px"
            zIndex={2}
          >
            <Box position="absolute" inset={0} borderRadius="50%" bg={hereColor} />
            {/* a static hairline ring marks "here" — no pulse (no ambient motion on app UI) */}
            <Box
              position="absolute"
              inset="-5px"
              borderRadius="50%"
              border="1px solid"
              borderColor={hereColor}
              opacity={0.5}
            />
          </Box>
          {/* edge markers: the line tick crosses the track, ▲ sits above it, ✖ below, so equal distances never collide */}
          {present.map((k) => {
            const e = spec.edges[k]!
            if (e.state === 'na' || e.at === null) return null
            const m = MARK[k]
            const frac = e.at / spec.max
            const usd =
              k === 'sale' && e.node && e.node.exposedUsd > 0
                ? ` · ${usdShort(e.node.exposedUsd)}`
                : ''
            const coll =
              spec.collateralUsd !== undefined && e.state === 'found' && k !== 'breach'
                ? ` · coll ${usdShort(spec.collateralUsd * (1 - (e.at as number)))}`
                : ''
            // Labels run away from their neighbours: the line label to the LEFT of its tick, ▲/✖ to the
            // right. Near the start the line label may only go right if no ▲/✖ sits beside it.
            const crowded =
              k === 'breach' &&
              present.some((o) => {
                const oe = spec.edges[o]!
                return (
                  o !== 'breach' &&
                  oe.at !== null &&
                  Math.abs(oe.at - (e.at as number)) / spec.max < 0.12
                )
              })
            const anchor =
              k === 'breach'
                ? frac < 0.14 && !crowded
                  ? 'translateX(-2px)'
                  : crowded
                    ? 'translateX(calc(-100% - 6px))'
                    : 'translateX(calc(-100% + 2px))'
                : frac > 0.78
                  ? 'translateX(calc(-100% + 8px))'
                  : 'translateX(-8px)'
            const vertical =
              k === 'breach'
                ? { top: '-5px', h: '18px' }
                : k === 'arm'
                  ? { top: '-19px', h: '18px' }
                  : { top: '9px', h: '18px' }
            return (
              <Box
                key={k}
                as="button"
                type="button"
                onClick={() => onSelect({ kind: 'edge', axis: spec.axis, edge: k })}
                aria-label={`${spec.name}: ${m.word} at ${e.text}. ${e.hint}. Show this node.`}
                aria-pressed={isSel(k)}
                title={e.hint}
                position="absolute"
                left={x(e.at)}
                top={vertical.top}
                h={vertical.h}
                minH={vertical.h}
                w="18px"
                ml="-9px"
                zIndex={3}
                display="flex"
                alignItems="center"
                justifyContent="center"
                bg="transparent"
                border="none"
                p={0}
                cursor="pointer"
                _focusVisible={FOCUS_STYLES.ring}
              >
                {k === 'breach' ? (
                  <Box w="2px" h="18px" bg={TONE_COLOR[m.tone]} />
                ) : (
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.small}
                    lineHeight={1}
                    color={TONE_COLOR[m.tone]}
                    fontWeight={isSel(k) ? 700 : undefined}
                  >
                    {m.glyph}
                  </Text>
                )}
                <Text
                  position="absolute"
                  {...(k === 'sale' ? { top: '17px' } : { bottom: '17px' })}
                  left="50%"
                  transform={anchor}
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.label}
                  whiteSpace="nowrap"
                  color={TONE_COLOR[m.tone]}
                  textDecoration={isSel(k) ? 'underline' : undefined}
                  sx={{ fontVariantNumeric: 'tabular-nums' }}
                  pointerEvents="none"
                >
                  {k === 'breach' ? `${m.word} ${e.text}` : `${m.glyph} ${e.text}${usd}${coll}`}
                </Text>
              </Box>
            )
          })}
        </Box>
        {/* tick labels */}
        <Box position="relative" h="12px" mt={SPACING.xl}>
          {spec.ticks.map((t) => (
            <Text
              key={t.v}
              position="absolute"
              left={x(t.v)}
              transform={
                t.v === 0 ? 'none' : t.v >= spec.max ? 'translateX(-100%)' : 'translateX(-50%)'
              }
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.label}
              color={SEMANTIC_COLORS.textTertiary}
            >
              {t.label}
            </Text>
          ))}
        </Box>
        {/* edges that sit off the scale or do not apply */}
        <HStack spacing={SPACING.md} mt={SPACING.xs} flexWrap="wrap">
          {present
            .filter((k) => spec.edges[k]!.at === null)
            .map((k) => (
              <Text
                key={k}
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.label}
                color={SEMANTIC_COLORS.textTertiary}
              >
                {MARK[k].glyph === '│' ? 'line' : MARK[k].glyph} {spec.edges[k]!.text}
              </Text>
            ))}
        </HStack>
      </Box>
    </Box>
  )
}

export const DangerRulers: React.FC<{
  model: FrontierModel
  selected: Selection | null
  onSelect: (s: Selection) => void
}> = ({ model, selected, onSelect }) => {
  const { dtd, sandbox } = model
  const carry = sandbox.position.tradeShape === 'carry'
  const delayed = sandbox.position.membraneClass === 'delayed'
  const coll = sandbox.position.collateralUsd
  const specs: RulerSpec[] = [
    {
      axis: 'price',
      name: 'Collateral price',
      kicker: 'held drop',
      max: 1,
      ticks: PCT_TICKS,
      collateralUsd: coll,
      edges: {
        ...(carry ? { breach: edgeView(dtd.price.breach, 'drop') } : {}),
        arm: edgeView(dtd.price.arm, 'drop'),
        sale: edgeView(dtd.price.sale, 'drop'),
      },
    },
    {
      axis: 'wick',
      name: 'Price wick',
      kicker: delayed ? 'recovers after 1 minute' : 'recovers after 1 minute · no window',
      max: 1,
      ticks: PCT_TICKS,
      collateralUsd: coll,
      edges: { sale: edgeView(dtd.saleAtShock, 'drop') },
    },
    {
      axis: 'capacity',
      name: 'Venue exit',
      kicker: 'cut to exit capacity · at −25% step',
      max: 1,
      ticks: PCT_TICKS,
      edges: { arm: edgeView(dtd.capacity.arm, 'cut'), sale: edgeView(dtd.capacity.sale, 'cut') },
    },
    {
      axis: 'freeze',
      name: 'Venue freeze',
      kicker: 'hours from first breach · at −25% step',
      max: DEFAULT_MAX_FREEZE_HOURS,
      ticks: HOUR_TICKS,
      edges: { arm: edgeView(dtd.freeze.arm, 'freeze'), sale: edgeView(dtd.freeze.sale, 'freeze') },
    },
  ]
  return (
    <Panel sx={REDUCED_MOTION_SX}>
      <SectionHead
        title="Distance to danger"
        kicker="smallest single shock that changes the outcome · rounded toward risk"
      />
      {specs.map((s, i) => (
        <Ruler key={s.axis} spec={s} index={i} selected={selected} onSelect={onSelect} />
      ))}
      <HStack spacing={SPACING.md} mt={SPACING.sm} flexWrap="wrap" rowGap={SPACING.xs}>
        {carry && (
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.label}
            color={TONE_COLOR.recall}
          >
            │ line crossed, recall fires
          </Text>
        )}
        {delayed && (
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.label}
            color={TONE_COLOR.armed}
          >
            ▲ window arms
          </Text>
        )}
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.label} color={TONE_COLOR.sold}>
          ✖ collateral sold ($ at the edge)
        </Text>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.label}
          color={SEMANTIC_COLORS.textTertiary}
        >
          {'"35%" = nothing at 35%; the edge is in (35%, 36%]'}
        </Text>
      </HStack>
    </Panel>
  )
}
