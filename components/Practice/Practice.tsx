import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, HStack, SimpleGrid, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { OCT10_DATA_PATH } from '@/lib/position-sim/scenario'
import {
  PRACTICE_ASSETS,
  apply,
  clockAt,
  collateralUsd,
  currentLtv,
  elapsed,
  fmtPct,
  fmtUsd,
  initialState,
  liquidatorBaseline,
  loadPracticeData,
  makeScenario,
  membraneNoAction,
  presetFor,
  runToPause,
  score,
  step,
  type Choice,
  type LiquidatorResult,
  type MeasuredLiquidations,
  type Oct10Data,
  type PauseKind,
  type PracticeAsset,
  type PracticeState,
  type PresetKind,
} from '@/lib/practice/engine'

import { ActionButton, Eyebrow, Fact, Panel } from './atoms'
import { Gauge } from './Gauge'
import { PauseSheet } from './PauseSheet'
import { PriceStrip } from './PriceStrip'
import { ResultCard } from './ResultCard'

/** ~1 simulated hour per 5 s. */
const MINUTES_PER_SECOND = 60 / 5
const TICK_MS = 100

const SERIES_OF: Record<PracticeAsset, string> = { ETH: 'ethOracle', BTC: 'btcOracle', wstETH: 'wstethOracle' }

/** The manifest's own wording for the column this asset is priced by (first sentence). */
function tapeSource(data: Oct10Data, asset: PracticeAsset): string {
  const col = SERIES_OF[asset]
  const src = data.manifest.sources.find((s) => s.series.split(/[\s/]+/).includes(col))
  const text = src ? src.source.split('. ')[0] : 'Chainlink oracle rounds'
  return `Oct 10 2025 · ${col} · ${text}`
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(mq.matches)
    const on = (e: MediaQueryListEvent) => setReduced(e.matches)
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, [])
  return reduced
}

type Stage = 'setup' | 'tape' | 'result'

