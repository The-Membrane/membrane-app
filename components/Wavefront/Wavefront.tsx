import React, { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  AspectRatio,
  Box,
  Button,
  chakra,
  Container,
  Flex,
  Grid,
  Text,
  VStack,
} from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { ACTIVE_EFFECTS, FOCUS_STYLES, HOVER_EFFECTS, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { resolveColor } from '@/helpers/resolveToken'
import { useThemeMode } from '@/hooks/useThemeMode'
import { MODELLED_FOOTNOTE } from '@/lib/position-sim/guarantee'
import {
  CURE_WINDOW_HOURS,
  LIQ_DEBT_MINIMUM_USD,
  MAX_THRESHOLD_TO_DELAY,
} from '@/lib/position-sim/membrane'

import { Bars, barsNote } from './Bars'
import {
  chainList,
  displayName,
  fmtClock,
  fmtInt,
  fmtPctFloor,
  fmtUsd,
  fmtWindow,
  notComparedLine,
} from './format'
import { panelGeometry, type PanelGeometry } from './geometry'
import { LegendItem } from './Glyph'
import { HexPanel } from './HexPanel'
import { useElementSize, useWavefrontStream, type WavefrontMode } from './hooks'
import { MARK_TOKEN, type MarkKind, type MarkPalette } from './marks'
import { BIN_SECONDS, type WavefrontFrame } from './model'

/** Live only when the flag is on AND the endpoint answers (owner, 2026-10-14). */
export const WAVEFRONT_LIVE_FLAG = process.env.NEXT_PUBLIC_WAVEFRONT_LIVE === '1'

const ENGINE_LINE =
  `Membrane side: the position simulator (${CURE_WINDOW_HOURS}h window within ` +
  `${Math.round(MAX_THRESHOLD_TO_DELAY * 100)}% of the line, none for stablecoins†; ` +
  `repay to cap; $${LIQ_DEBT_MINIMUM_USD.toLocaleString('en-US')} floor).`

const NBSP = ' '

const mono = { fontFamily: TYPOGRAPHY.fontMono, sx: { fontVariantNumeric: 'tabular-nums' } }

const Eyebrow: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Text
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize={TYPOGRAPHY.label}
    textTransform="uppercase"
    letterSpacing="0.28em"
    color={SEMANTIC_COLORS.textSecondary}
  >
    {children}
  </Text>
)

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const on = () => setReduced(mq.matches)
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, [])
  return reduced
}

// ------------------------------------------------------------------ pieces (memoised)

interface MastheadProps {
  kicker: string
  liquidated: number | null
  realUsd: number | null
  memUsd: number | null
  walked: number | null
  total: number | null
  /** null: the stream has no position that is not walked, so the line is not shown at all. */
  notComparedText: string | null
  clock: string
  lastHour: number | null
}

/** Kicker → headline → deck, the figures; the clock on the right. */
const Masthead = memo(function Masthead(p: MastheadProps) {
  return (
    <Flex
      as="header"
      direction={{ base: 'column', md: 'row' }}
      justify="space-between"
      align={{ base: 'stretch', md: 'flex-end' }}
      gap={{ base: SPACING.sm, md: SPACING.xl }}
      borderTop="3px double"
      borderColor={SEMANTIC_COLORS.borderStrong}
      pt={SPACING.sm}
    >
      <VStack align="flex-start" spacing={SPACING.xs} minW={0}>
        <Eyebrow>{p.kicker}</Eyebrow>
        <Text
          as="h1"
          fontFamily={TYPOGRAPHY.fontDisplay}
          fontSize={{ base: TYPOGRAPHY.h2, md: TYPOGRAPHY.h1 }}
          fontWeight={TYPOGRAPHY.bold}
          lineHeight="1.1"
          color={SEMANTIC_COLORS.textPrimary}
        >
          <Text as="span" {...mono}>
            {p.liquidated === null ? '—' : fmtInt(p.liquidated)}
          </Text>{' '}
          {p.liquidated === 1 ? 'position' : 'positions'} liquidated so far
        </Text>
        <Text
          fontFamily={TYPOGRAPHY.fontDisplay}
          fontStyle="italic"
          fontSize={TYPOGRAPHY.h4}
          color={SEMANTIC_COLORS.textSecondary}
        >
          One hex per liquidated position.
        </Text>
        <Text
          {...mono}
          fontSize={TYPOGRAPHY.small}
          fontWeight={TYPOGRAPHY.semibold}
          color={SEMANTIC_COLORS.textPrimary}
        >
          Debt force-closed: real {p.realUsd === null ? '—' : fmtUsd(p.realUsd)} · Membrane{' '}
          {p.memUsd === null ? '—' : fmtUsd(p.memUsd)}†
        </Text>
        {/* Both lines hold their height, so the panels never jump during play. */}
        <Text {...mono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary}>
          {p.walked !== null && p.total
            ? `Same ${fmtInt(p.walked)} positions on both sides · ` +
              `${fmtInt(p.walked)} of ${fmtInt(p.total)} liquidated ` +
              `(${fmtPctFloor(p.walked, p.total)})`
            : NBSP}
        </Text>
        {p.notComparedText !== null ? (
          <Text {...mono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textTertiary}>
            {p.notComparedText}
          </Text>
        ) : null}
      </VStack>
      <Flex
        direction={{ base: 'row', md: 'column' }}
        align={{ base: 'baseline', md: 'flex-end' }}
        columnGap={SPACING.md}
        rowGap={SPACING.xs}
        wrap="wrap"
        flex="none"
      >
        <Text
          {...mono}
          fontSize={{ base: TYPOGRAPHY.h3, md: TYPOGRAPHY.h2 }}
          fontWeight={TYPOGRAPHY.medium}
          color={SEMANTIC_COLORS.textPrimary}
        >
          {p.clock}
        </Text>
        <Text {...mono} fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textSecondary}>
          {p.lastHour === null ? NBSP : `${fmtInt(p.lastHour)} in the last hour`}
        </Text>
      </Flex>
    </Flex>
  )
})

