// Risk Frontier — sandbox test harness (docs/RISK_FRONTIER_DESIGN.md §3). A hypothetical
// position placed inside fixed, named stress scenarios: how far each axis is from arming the
// window or forcing a sale, a branching tree of scenario outcomes, and a crash test. Every
// node is a deterministic stress scenario run through lib/position-sim/stressGrid.ts — not a
// forecast, not a probability. Compute is client-side and debounced; typing is never blocked.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Button, HStack, Text, VStack, Wrap, WrapItem } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { loadOct10 } from '@/lib/position-sim/scenario'
import { oct10ReplayShape, type PriceShape } from '@/lib/position-sim/stressGrid'

import {
  CODE_SHORT,
  Eyebrow,
  Panel,
  REDUCED_MOTION_SX,
  SectionHead,
  StressStamp,
  TONE_COLOR,
} from './atoms'
import { CrashTest } from './CrashTest'
import { DangerRulers } from './DangerRulers'
import { FinePrint } from './FinePrint'
import { LeafDetail } from './LeafDetail'
import { LoadoutPanel } from './Loadout'
import { ScenarioTree } from './ScenarioTree'
import { Swatch } from './Swatch'
import {
  DEFAULT_INPUTS,
  buildStressPosition,
  classView,
  computeFrontier,
  multText,
  pct,
  resolveSelection,
  usd,
  usdOrNone,
  type FrontierModel,
  type SandboxInputs,
  type SandboxPosition,
  type Selection,
} from './viewModel'

/** Quiet period after the last input change before the engine re-runs. */
const DEBOUNCE_MS = 180

const HudChip: React.FC<{ label: string; value: string; color?: string; title?: string }> = ({
  label,
  value,
  color,
  title,
}) => (
  <WrapItem>
    <HStack
      spacing={SPACING.sm}
      border="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
      bg={SEMANTIC_COLORS.bgSecondary}
      px={SPACING.sm}
      py={SPACING.xs}
      title={title}
    >
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.label}
        letterSpacing="0.2em"
        color={SEMANTIC_COLORS.textTertiary}
      >
        {label}
      </Text>
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.xs}
        color={color ?? SEMANTIC_COLORS.textPrimary}
        sx={{ fontVariantNumeric: 'tabular-nums' }}
      >
        {value}
      </Text>
    </HStack>
  </WrapItem>
)

const Hud: React.FC<{ sb: SandboxPosition; pending: boolean; model: FrontierModel | null }> = ({
  sb,
  pending,
  model,
}) => {
  const p = sb.position
  const cv = classView(p.membraneClass)
  const ltvColor =
    !Number.isFinite(sb.startLtv) || sb.overLine
      ? SEMANTIC_COLORS.danger
      : sb.startLtv > sb.recallTarget
        ? SEMANTIC_COLORS.warning
        : SEMANTIC_COLORS.success
  return (
    <Wrap spacing={SPACING.sm} mt={SPACING.md} align="center">
      <HudChip label="LTV" value={pct(sb.startLtv)} color={ltvColor} />
      <HudChip label="LINE" value={pct(sb.line)} />
      {p.membraneClass === 'delayed' && (
        <HudChip
          label="BREAK"
          value={pct(sb.breakLine)}
          title="line × (1 + band): past it the window breaks"
        />
      )}
      <HudChip
        label="RECALL TARGET"
        value={pct(sb.recallTarget)}
        title="line − 3pp: where a recall aims"
      />
      <HudChip
        label={p.membraneClass === 'delayed' ? 'DELAYED' : 'NO-DELAY'}
        value={cv.windowHours > 0 ? `${cv.windowHours}h window` : 'no window'}
      />
      <HudChip
        label={p.tradeShape === 'carry' ? 'CARRY' : 'LEVERED'}
        value={p.tradeShape === 'carry' ? `${usd(sb.deployedUsd)} deployed` : 'no recall'}
      />
      {sb.exitCapacityUsd !== null && (
        <HudChip
          label="EXIT"
          value={
            `${usdOrNone(sb.exitCapacityUsd)} ×${multText(sb.capacityMult)}` +
            (sb.capacityLockHours ? ` · ${sb.capacityLockHours}h lock` : '')
          }
          title={sb.capacityLabel ?? undefined}
        />
      )}
      <WrapItem>
        {/* Visual status only: announcing "computing / computed in N ms" on every keystroke
            flooded screen readers. The headline lead is the one live region. */}
        <HStack spacing={SPACING.sm} px={SPACING.sm}>
          <Box
            w="7px"
            h="7px"
            borderRadius="50%"
            bg={pending ? SEMANTIC_COLORS.warning : SEMANTIC_COLORS.success}
            sx={
              pending
                ? {
                    animation: 'rfBlink 0.8s ease-in-out infinite',
                    '@keyframes rfBlink': { '0%,100%': { opacity: 0.25 }, '50%': { opacity: 1 } },
                  }
                : undefined
            }
          />
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.label}
            color={SEMANTIC_COLORS.textTertiary}
          >
            {pending
              ? 'computing'
              : model
                ? `computed in ${Math.max(1, Math.round(model.computeMs))} ms · ${CODE_SHORT}`
                : ''}
          </Text>
        </HStack>
      </WrapItem>
    </Wrap>
  )
}

