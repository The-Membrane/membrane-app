// The position simulator.
//
// DEMO-FIRST (CLAUDE.md V20): this renders fully populated with a worked example on
// first paint. There is no empty state, no connect gate and no wallet anywhere in this
// file — the page reads public mainnet state and nothing else.
//
// The one hard rule about the demo: the moment a real address is read, the worked
// example is GONE. A failed adapter shows its own error and never falls back to demo
// numbers, because a fabricated position dressed as a real one is the worst outcome
// this page could produce.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/router'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { monoXs, tabular } from '@/components/Builder/styles'
import {
  MAX_LIQ_FEE,
  MEMBRANE_LTV_PROVENANCE,
  buildPricePath,
  DEMO_DEPLOYMENT,
  demoPosition,
  detectVenues,
  loadOct10,
  measuredRepayFraction,
  oct10Provenance,
  parseAddress,
  readUrlState,
  runAdapters,
  runComparison,
  shareUrl,
  downloadShareCard,
  stamp,
  toVenueRecall,
  weightedMembraneLine,
  writeUrlState,
  type AdapterResult,
  type Oct10Manifest,
  type Oct10Series,
  type ProtocolPosition,
  type Provenance,
  type VenueDetection,
  type VenueRecall,
} from '@/lib/position-sim'

import ComparisonPanel from './ComparisonPanel'
import Controls, { type ControlValues } from './Controls'
import DeploymentSection from './DeploymentSection'
import EventLog from './EventLog'
import FinePrint from './FinePrint'
import GuaranteeBlock from './GuaranteeBlock'
import PositionCard from './PositionCard'
import { recordSimRead } from './recordRead'
import VerdictHero from './VerdictHero'

/** Plain section title. There are no numbered eyebrows on this page any more. */
const SECTION = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: '10px',
  letterSpacing: '0.2em',
  textTransform: 'uppercase' as const,
  color: SEMANTIC_COLORS.textSecondary,
}

const HEAD = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: '9px',
  letterSpacing: '0.18em',
  textTransform: 'uppercase' as const,
  color: SEMANTIC_COLORS.textSecondary,
}

/** Just the slice of public/data/oct10-2025/protocols.json the sim consumes. */
interface MeasuredLiquidations {
  aaveV3?: { medianRepayFraction?: number; events?: number }
  morphoBlue?: { medianRepayFraction?: number; events?: number }
}

const keyOf = (p: ProtocolPosition) => `${p.protocol}:${p.marketId ?? ''}`

const STATUS_COLOR: Record<AdapterResult['status'], string> = {
  ok: SEMANTIC_COLORS.success,
  empty: SEMANTIC_COLORS.textSecondary,
  error: SEMANTIC_COLORS.danger,
  unsupported: SEMANTIC_COLORS.warning,
}

/**
 * The default Membrane liquidation fee.
 *
 * We refuse to pick a flattering number here. The fee is matched to the SOURCE
 * protocol's own collateral-weighted liquidation bonus, so any gap in the result comes
 * from the repay mechanics rather than from handing Membrane a cheaper liquidator.
 * When no leg exposes a bonus there is nothing to match, so it starts at the real 10%
 * contract ceiling — the least favourable setting for Membrane — instead of a guess.
 */
function defaultLiqFee(p: ProtocolPosition): number {
  const priced = p.collateral.filter((c) => c.liquidationBonus !== null)
  const value = priced.reduce((a, c) => a + c.valueUsd, 0)
  if (value === 0) return MAX_LIQ_FEE
  const weighted =
    priced.reduce((a, c) => a + (c.liquidationBonus as number) * c.valueUsd, 0) / value
  return Math.min(MAX_LIQ_FEE, Math.max(0, weighted))
}

const ZERO_CONTROLS: ControlValues = {
  membraneMaxLtv: 0,
  membraneLiqFee: 0,
  recallRate: 0,
  fastRate: 0,
  deployedUsd: 0,
}