interface LegendDatum {
  kind: MarkKind
  count: number
  label: string
}

const sameLegend = (a: LegendDatum[], b: LegendDatum[]) =>
  a.length === b.length && a.every((x, i) => x.count === b[i].count && x.label === b[i].label)

const PanelHeader = memo(
  function PanelHeader({ title, items }: { title: string; items: LegendDatum[] }) {
    return (
      <VStack
        align="stretch"
        spacing={SPACING.xs}
        borderBottom="1px solid"
        borderColor={SEMANTIC_COLORS.borderSubtle}
        pb={SPACING.xs}
      >
        <Eyebrow>{title}</Eyebrow>
        {/* Same height on both sides at lg+, so the two panels start on the same line. */}
        <Flex
          wrap="wrap"
          columnGap={SPACING.md}
          rowGap={SPACING.xs}
          align="center"
          alignContent="flex-start"
          minH={{ base: '18px', lg: '40px', xl: '18px' }}
        >
          {items.map((it) => (
            <LegendItem key={it.label} kind={it.kind} count={fmtInt(it.count)} label={it.label} />
          ))}
        </Flex>
      </VStack>
    )
  },
  (a, b) => a.title === b.title && sameLegend(a.items, b.items),
)

const Controls = memo(function Controls(p: {
  playing: boolean
  disabled: boolean
  steps: number
  step: number
  valueText: string | undefined
  onToggle: () => void
  onScrub: (e: React.ChangeEvent<HTMLInputElement>) => void
}) {
  const id = useId()
  return (
    // The one gesture. Sticky, so it stays in reach while the panels scroll by.
    <Flex
      align="center"
      gap={SPACING.md}
      position="sticky"
      bottom={0}
      zIndex={1}
      bg={SEMANTIC_COLORS.bgPrimary}
      borderTop="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
      py={SPACING.sm}
    >
      <Button
        type="button"
        onClick={p.onToggle}
        isDisabled={p.disabled}
        aria-label={p.playing ? 'Pause the replay' : 'Play the replay'}
        variant="outline"
        borderRadius={0}
        w="auto"
        flex="none"
        minW="96px"
        minH="44px"
        color={SEMANTIC_COLORS.textPrimary}
        borderColor={SEMANTIC_COLORS.borderStrong}
        transition={TRANSITIONS.colors}
        _hover={HOVER_EFFECTS.borderHighlight}
        _active={ACTIVE_EFFECTS.dim}
        _focus={FOCUS_STYLES.ring}
        _focusVisible={FOCUS_STYLES.ring}
      >
        {p.playing ? 'Pause' : 'Play'}
      </Button>
      <Text
        as="label"
        htmlFor={id}
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.label}
        textTransform="uppercase"
        letterSpacing="0.28em"
        color={SEMANTIC_COLORS.textSecondary}
      >
        Time
      </Text>
      <chakra.input
        id={id}
        type="range"
        min={0}
        max={p.steps}
        step={1}
        value={Math.min(p.steps, Math.max(0, p.step))}
        onChange={p.onScrub}
        disabled={p.disabled}
        aria-valuetext={p.valueText}
        flex="1"
        minW={0}
        h="44px"
        bg="transparent"
        cursor="pointer"
        sx={{ accentColor: SEMANTIC_COLORS.textPrimary }}
        transition={TRANSITIONS.colors}
        _focus={{ outline: 'none' }}
        _focusVisible={FOCUS_STYLES.ring}
      />
    </Flex>
  )
})