const Headline: React.FC<{ model: FrontierModel }> = ({ model }) => {
  const h = model.headline
  const color = TONE_COLOR[h.tone]
  return (
    <Panel accent={color} position="relative" overflow="hidden">
      <Box position="absolute" left={0} top={0} bottom={0} w="3px" bg={color} />
      <Box pl={SPACING.sm}>
        <Eyebrow color={color}>Nearest risk · price axis</Eyebrow>
        {/* Mono, not the display serif: the lead carries numbers ("past 12%", "$2,000"). */}
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={{ base: TYPOGRAPHY.h3, md: TYPOGRAPHY.h2 }}
          lineHeight={1.3}
          color={SEMANTIC_COLORS.textPrimary}
          mt={SPACING.sm}
          aria-live="polite"
          aria-atomic
        >
          {h.lead}
        </Text>
        {h.detail && (
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textSecondary}
            mt={SPACING.sm}
            maxW="760px"
            lineHeight={1.55}
          >
            {h.detail}
          </Text>
        )}
        <Box mt={SPACING.sm}>
          <StressStamp full />
        </Box>
      </Box>
    </Panel>
  )
}

const Tab: React.FC<{ active: boolean; onClick: () => void; children: React.ReactNode }> = ({
  active,
  onClick,
  children,
}) => (
  <Button
    onClick={onClick}
    aria-pressed={active}
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize={TYPOGRAPHY.label}
    letterSpacing="0.2em"
    fontWeight={400}
    textTransform="uppercase"
    borderRadius={0}
    h="28px"
    px={SPACING.md}
    bg={active ? SEMANTIC_COLORS.bgTertiary : 'transparent'}
    color={active ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.textTertiary}
    border="1px solid"
    borderColor={active ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.borderSubtle}
    transition={TRANSITIONS.colors}
    _hover={{ color: SEMANTIC_COLORS.textPrimary }}
    _focusVisible={FOCUS_STYLES.ring}
  >
    {children}
  </Button>
)

