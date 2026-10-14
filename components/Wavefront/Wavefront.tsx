import React, { memo, useCallback, useEffect, useMemo, useRef, useState, useId } from 'react'
import {
  AspectRatio,
  Box,
  Button,
  chakra,
  Container,
  Flex,
  Grid,
  HStack,
  Text,
  VisuallyHidden,
  VStack,
} from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { ACTIVE_EFFECTS, FOCUS_STYLES, HOVER_EFFECTS, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { resolveColor } from '@/helpers/resolveToken'
import { useThemeMode } from '@/hooks/useThemeMode'
import { MODELLED_FOOTNOTE } from '@/lib/position-sim/guarantee'

import { Bars, barsNote } from './Bars'
import {
  coverageText,
  ENGINE_LINE,
  gridEndText,
  headlineCount,
  kickerText,
  memStates,
  NBSP,
  scaleNote,
  unpricedText,
  type LegendDatum,
} from './copy'
import { chainList, displayName, fmtClock, fmtInt, fmtUsd, notComparedLine } from './format'
import { choosePerHex, panelGeometry, type PanelGeometry } from './geometry'
import { Glyph, LegendItem } from './Glyph'
// TWO_UP: below 600 px the panels stack and a compact comparison table leads
import { HexPanel, TWO_UP } from './HexPanel'
import { useElementSize, useWavefrontStream, type WavefrontMode } from './hooks'
import type { WavefrontStream } from './hooks/useWavefrontStream'
import { ageAlphas, MARK_TOKEN, type MarkPalette } from './marks'
import { BIN_SECONDS, type WavefrontFrame } from './model'

/** Live only when the flag is on AND the endpoint answers (owner, 2026-10-14). */
export const WAVEFRONT_LIVE_FLAG = process.env.NEXT_PUBLIC_WAVEFRONT_LIVE === '1'

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
  count: string
  realUsd: number | null
  memUsd: number | null
  coverage: string
  notComparedText: string | null
  clock: string
  lastHour: number | null
}

/** Kicker → headline, the figures; the clock on the right. */
const Masthead = memo(function Masthead(p: MastheadProps) {
  return (
    <Flex
      as="header"
      direction={{ base: 'column', md: 'row' }}
      justify="space-between"
      align={{ base: 'stretch', md: 'flex-end' }}
      gap={{ base: SPACING.xs, md: SPACING.xl }}
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
            {p.count}
          </Text>{' '}
          {p.count === '1' ? 'position' : 'positions'} liquidated so far
        </Text>
        {/* On phones the comparison table carries the $; from 600 px this line does. */}
        <Text
          {...mono}
          fontSize={TYPOGRAPHY.small}
          fontWeight={TYPOGRAPHY.semibold}
          color={SEMANTIC_COLORS.textPrimary}
          display="none"
          sx={{ ...mono.sx, [TWO_UP]: { display: 'block' } }}
        >
          Debt force-closed: real {p.realUsd === null ? '—' : fmtUsd(p.realUsd)} · Membrane{' '}
          {p.memUsd === null ? '—' : fmtUsd(p.memUsd)}†
        </Text>
        <Text {...mono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary}>
          {p.coverage}
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

const cellBase: React.CSSProperties = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: TYPOGRAPHY.xs,
  padding: 'var(--chakra-space-1) 0',
  borderBottom: `1px solid ${SEMANTIC_COLORS.borderSubtle}`,
  fontVariantNumeric: 'tabular-nums',
  fontWeight: 'normal',
}
const cellLabel: React.CSSProperties = {
  ...cellBase,
  textAlign: 'left',
  color: SEMANTIC_COLORS.textSecondary,
}
const cellNum: React.CSSProperties = {
  ...cellBase,
  textAlign: 'right',
  color: SEMANTIC_COLORS.textPrimary,
}
const cellHead: React.CSSProperties = {
  ...cellBase,
  textAlign: 'right',
  fontSize: TYPOGRAPHY.label,
  textTransform: 'uppercase',
  letterSpacing: '0.28em',
  color: SEMANTIC_COLORS.textSecondary,
}
const glyphRow: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--chakra-space-1)',
}

/**
 * Phones (< 600 px), where the panels stack: the comparison itself, both sides in one table
 * on the first screen. Same reducer counts as the legends it replaces. Plain elements: it
 * re-renders every frame.
 */