export const Simulator: React.FC = () => {
  const router = useRouter()

  // ---------------------------------------------------------------- scenario
  const [scenario, setScenario] = useState<{ series: Oct10Series; manifest: Oct10Manifest } | null>(
    null,
  )
  const [scenarioError, setScenarioError] = useState<string | null>(null)
  const [measured, setMeasured] = useState<MeasuredLiquidations | null>(null)
  const [measuredError, setMeasuredError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    loadOct10()
      .then((d) => alive && setScenario(d))
      .catch((e: Error) => alive && setScenarioError(e.message))
    fetch('/data/oct10-2025/protocols.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(
        (j: { measuredLiquidations?: MeasuredLiquidations }) =>
          alive && setMeasured(j.measuredLiquidations ?? null),
      )
      .catch((e: Error) => alive && setMeasuredError(e.message))
    return () => {
      alive = false
    }
  }, [])

  // ----------------------------------------------------------------- address
  const [input, setInput] = useState('')
  const [addressError, setAddressError] = useState<string | null>(null)
  const [isLoading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState<{
    address: `0x${string}`
    results: AdapterResult[]
    detection: VenueDetection
  } | null>(null)

  /** Reads an address. Never clears the control overrides — the URL hydration path
   *  needs to apply them after the read lands. */
  const readAddress = useCallback(async (raw: string) => {
    const parsed = parseAddress(raw)
    if (!parsed) {
      setAddressError(
        'That is not an Ethereum address. It needs to be 0x followed by 40 hex characters.',
      )
      return
    }
    setAddressError(null)
    setLoading(true)
    try {
      // Neither call rejects: runAdapters absorbs every adapter throw into a result,
      // and detectVenues returns status 'error' rather than raising.
      const [results, detection] = await Promise.all([runAdapters(parsed), detectVenues(parsed)])
      setLoaded({ address: parsed, results, detection })
      // Launch instrument: address + protocols only, never the worked example.
      recordSimRead(parsed, results)
    } finally {
      setLoading(false)
    }
  }, [])

  // --------------------------------------------------------------- positions
  const demoPos = useMemo(() => demoPosition(), [])
  const isDemo = loaded === null
  const positions = useMemo<ProtocolPosition[]>(
    () => (loaded ? loaded.results.flatMap((r) => r.positions) : [demoPos]),
    [loaded, demoPos],
  )

  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const selected = useMemo<ProtocolPosition | null>(() => {
    if (positions.length === 0) return null
    const found = positions.find((p) => keyOf(p) === selectedKey)
    if (found) return found
    // Default to the largest loan — the one whose liquidation actually matters.
    return positions.reduce((a, b) => (b.totalDebtUsd > a.totalDebtUsd ? b : a))
  }, [positions, selectedKey])

  // ---------------------------------------------------------------- controls
  const detection = loaded?.detection ?? null
  const detectedRecall = useMemo<VenueRecall | null>(
    // The worked example carries its own assumed deployment (DEMO_DEPLOYMENT); a real
    // address only ever gets what detectVenues actually found — never the demo's.
    () => (detection ? toVenueRecall(detection) : loaded ? null : DEMO_DEPLOYMENT),
    [detection, loaded],
  )

  const derived = useMemo(
    () =>
      selected
        ? weightedMembraneLine(selected.collateral)
        : { maxLtv: 0, borrowLtv: 0, unknown: [] as string[] },
    [selected],
  )
  const liqFeeDefault = useMemo(() => (selected ? defaultLiqFee(selected) : 0), [selected])

  const defaults = useMemo<ControlValues>(() => {
    if (!selected) return ZERO_CONTROLS
    return {
      membraneMaxLtv: derived.maxLtv,
      membraneLiqFee: liqFeeDefault,
      recallRate: detectedRecall?.recallRate ?? 0,
      fastRate: detectedRecall?.fastRate ?? 0,
      deployedUsd: detectedRecall?.deployedUsd ?? 0,
    }
  }, [selected, derived, liqFeeDefault, detectedRecall])

  const [overrides, setOverrides] = useState<Partial<ControlValues>>({})
  const values = useMemo<ControlValues>(
    () => ({ ...defaults, ...overrides }),
    [defaults, overrides],
  )

  const onControlChange = useCallback((patch: Partial<ControlValues>) => {
    setOverrides((prev) => ({ ...prev, ...patch }))
  }, [])

  const venueProvenance = useMemo<Provenance>(() => {
    const same =
      detectedRecall !== null &&
      Math.abs(detectedRecall.recallRate - values.recallRate) < 1e-9 &&
      Math.abs(detectedRecall.fastRate - values.fastRate) < 1e-9 &&
      Math.round(detectedRecall.deployedUsd) === Math.round(values.deployedUsd)
    if (same && detectedRecall) return detectedRecall.provenance
    return stamp(
      'modelled',
      'venue recall · your inputs',
      'The recall and fast rates in force are the ones set in the controls on this page. They are not measured and they are not read from any venue.',
    )
  }, [detectedRecall, values])

  // -------------------------------------------------------------- comparison
  const comparison = useMemo(() => {
    if (!selected || !scenario) return null
    const symbols = [
      ...selected.collateral.map((c) => c.symbol),
      ...selected.debt.map((d) => d.symbol),
    ]
    const { path, unpriced } = buildPricePath(scenario.series, scenario.manifest, symbols)
    const repay = measuredRepayFraction(selected.protocol, measured)
    const venue: VenueRecall | null =
      values.deployedUsd > 0
        ? {
            recallRate: values.recallRate,
            fastRate: values.fastRate,
            deployedUsd: values.deployedUsd,
            provenance: venueProvenance,
          }
        : null
    return runComparison(selected, path, unpriced, {
      membraneMaxLtv: values.membraneMaxLtv,
      membraneLiqFee: values.membraneLiqFee,
      venue,
      sourceRepayFraction: repay.fraction,
      sourceRepayFractionLabel: repay.label,
      scenarioLabel: `${scenario.manifest.name} · ${scenario.manifest.resolution} oracle candles, ${scenario.manifest.windowStartUtc.slice(0, 10)} to ${scenario.manifest.windowEndUtc.slice(0, 10)}`,
    })
  }, [selected, scenario, measured, values, venueProvenance])

  // --------------------------------------------------------------- url state
  const hydrated = useRef(false)
  useEffect(() => {
    if (!router.isReady || hydrated.current) return
    hydrated.current = true
    const s = readUrlState(router.query as Record<string, string | string[] | undefined>)
    if (s.position) setSelectedKey(s.position)
    const patch: Partial<ControlValues> = {}
    if (s.membraneMaxLtv !== undefined) patch.membraneMaxLtv = s.membraneMaxLtv
    if (s.liqFee !== undefined) patch.membraneLiqFee = s.liqFee
    if (s.recallRate !== undefined) patch.recallRate = s.recallRate
    if (s.fastRate !== undefined) patch.fastRate = s.fastRate
    if (s.deployedUsd !== undefined) patch.deployedUsd = s.deployedUsd
    const run = async () => {
      if (s.address) {
        setInput(s.address)
        await readAddress(s.address)
      }
      // Applied after the read so the shared inputs win over the freshly derived
      // defaults — a link has to reproduce the run it was taken from.
      if (Object.keys(patch).length) setOverrides(patch)
    }
    void run()
  }, [router.isReady, router.query, readAddress])

  const urlState = useMemo(
    () => ({
      address: loaded?.address,
      position: selected ? keyOf(selected) : undefined,
      membraneMaxLtv: selected ? values.membraneMaxLtv : undefined,
      liqFee: selected ? values.membraneLiqFee : undefined,
      recallRate: selected ? values.recallRate : undefined,
      fastRate: selected ? values.fastRate : undefined,
      deployedUsd: selected ? values.deployedUsd : undefined,
    }),
    [loaded, selected, values],
  )

  useEffect(() => {
    if (!router.isReady || !hydrated.current) return
    const base = router.asPath.split('?')[0]
    const next = base + writeUrlState(urlState)
    if (router.asPath !== next) void router.replace(next, undefined, { shallow: true })
  }, [router, urlState])

  // ------------------------------------------------------------------ share
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const onCopyLink = useCallback(() => {
    const url = shareUrl(urlState)
    if (!url || typeof navigator === 'undefined' || !navigator.clipboard) {
      setCopyState('failed')
      return
    }
    navigator.clipboard.writeText(url).then(
      () => setCopyState('copied'),
      () => setCopyState('failed'),
    )
  }, [urlState])
  useEffect(() => {
    if (copyState === 'idle') return
    const t = setTimeout(() => setCopyState('idle'), 2400)
    return () => clearTimeout(t)
  }, [copyState])

  const onSaveCard = useCallback(() => {
    if (comparison) downloadShareCard(comparison, isDemo)
  }, [comparison, isDemo])

  // ---------------------------------------------------------------- handlers
  const onSubmitAddress = useCallback(() => {
    setOverrides({})
    setSelectedKey(null)
    void readAddress(input)
  }, [input, readAddress])

  const onClearAddress = useCallback(() => {
    setLoaded(null)
    setOverrides({})
    setSelectedKey(null)
    setAddressError(null)
    setInput('')
  }, [])

  const onSelectPosition = useCallback((k: string) => {
    setSelectedKey(k)
    setOverrides({})
  }, [])

  const onResetControls = useCallback(() => setOverrides({}), [])

  // ---------------------------------------------------------- derived for render
  /** Page-level failures. One line each, in the hero, in danger — never a paragraph. */
  const heroErrors = useMemo<string[]>(() => {
    const out: string[] = []
    if (scenarioError) out.push(`Measured price path failed to load: ${scenarioError}`)
    for (const r of loaded?.results ?? []) {
      if (r.status === 'error') out.push(`${r.label} · ${r.message ?? 'read failed'}`)
    }
    if (loaded && positions.length === 0) out.push('No open position found for this address.')
    return out
  }, [scenarioError, loaded, positions])

  /** Every caveat either run recorded, de-duplicated. Generated by the engine. */
  const runCaveats = useMemo<string[]>(
    () =>
      comparison
        ? Array.from(new Set([...comparison.source.caveats, ...comparison.membrane.caveats]))
        : [],
    [comparison],
  )

  const stamps = useMemo<Provenance[]>(() => {
    const out: Provenance[] = []
    if (scenario) out.push(oct10Provenance(scenario.manifest))
    out.push(MEMBRANE_LTV_PROVENANCE)
    if (detection) out.push(detection.provenance)
    if (isDemo) out.push(demoPos.provenance)
    return out
  }, [scenario, detection, isDemo, demoPos])

  // ------------------------------------------------------------------ render
  return (
    <Box
      maxW="1240px"
      mx="auto"
      px={{ base: SPACING.md, md: SPACING.lg }}
      pb={SPACING['2xl']}
      fontFamily={TYPOGRAPHY.fontMono}
      color={SEMANTIC_COLORS.textPrimary}
      display="grid"
      gap={SPACING.lg}
    >
      {/* 1 — THE HERO. The verdict, the gap, the paste card, the graph that draws
          itself. No eyebrow, no thesis sentence, no disclosure box: those are §7. */}
      <VerdictHero
        comparison={comparison}
        isDemo={isDemo}
        startTs={scenario?.series.startTs ?? null}
        stepSeconds={scenario?.series.stepSeconds ?? null}
        errors={heroErrors}
        value={input}
        onChange={setInput}
        onSubmit={onSubmitAddress}
        loadedAddress={loaded?.address ?? null}
        onClear={onClearAddress}
        isLoading={isLoading}
        error={addressError}
      />

      {/* 2 — THE GUARANTEE, verbatim from GUARANTEE. Limit adjacent, never collapsed. */}
      <GuaranteeBlock />

      {/* 3 — YOUR POSITION */}
      {positions.length > 0 && (
        <Box display="grid" gap={SPACING.md}>
          <Box display="flex" gap={SPACING.md} alignItems="baseline" flexWrap="wrap">
            <Text {...SECTION}>your position</Text>
            {isDemo && (
              <Text {...SECTION} color={SEMANTIC_COLORS.warning}>
                worked example — not a real wallet
              </Text>
            )}
          </Box>

          {/* one line per adapter, status only */}
          {loaded && (
            <Box display="flex" gap={SPACING.md} flexWrap="wrap">
              {loaded.results.map((r) => (
                <Text
                  key={`${r.protocol}-${r.label}`}
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize="11px"
                  color={STATUS_COLOR[r.status]}
                  {...tabular}
                >
                  {r.label} · {r.status}
                  {r.status === 'ok' ? ` · ${r.positions.length} positions` : ''}
                </Text>
              ))}
            </Box>
          )}

          {positions.map((p) => (
            <PositionCard
              key={keyOf(p)}
              position={p}
              selectable={positions.length > 1}
              selected={positions.length > 1 && selected ? keyOf(p) === keyOf(selected) : undefined}
              onSelect={positions.length > 1 ? () => onSelectPosition(keyOf(p)) : undefined}
            />
          ))}
        </Box>
      )}

      {/* 4 — WHAT YOU ARE ASSUMING */}
      {selected && (
        <Box display="grid" gap={SPACING.md}>
          <Text {...SECTION}>what you are assuming</Text>
          <Box maxW={{ base: '100%', md: '760px' }}>
            <Controls
              values={values}
              onChange={onControlChange}
              onReset={onResetControls}
              unknownLtvSymbols={derived.unknown}
              venueDetected={detection?.status === 'detected'}
              assumedDeploymentNote={isDemo ? 'Assumed for the example — not detected.' : undefined}
              ltvProvenance={MEMBRANE_LTV_PROVENANCE}
              venueProvenance={venueProvenance}
            />
          </Box>
        </Box>
      )}

      {/* 5 — THE RUN */}
      {selected && (
        <Box display="grid" gap={SPACING.md}>
          <Text {...SECTION}>the run</Text>

          {measuredError && (
            <Text {...monoXs} color={SEMANTIC_COLORS.warning} lineHeight={1.6}>
              Measured Oct 10 liquidation statistics unavailable · documented close factor used
            </Text>
          )}

          {comparison && (
            <>
              <ComparisonPanel
                comparison={comparison}
                onSaveCard={onSaveCard}
                onCopyLink={onCopyLink}
                copyState={copyState}
              />
              <EventLog
                source={comparison.source}
                membrane={comparison.membrane}
                sourceTitle={comparison.position.label}
              />
            </>
          )}

          <DeploymentSection
            detection={detection}
            recallRate={values.recallRate}
            fastRate={values.fastRate}
          />
        </Box>
      )}

      {/* 7 — FINE PRINT. Always rendered, never collapsed, last on the page. */}
      <FinePrint
        caveats={runCaveats}
        unpricedSymbols={comparison?.unpricedSymbols ?? []}
        stamps={stamps}
      />
    </Box>
  )
}

export default Simulator