export const RiskFrontier: React.FC = () => {
  const [inputs, setInputs] = useState<SandboxInputs>(DEFAULT_INPUTS)
  const [replay, setReplay] = useState<PriceShape | null>(null)
  const [replayMissing, setReplayMissing] = useState('Oct 10 tape loading')
  const [tapeWindow, setTapeWindow] = useState<string | null>(null)
  const [model, setModel] = useState<FrontierModel | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(true)
  const [selection, setSelection] = useState<Selection>({ kind: 'lane', id: 'step25' })
  const [view, setView] = useState<'tree' | 'swatch'>('tree')
  const first = useRef(true)

  // The Oct 10 tape: measured ETH oracle path, used as a relative shape.
  useEffect(() => {
    let live = true
    loadOct10()
      .then(({ series, manifest }) => {
        if (!live) return
        const shape = oct10ReplayShape(series, 'WETH')
        if (shape) {
          setReplay(shape)
          setTapeWindow(`${manifest.windowStartUtc} → ${manifest.windowEndUtc}`)
        } else setReplayMissing('no ETH oracle series in the tape')
      })
      .catch(() => live && setReplayMissing('Oct 10 tape unavailable'))
    return () => {
      live = false
    }
  }, [])

  // Debounced compute: the inputs answer at once, the engine re-runs once typing settles.
  useEffect(() => {
    setPending(true)
    const wait = first.current ? 0 : DEBOUNCE_MS
    first.current = false
    const id = window.setTimeout(() => {
      try {
        setModel(computeFrontier(inputs, replay, replayMissing))
        setError(null)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setPending(false)
      }
    }, wait)
    return () => window.clearTimeout(id)
  }, [inputs, replay, replayMissing])

  const sandbox = useMemo(() => buildStressPosition(inputs), [inputs])

  const results = useMemo(() => {
    if (!model) return null
    const delayed = model.sandbox.position.membraneClass === 'delayed'
    return (
      <VStack align="stretch" spacing={SPACING.lg}>
        <Headline model={model} />
        <DangerRulers model={model} selected={selection} onSelect={setSelection} />
        <CrashTest model={model} selected={selection} onSelect={setSelection} />
        <Panel>
          <SectionHead
            title={view === 'tree' ? 'Scenario tree' : 'Swatch'}
            kicker={
              view === 'tree'
                ? 'named scenarios · click a leaf for its node'
                : 'price shape × venue condition · single axis, never combined'
            }
            right={
              <VStack align="flex-end" spacing={SPACING.sm}>
                <HStack spacing={SPACING.xs}>
                  <Tab active={view === 'tree'} onClick={() => setView('tree')}>
                    Tree
                  </Tab>
                  <Tab active={view === 'swatch'} onClick={() => setView('swatch')}>
                    Swatch
                  </Tab>
                </HStack>
                <StressStamp />
              </VStack>
            }
          />
          {view === 'tree' ? (
            <ScenarioTree
              lanes={model.tree}
              delayed={delayed}
              selected={selection}
              onSelect={setSelection}
            />
          ) : (
            <Swatch
              swatch={model.swatch}
              delayed={delayed}
              selected={selection}
              onSelect={setSelection}
            />
          )}
        </Panel>
        <LeafDetail sel={resolveSelection(model, selection)} />
        <FinePrint tapeWindow={tapeWindow} />
      </VStack>
    )
  }, [model, selection, view, tapeWindow])

  return (
    <Box
      bg={SEMANTIC_COLORS.bgPrimary}
      color={SEMANTIC_COLORS.textPrimary}
      minH="100vh"
      sx={REDUCED_MOTION_SX}
    >
      <Box maxW="1320px" mx="auto" px={{ base: SPACING.base, md: SPACING.lg }} py={SPACING.lg}>
        <Eyebrow color={SEMANTIC_COLORS.success}>Risk Frontier · sandbox</Eyebrow>
        <Text
          as="h1"
          fontFamily={TYPOGRAPHY.fontDisplay}
          fontSize={{ base: TYPOGRAPHY.h2, md: TYPOGRAPHY.h1 }}
          letterSpacing="-0.01em"
          mt={SPACING.xs}
        >
          How far is the edge?
        </Text>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
          color={SEMANTIC_COLORS.textSecondary}
          mt={SPACING.sm}
          maxW="720px"
          lineHeight={1.55}
        >
          Fixed stress scenarios on a hypothetical position, run through Membrane&apos;s liquidation
          mechanics. Mechanics, not odds.
        </Text>
        <Hud sb={sandbox} pending={pending} model={model} />

        <Box
          display="grid"
          gridTemplateColumns={{ base: '1fr', lg: '340px minmax(0, 1fr)' }}
          gap={SPACING.lg}
          mt={SPACING.lg}
          alignItems="start"
        >
          <Box
            position={{ base: 'static', lg: 'sticky' }}
            top={SPACING.base}
            maxH={{ lg: 'calc(100vh - 32px)' }}
            overflowY={{ lg: 'auto' }}
          >
            <LoadoutPanel inputs={inputs} sandbox={sandbox} onChange={setInputs} />
          </Box>

          <Box position="relative" minW={0} sx={REDUCED_MOTION_SX}>
            {/* computing: a scan line and a slight dim — the last answer stays readable */}
            {pending && model && (
              <Box
                position="absolute"
                top="-10px"
                left={0}
                right={0}
                h="2px"
                overflow="hidden"
                aria-hidden
              >
                <Box
                  h="100%"
                  w="30%"
                  bg={SEMANTIC_COLORS.success}
                  sx={{
                    animation: 'rfScan 0.9s ease-in-out infinite',
                    '@keyframes rfScan': {
                      '0%': { transform: 'translateX(-100%)' },
                      '100%': { transform: 'translateX(340%)' },
                    },
                  }}
                />
              </Box>
            )}
            {error && (
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.xs}
                color={SEMANTIC_COLORS.danger}
                mb={SPACING.md}
              >
                The engine stopped on these inputs: {error}
              </Text>
            )}
            {!model && !error && (
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.xs}
                color={SEMANTIC_COLORS.textTertiary}
              >
                Running the scenarios…
              </Text>
            )}
            <Box opacity={pending && model ? 0.72 : 1} transition={TRANSITIONS.opacityQuick}>
              {results}
            </Box>
          </Box>
        </Box>
      </Box>
    </Box>
  )
}

export default RiskFrontier