const CompareTable = memo(function CompareTable({
  realSold,
  states,
  realUsd,
  memUsd,
}: {
  realSold: number
  states: LegendDatum[]
  realUsd: number
  memUsd: number
}) {
  const rows: { kind?: LegendDatum['kind']; label: string; real: string; mem: string }[] = [
    ...states.map((s) => ({
      kind: s.kind,
      label: s.label,
      real: s.kind === 'sold' ? fmtInt(realSold) : '—',
      mem: fmtInt(s.count),
    })),
    { label: 'debt force-closed', real: fmtUsd(realUsd), mem: `${fmtUsd(memUsd)}†` },
  ]
  return (
    <Box sx={{ [TWO_UP]: { display: 'none' } }}>
      <table
        style={{ width: '100%', borderCollapse: 'collapse' }}
        aria-label="Real and Membrane side by side"
      >
        <thead>
          <tr>
            <th style={cellLabel}>
              <VisuallyHidden>State</VisuallyHidden>
            </th>
            <th style={cellHead}>Real</th>
            <th style={cellHead}>Membrane†</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <th style={cellLabel} scope="row">
                <span style={glyphRow}>
                  {r.kind ? <Glyph kind={r.kind} /> : null}
                  <span>{r.label}</span>
                </span>
              </th>
              <td style={cellNum}>{r.real}</td>
              <td style={cellNum}>{r.mem}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Box>
  )
})

const sameLegend = (a: LegendDatum[], b: LegendDatum[]) =>
  a.length === b.length && a.every((x, i) => x.count === b[i].count && x.label === b[i].label)