export const Practice: React.FC = () => {
  const [data, setData] = useState<Oct10Data | null>(null)
  const [measured, setMeasured] = useState<MeasuredLiquidations | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [asset, setAsset] = useState<PracticeAsset>('ETH')
  const [kind, setKind] = useState<PresetKind>('through')
  const [stage, setStage] = useState<Stage>('setup')
  const [playing, setPlaying] = useState(false)
  const [pause, setPause] = useState<PauseKind | null>(null)
  const [, setTick] = useState(0)
  const stRef = useRef<PracticeState | null>(null)
  const owed = useRef(0)
  const reduced = usePrefersReducedMotion()

  useEffect(() => {
    let live = true
    loadPracticeData()
      .then((d) => live && setData(d))
      .catch((e: Error) => live && setError(e.message))
    fetch(`${OCT10_DATA_PATH}/protocols.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => live && setMeasured(j?.measuredLiquidations ?? null))
      .catch(() => live && setMeasured(null))
    return () => {
      live = false
    }
  }, [])

  const presets = useMemo(() => {
    if (!data) return null
    return {
      inside: presetFor(data, asset, 'inside'),
      through: presetFor(data, asset, 'through'),
    }
  }, [data, asset])

  const sc = useMemo(() => {
    if (!data || !presets) return null
    const p = presets[kind]
    return makeScenario(data, { asset, openLtv: p.openLtv, line: p.line })
  }, [data, presets, asset, kind])

  const baseline = useMemo(() => (sc ? membraneNoAction(sc) : null), [sc])
  const liquidators: LiquidatorResult | null = useMemo(
    () => (sc && measured ? liquidatorBaseline(sc, measured) : null),
    [sc, measured],
  )

  const rerender = useCallback(() => setTick((t) => t + 1), [])

  const finish = useCallback(() => {
    setPlaying(false)
    setPause(null)
    setStage('result')
  }, [])

  const advanceToPause = useCallback(() => {
    const st = stRef.current
    if (!st) return
    const r = runToPause(st)
    if (r.pause) {
      setPause(r.pause)
      setPlaying(false)
    }
    if (st.finished) finish()
    rerender()
  }, [finish, rerender])

  // Playback loop. Reduced motion: jump straight to the next pause.
  useEffect(() => {
    if (!playing || stage !== 'tape') return
    if (reduced) {
      advanceToPause()
      return
    }
    const id = window.setInterval(() => {
      const st = stRef.current
      if (!st) return
      owed.current += (MINUTES_PER_SECOND * TICK_MS) / 1000
      while (owed.current >= 1 && !st.finished) {
        owed.current -= 1
        const r = step(st)
        if (r.pause) {
          owed.current = 0
          setPause(r.pause)
          setPlaying(false)
          break
        }
      }
      if (st.finished) finish()
      rerender()
    }, TICK_MS)
    return () => window.clearInterval(id)
  }, [playing, stage, reduced, advanceToPause, finish, rerender])

  const start = () => {
    if (!sc) return
    stRef.current = initialState(sc)
    owed.current = 0
    setPause(null)
    setStage('tape')
    setPlaying(true)
  }

  const choose = (c: Choice) => {
    const st = stRef.current
    if (!st || !pause) return
    apply(st, c, pause)
    setPause(null)
    setPlaying(true)
    rerender()
  }

  const st = stRef.current
  const tapeName = data ? tapeSource(data, asset) : ''

  return (
    <Box maxW="1140px" mx="auto" px={SPACING.base} py={SPACING.lg} bg={SEMANTIC_COLORS.bgPrimary} color={SEMANTIC_COLORS.textPrimary}>
      <Eyebrow>Practice</Eyebrow>
      <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize={TYPOGRAPHY.h1} letterSpacing="-0.01em" mt={SPACING.xs}>
        Practice the crossing
      </Text>
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.textSecondary} mt={SPACING.sm} maxW="640px">
        The recorded Oct 10 tape, Membrane&apos;s rules. The tape stops when the timer classifies something. You choose.
      </Text>

      {error && (
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.danger} mt={SPACING.lg}>
          {error}
        </Text>
      )}
      {!data && !error && (
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.textTertiary} mt={SPACING.lg}>
          Loading the tape…
        </Text>
      )}

      {sc && presets && stage === 'setup' && (
        <Panel mt={SPACING.lg}>
          <Eyebrow>Collateral</Eyebrow>
          <HStack spacing={SPACING.sm} mt={SPACING.sm} flexWrap="wrap">
            {PRACTICE_ASSETS.map((a) => (
              <ActionButton key={a} onClick={() => setAsset(a)} active={a === asset}>
                {a}
              </ActionButton>
            ))}
          </HStack>
          <Box mt={SPACING.md}>
            <Eyebrow>Opening LTV</Eyebrow>
          </Box>
          <SimpleGrid columns={{ base: 1, md: 2 }} spacing={SPACING.sm} mt={SPACING.sm}>
            {(['inside', 'through'] as PresetKind[]).map((k) => {
              const p = presets[k]
              return (
                <ActionButton key={k} onClick={() => setKind(k)} active={k === kind}>
                  <Box>
                    <Text>
                      {fmtPct(p.openLtv)} → worst minute {fmtPct(p.worstLtv)}
                    </Text>
                    <Text fontSize="11px" color={SEMANTIC_COLORS.textTertiary} mt="2px">
                      {k === 'inside' ? 'inside the band' : 'through the band'} · {clockAt(sc, p.worstIndex)}
                    </Text>
                  </Box>
                </ActionButton>
              )
            })}
          </SimpleGrid>
          <Gauge sc={sc} ltv={sc.openLtv} />
          <SimpleGrid columns={{ base: 2, md: 4 }} spacing={SPACING.md}>
            <Fact label="collateral" value={fmtUsd(sc.collateralUsd0)} />
            <Fact label="debt" value={fmtUsd(sc.debtUsd0)} />
            <Fact label="line" value={fmtPct(sc.line)} />
            <Fact label="window" value={elapsed(sc.delaySteps * (sc.stepSeconds / 60))} />
          </SimpleGrid>
          <Box mt={SPACING.lg}>
            <ActionButton onClick={start}>Run the tape</ActionButton>
          </Box>
        </Panel>
      )}

      {st && stage !== 'setup' && (
        <Panel mt={SPACING.lg}>
          <HStack justify="space-between" align="baseline" flexWrap="wrap" gap={SPACING.sm}>
            <SimpleGrid columns={{ base: 2, md: 5 }} spacing={SPACING.md} flex="1">
              <Fact label="clock" value={clockAt(st.sc, st.index)} />
              <Fact label="elapsed" value={elapsed(st.index)} />
              <Fact label={`${st.sc.asset} oracle`} value={fmtUsd(st.sc.prices[st.index])} />
              <Fact label="collateral" value={fmtUsd(collateralUsd(st))} />
              <Fact
                label="window"
                value={st.armedAt !== null ? `${elapsed(Math.max(0, st.armedAt + st.sc.delaySteps - st.index))} left` : '—'}
                color={st.armedAt !== null ? SEMANTIC_COLORS.warning : SEMANTIC_COLORS.textTertiary}
              />
            </SimpleGrid>
            {stage === 'tape' && !pause && (
              <HStack spacing={SPACING.sm}>
                <ActionButton onClick={() => setPlaying((p) => !p)}>{playing ? 'Pause' : 'Resume'}</ActionButton>
                <ActionButton onClick={advanceToPause}>Skip to next stop</ActionButton>
              </HStack>
            )}
          </HStack>
          <Gauge sc={st.sc} ltv={currentLtv(st)} />
          {stage === 'tape' && <PriceStrip sc={st.sc} upTo={st.index} sales={st.sales} choices={st.choices} />}
        </Panel>
      )}

      {st && stage === 'tape' && pause && (
        <Box mt={SPACING.md}>
          <PauseSheet st={st} pause={pause} onChoose={choose} />
        </Box>
      )}

      {st && stage === 'result' && baseline && (
        <Box mt={SPACING.lg}>
          <ResultCard st={st} you={score(st)} baseline={baseline} liquidators={liquidators} tapeName={tapeName} />
          <HStack mt={SPACING.lg} spacing={SPACING.sm}>
            <ActionButton onClick={start}>Run it again</ActionButton>
            <ActionButton
              onClick={() => {
                stRef.current = null
                setStage('setup')
                rerender()
              }}
            >
              Change position
            </ActionButton>
          </HStack>
        </Box>
      )}

      {data && (
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9px" letterSpacing="0.12em" color={SEMANTIC_COLORS.textTertiary} mt={SPACING.xl} lineHeight={1.7}>
          Tape: {tapeName}. {data.manifest.windowStartUtc} → {data.manifest.windowEndUtc}.
        </Text>
      )}
    </Box>
  )
}

export default Practice