const Colophon = memo(function Colophon({ note, credit }: { note: string; credit: string }) {
  return (
    <>
      <Text {...mono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary}>
        {ENGINE_LINE}
      </Text>
      <Flex
        as="footer"
        justify="space-between"
        wrap="wrap"
        columnGap={SPACING.lg}
        rowGap={SPACING.xs}
        borderTop="1px solid"
        borderColor={SEMANTIC_COLORS.borderSubtle}
        pt={SPACING.sm}
      >
        <Text {...mono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary}>
          {note}
        </Text>
        <Text
          {...mono}
          fontSize={TYPOGRAPHY.xs}
          color={SEMANTIC_COLORS.textTertiary}
          textAlign="right"
        >
          {credit}
        </Text>
      </Flex>
    </>
  )
})

const EMPTY_GEOMETRY: PanelGeometry = {
  xs: new Float32Array(0),
  ys: new Float32Array(0),
  rho: 1,
  labels: [],
  layout: { scale: 1, clusters: [] },
}

interface SideProps {
  title: string
  legend: LegendDatum[]
  frame: WavefrontFrame | null
  codes: Uint8Array | null
  geometry: PanelGeometry
  palette: MarkPalette
  size: { width: number; height: number }
  sizeRef?: React.RefObject<HTMLDivElement>
  ariaLabel: string
  bars: { values: number[]; note: string; ariaLabel: string } | null
  loadingText: string
}

const Side: React.FC<SideProps> = ({
  title,
  legend,
  frame,
  codes,
  geometry,
  palette,
  size,
  sizeRef,
  ariaLabel,
  bars,
  loadingText,
}) => (
  <VStack as="section" align="stretch" spacing={SPACING.sm} minW={0}>
    <PanelHeader title={title} items={legend} />
    <AspectRatio ratio={{ base: 1, lg: 740 / 390 }} w="100%">
      <Box ref={sizeRef}>
        {frame && codes ? (
          <HexPanel
            width={size.width}
            height={size.height}
            codes={codes}
            geometry={geometry}
            palette={palette}
            ariaLabel={ariaLabel}
            emptyText={frame.n === 0 ? 'No liquidations yet' : undefined}
          />
        ) : (
          <Flex
            w="100%"
            h="100%"
            align="center"
            justify="center"
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textTertiary}
          >
            {loadingText}
          </Flex>
        )}
      </Box>
    </AspectRatio>
    {bars && frame ? (
      <Bars
        values={bars.values}
        max={frame.bars.max}
        fromTs={frame.bars.fromTs}
        toTs={frame.bars.toTs}
        note={bars.note}
        ariaLabel={bars.ariaLabel}
      />
    ) : (
      <Box h="90px" />
    )}
  </VStack>
)

export interface WavefrontProps {
  /** Initial playhead (unix s), e.g. from ?t=. Disables auto-play. */
  initialT?: number | null
}

/**
 * Real vs Membrane liquidation wavefront (Q28). One hex per liquidated position the simulator
 * walks, grouped by collateral; Real (measured) on the left, the same positions under
 * Membrane's position simulator on the right. Port of the owner's canvas (board
 * Wavefront.dc.html) onto the app's tokens. Every count and $ total is the stream reducer's
 * (components/Wavefront/model.ts).
 */