const PanelHeader = memo(
  function PanelHeader({
    title,
    items,
    note,
  }: {
    title: string
    items: LegendDatum[]
    note?: string
  }) {
    return (
      <VStack
        align="stretch"
        spacing={SPACING.xs}
        borderBottom="1px solid"
        borderColor={SEMANTIC_COLORS.borderSubtle}
        pb={SPACING.xs}
      >
        <Flex justify="space-between" align="baseline" gap={SPACING.sm}>
          <Eyebrow>{title}</Eyebrow>
          {note ? (
            <Text {...mono} fontSize={TYPOGRAPHY.label} color={SEMANTIC_COLORS.textTertiary}>
              {note}
            </Text>
          ) : null}
        </Flex>
        {/* Legends from 600 px (phones read the table); the same height on both sides at
            lg+, so the two panels start on the same line. */}
        <Flex
          wrap="wrap"
          columnGap={SPACING.md}
          rowGap={SPACING.xs}
          align="center"
          alignContent="flex-start"
          display="none"
          minH={{ base: '18px', lg: '40px', xl: '18px' }}
          sx={{ [TWO_UP]: { display: 'flex' } }}
        >
          {items.map((it) => (
            <LegendItem key={it.label} kind={it.kind} count={fmtInt(it.count)} label={it.label} />
          ))}
        </Flex>
      </VStack>
    )
  },
  (a, b) => a.title === b.title && a.note === b.note && sameLegend(a.items, b.items),
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
      <VisuallyHidden as="label" htmlFor={id}>
        Time
      </VisuallyHidden>
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

const Colophon = memo(function Colophon({
  gridEnd,
  unpriced,
  credit,
}: {
  gridEnd: string
  unpriced: string
  credit: string
}) {
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
          {MODELLED_FOOTNOTE}
          {gridEnd ? (
            <>
              {' · '}
              <Glyph kind="gridEnd" /> {gridEnd}
            </>
          ) : null}
          {unpriced ? ` · ${unpriced}` : ''}
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
  real: new Uint8Array(0),
  mem: new Uint8Array(0),
  rho: 1,
  markPx: 0,
  perHex: 1,
  labels: [],
  layout: { scale: 1, clusters: [] },
}

interface SideProps {
  title: string
  legend: LegendDatum[]
  note?: string
  frame: WavefrontFrame | null
  codes: Uint8Array | null
  geometry: PanelGeometry
  palette: MarkPalette
  size: { width: number; height: number }
  sizeRef?: React.RefObject<HTMLDivElement>
  ariaLabel: string
  labels: 'always' | 'stacked'
  stale: boolean
  bars: { values: number[]; caption: string; note: string; ariaLabel: string } | null
  loadingText: string
}

const Side: React.FC<SideProps> = ({
  title,
  legend,
  note,
  frame,
  codes,
  geometry,
  palette,
  size,
  sizeRef,
  ariaLabel,
  labels,
  stale,
  bars,
  loadingText,
}) => (
  <VStack as="section" align="stretch" spacing={SPACING.sm} minW={0}>
    <PanelHeader title={title} items={legend} note={note} />
    <AspectRatio ratio={{ base: 1.2, lg: 740 / 440 }} w="100%">
      <Box ref={sizeRef}>
        {frame && codes ? (
          <HexPanel
            width={size.width}
            height={size.height}
            codes={codes}
            geometry={geometry}
            palette={palette}
            ariaLabel={ariaLabel}
            labels={labels}
            stale={stale}
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
        caption={bars.caption}
        note={bars.note}
        ariaLabel={bars.ariaLabel}
      />
    ) : (
      <Box h="90px" />
    )}
  </VStack>
)

// ------------------------------------------------------------------ the view

export interface WavefrontViewProps {
  frame: WavefrontFrame | null
  mode: WavefrontMode
  status: WavefrontStream['status']
  error: string | null
  windowRange: { startTs: number; endTs: number } | null
  updatedAt: number | null
  stale: boolean
  staleSince: number | null
  /** Live was asked for and did not answer: the replay is shown, and the kicker says so. */
  liveUnavailable: boolean
  start: number
  end: number
  t: number
  playing: boolean
  onToggle: () => void
  onSeek: (t: number) => void
  protocols: string[]
  chains: string[]
  /** Walked positions per cluster over the whole stream (sizes the marks once). */
  clusterTotals: { name: string; count: number }[]
}

/**
 * The page, as a pure function of the stream's state (tests render it server-side). Every
 * count and $ is the reducer's (frame.totals, frame.coverage, frame.pending); the only
 * derived figure is Membrane "sold" net of the grid-end positions drawn apart.
 */
export const WavefrontView: React.FC<WavefrontViewProps> = (v) => {
  const { frame, onSeek, start, end } = v

  const { mode: theme } = useThemeMode()
  const palette = useMemo<MarkPalette>(() => {
    const p = {
      sold: resolveColor(MARK_TOKEN.sold),
      armed: resolveColor(MARK_TOKEN.armed),
      gridEnd: resolveColor(MARK_TOKEN.gridEnd),
      kept: resolveColor(MARK_TOKEN.kept),
      pending: resolveColor(MARK_TOKEN.pending),
      bg: resolveColor(SEMANTIC_COLORS.bgPrimary),
    }
    return { ...p, ageAlpha: ageAlphas(p.sold, p.bg) }
    // theme: re-resolve the tokens when the theme flips
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme])

  // Both panels are the same size (one grid track each); measure one.
  const sizeRef = useRef<HTMLDivElement>(null)
  const size = useElementSize(sizeRef)
  const perHex = useMemo(
    () => choosePerHex(v.clusterTotals, size.width, size.height),
    [v.clusterTotals, size.width, size.height],
  )
  const geometry = useMemo(
    () =>
      frame && size.width > 0 && size.height > 0
        ? panelGeometry(frame, size.width, size.height, perHex)
        : EMPTY_GEOMETRY,
    [frame, size.width, size.height, perHex],
  )

  const onScrub = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onSeek(Math.min(end, start + Number(e.target.value) * BIN_SECONDS))
    },
    [onSeek, start, end],
  )

  const loadingText =
    v.status === 'error' || (v.status === 'ready' && !frame)
      ? `Replay did not load${v.error ? ` (${v.error})` : ''}.`
      : 'Loading…'

  const T = frame?.totals
  const states = useMemo(() => (frame ? memStates(frame) : []), [frame])
  const realLegend = useMemo<LegendDatum[]>(
    () => (frame ? [{ kind: 'sold', count: frame.coverage.walked, label: 'sold' }] : []),
    [frame],
  )
  const credit = v.protocols.length
    ? `${v.protocols.map(displayName).join(' + ')} · ${chainList(v.chains)} · protocol oracle prices`
    : NBSP
  const stale = v.stale
  const memAria = frame
    ? `Membrane simulator, modelled: ${states.map((s) => `${fmtInt(s.count)} ${s.label.replace('†', '')}`).join(', ')}.`
    : ''

  return (
    <Container
      maxW="1600px"
      px={SPACING_PATTERNS.pagePadding}
      py={{ base: SPACING.base, lg: SPACING.lg }}
    >
      <VStack align="stretch" spacing={{ base: SPACING.md, lg: SPACING.md }}>
        <Masthead
          kicker={kickerText({
            mode: v.mode,
            status: v.status,
            frame,
            windowRange: v.windowRange,
            updatedAt: v.updatedAt,
            stale,
            staleSince: v.staleSince,
            liveUnavailable: v.liveUnavailable,
          })}
          count={headlineCount(frame, stale)}
          realUsd={T ? T.real.repaidUsd : null}
          memUsd={T ? T.mem.repaidUsd : null}
          coverage={coverageText(frame)}
          notComparedText={
            !frame || frame.notCompared.inStream === 0 ? null : notComparedLine(frame.notCompared)
          }
          clock={frame ? fmtClock(frame.t) : NBSP}
          lastHour={frame ? frame.lastHour : null}
        />

        {frame && T ? (
          <CompareTable
            realSold={frame.coverage.walked}
            states={states}
            realUsd={T.real.repaidUsd}
            memUsd={T.mem.repaidUsd}
          />
        ) : null}

        {/* The sticky controls live in the same box as the panels, so they can never rise
            above it and cover the comparison table on a short phone. */}
        <VStack align="stretch" spacing={{ base: SPACING.md, lg: SPACING.md }}>
          <Grid
            templateColumns="minmax(0, 1fr)"
            columnGap={{ base: SPACING.lg, xl: SPACING.xl }}
            rowGap={SPACING.lg}
            sx={{ [TWO_UP]: { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' } }}
          >
            <Side
              title="Real · measured"
              legend={realLegend}
              note={frame ? scaleNote(perHex) : undefined}
              frame={frame}
              codes={frame ? geometry.real : null}
              geometry={geometry}
              palette={palette}
              size={size}
              sizeRef={sizeRef}
              ariaLabel={
                frame ? `Real, measured: ${fmtInt(frame.coverage.walked)} positions sold.` : ''
              }
              labels="always"
              stale={stale}
              bars={
                frame
                  ? {
                      values: frame.bars.real,
                      caption: 'Sold per 10 min',
                      note: barsNote(frame.bars.max),
                      ariaLabel: `Real: positions sold per 10 minutes over the last 12 hours; peak ${fmtInt(Math.max(0, ...frame.bars.real))}.`,
                    }
                  : null
              }
              loadingText={loadingText}
            />
            <Side
              title="Membrane (simulator)†"
              legend={states}
              frame={frame}
              codes={frame ? geometry.mem : null}
              geometry={geometry}
              palette={palette}
              size={size}
              ariaLabel={memAria}
              labels="stacked"
              stale={stale}
              bars={
                frame
                  ? {
                      values: frame.bars.mem,
                      caption: '',
                      note: 'same scale',
                      ariaLabel: `Membrane simulator, modelled: positions first sold per 10 minutes over the last 12 hours, same scale, windows still open at the data end left out; peak ${fmtInt(Math.max(0, ...frame.bars.mem))}.`,
                    }
                  : null
              }
              loadingText={loadingText}
            />
          </Grid>

          {v.mode === 'replay' ? (
            <Controls
              playing={v.playing}
              disabled={!frame}
              steps={Math.max(1, Math.ceil((end - start) / BIN_SECONDS))}
              step={Math.round((v.t - start) / BIN_SECONDS)}
              valueText={frame ? fmtClock(frame.t) : undefined}
              onToggle={v.onToggle}
              onScrub={onScrub}
            />
          ) : null}
        </VStack>

        <Colophon
          gridEnd={gridEndText(frame, v.windowRange)}
          unpriced={unpricedText(frame)}
          credit={credit}
        />
      </VStack>
    </Container>
  )
}

// ------------------------------------------------------------------ the container

export interface WavefrontProps {
  /** Initial playhead (unix s), e.g. from ?t=. Disables auto-play. */
  initialT?: number | null
}

/**
 * Real vs Membrane liquidation wavefront (Q28). One hex per liquidated position the simulator
 * walks (or per few, on a phone), grouped by collateral; Real (measured) beside the same
 * positions under Membrane's position simulator. Port of the owner's canvas (board
 * Wavefront.dc.html) onto the app's tokens.
 */
export const Wavefront: React.FC<WavefrontProps> = ({ initialT = null }) => {
  const [mode, setMode] = useState<WavefrontMode>(WAVEFRONT_LIVE_FLAG ? 'live' : 'replay')
  const [liveUnavailable, setLiveUnavailable] = useState(false)
  const reducedMotion = usePrefersReducedMotion()
  const stream = useWavefrontStream({
    mode,
    initialT,
    autoPlay: !reducedMotion && initialT == null,
  })
  // Live was asked for but the endpoint did not answer: show the replay, and say so.
  useEffect(() => {
    if (stream.mode === 'live' && stream.status === 'unavailable') {
      setLiveUnavailable(true)
      setMode('replay')
    }
  }, [stream.mode, stream.status])

  return (
    <WavefrontView
      frame={stream.frame}
      mode={stream.mode}
      status={stream.status}
      error={stream.error}
      windowRange={stream.window}
      updatedAt={stream.updatedAt}
      stale={stream.stale}
      staleSince={stream.staleSince}
      liveUnavailable={liveUnavailable}
      start={stream.start}
      end={stream.end}
      t={stream.t}
      playing={stream.playing}
      onToggle={stream.togglePlay}
      onSeek={stream.seek}
      protocols={stream.protocols}
      chains={stream.chains}
      clusterTotals={stream.clusterTotals}
    />
  )
}