export const Wavefront: React.FC<WavefrontProps> = ({ initialT = null }) => {
  const [mode, setMode] = useState<WavefrontMode>(WAVEFRONT_LIVE_FLAG ? 'live' : 'replay')
  const reducedMotion = usePrefersReducedMotion()
  const stream = useWavefrontStream({
    mode,
    initialT,
    autoPlay: !reducedMotion && initialT == null,
  })
  // Live was asked for but the endpoint did not answer: show the replay, and say so.
  useEffect(() => {
    if (stream.mode === 'live' && stream.status === 'unavailable') setMode('replay')
  }, [stream.mode, stream.status])

  const { frame, seek, start, end } = stream
  const isLive = stream.mode === 'live' && stream.status === 'ready'

  const { mode: theme } = useThemeMode()
  const palette = useMemo<MarkPalette>(
    () => ({
      sold: resolveColor(MARK_TOKEN.sold),
      armed: resolveColor(MARK_TOKEN.armed),
      kept: resolveColor(MARK_TOKEN.kept),
    }),
    // theme: re-resolve the tokens when the theme flips
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [theme],
  )

  // Both panels are the same size (one grid track each); measure one.
  const sizeRef = useRef<HTMLDivElement>(null)
  const size = useElementSize(sizeRef)
  const geometry = useMemo(
    () =>
      frame && size.width > 0 && size.height > 0
        ? panelGeometry(frame, size.width, size.height)
        : EMPTY_GEOMETRY,
    [frame, size.width, size.height],
  )

  const onScrub = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      seek(Math.min(end, start + Number(e.target.value) * BIN_SECONDS))
    },
    [seek, start, end],
  )

  const kicker = isLive
    ? `Live · updated ${stream.updatedAt ? fmtClock(stream.updatedAt) : '—'}`
    : `Replay · ${stream.window ? fmtWindow(stream.window.startTs, stream.window.endTs) : '…'}`
  const loadingText =
    stream.status === 'error' || (stream.status === 'ready' && !frame)
      ? `Replay did not load${stream.error ? ` (${stream.error})` : ''}.`
      : 'Loading…'

  const T = frame?.totals
  const realLegend = useMemo<LegendDatum[]>(
    () => (frame ? [{ kind: 'sold', count: frame.coverage.walked, label: 'sold' }] : []),
    [frame],
  )
  const memLegend = useMemo<LegendDatum[]>(
    () =>
      frame
        ? [
            { kind: 'sold', count: frame.totals.mem.positionsSold, label: 'partly or fully sold' },
            { kind: 'armed', count: frame.totals.mem.positionsArmed, label: 'in 8h window' },
            { kind: 'kept', count: frame.totals.mem.positionsKept, label: 'kept' },
          ]
        : [],
    [frame],
  )

  const unpricedReal = T?.real.unpricedEvents ?? 0
  const unpricedMem = T?.mem.unpricedSales ?? 0
  const note =
    MODELLED_FOOTNOTE +
    (unpricedReal || unpricedMem
      ? ` · $ skips sales with no USD price: ${fmtInt(unpricedReal)} real, ${fmtInt(unpricedMem)} simulated`
      : '')
  const credit = stream.protocols.length
    ? `${stream.protocols.map(displayName).join(' + ')} · ${chainList(stream.chains)} · protocol oracle prices`
    : NBSP

  return (
    <Container
      maxW="1600px"
      px={SPACING_PATTERNS.pagePadding}
      py={{ base: SPACING.base, lg: SPACING.lg }}
    >
      <VStack align="stretch" spacing={{ base: SPACING.base, lg: SPACING.md }}>
        <Masthead
          kicker={kicker}
          liquidated={frame ? frame.coverage.total : null}
          realUsd={T ? T.real.repaidUsd : null}
          memUsd={T ? T.mem.repaidUsd : null}
          walked={frame ? frame.coverage.walked : null}
          total={frame ? frame.coverage.total : null}
          notComparedText={
            !frame || frame.notCompared.inStream === 0 ? null : notComparedLine(frame.notCompared)
          }
          clock={frame ? fmtClock(frame.t) : NBSP}
          lastHour={frame ? frame.lastHour : null}
        />

        <Grid
          templateColumns={{ base: 'minmax(0, 1fr)', lg: 'repeat(2, minmax(0, 1fr))' }}
          columnGap={{ base: SPACING.lg, xl: SPACING.xl }}
          rowGap={SPACING.lg}
        >
          <Side
            title="Real · measured"
            legend={realLegend}
            frame={frame}
            codes={frame ? frame.real : null}
            geometry={geometry}
            palette={palette}
            size={size}
            sizeRef={sizeRef}
            ariaLabel={
              frame ? `Real, measured: ${fmtInt(frame.coverage.walked)} positions sold.` : ''
            }
            bars={
              frame
                ? {
                    values: frame.bars.real,
                    note: barsNote(frame.bars.max),
                    ariaLabel: `Real: positions sold per 10 minutes over the last 12 hours; peak ${fmtInt(Math.max(...frame.bars.real))}.`,
                  }
                : null
            }
            loadingText={loadingText}
          />
          <Side
            title="Membrane · same positions (simulator)"
            legend={memLegend}
            frame={frame}
            codes={frame ? frame.mem : null}
            geometry={geometry}
            palette={palette}
            size={size}
            ariaLabel={
              frame
                ? `Membrane simulator, same positions: ${fmtInt(frame.totals.mem.positionsSold)} partly or fully sold, ` +
                  `${fmtInt(frame.totals.mem.positionsArmed)} in the 8-hour window, ${fmtInt(frame.totals.mem.positionsKept)} kept.`
                : ''
            }
            bars={
              frame
                ? {
                    values: frame.bars.mem,
                    note: 'same scale',
                    ariaLabel: `Membrane simulator: positions sold per 10 minutes over the last 12 hours, same scale; peak ${fmtInt(Math.max(...frame.bars.mem))}.`,
                  }
                : null
            }
            loadingText={loadingText}
          />
        </Grid>

        <Controls
          playing={stream.playing}
          disabled={!frame}
          steps={Math.max(1, Math.ceil((end - start) / BIN_SECONDS))}
          step={Math.round((stream.t - start) / BIN_SECONDS)}
          valueText={frame ? fmtClock(frame.t) : undefined}
          onToggle={stream.togglePlay}
          onScrub={onScrub}
        />

        <Colophon note={note} credit={credit} />
      </VStack>
    </Container>
  )
}
