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
import { TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { eyebrow, monoXs, tabular } from '@/components/Builder/styles'
import {
  BORROW_LTV_GAP,
  MAX_LIQ_FEE,
  MEMBRANE_LTV_PROVENANCE,
  buildPricePath,
  demoPosition,
  demoSummary,
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

import AddressBar from './AddressBar'
import ComparisonPanel from './ComparisonPanel'
import Controls, { type ControlValues } from './Controls'
import DeploymentSection from './DeploymentSection'
import EquityChart from './EquityChart'
import EventLog from './EventLog'
import PositionCard from './PositionCard'
import Stamp from './Stamp'
import { pct, shortAddress, usd } from './format'

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
function defaultLiqFee(p: ProtocolPosition): { fee: number; note: string } {
  const priced = p.collateral.filter((c) => c.liquidationBonus !== null)
  const value = priced.reduce((a, c) => a + c.valueUsd, 0)
  if (value > 0) {
    const weighted =
      priced.reduce((a, c) => a + (c.liquidationBonus as number) * c.valueUsd, 0) / value
    const fee = Math.min(MAX_LIQ_FEE, Math.max(0, weighted))
    return {
      fee,
      note: `It starts at ${pct(fee)}, matched to ${p.label}'s own collateral-weighted liquidation bonus, so the comparison is not won by giving Membrane a cheaper liquidator. Set your own if you prefer.`,
    }
  }
  return {
    fee: MAX_LIQ_FEE,
    note: `${p.label} exposes no liquidation bonus for this collateral, so there is nothing to match it to. It starts at the ceiling — the least favourable setting for Membrane — rather than at a number we picked.`,
  }
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
    () => (detection ? toVenueRecall(detection) : null),
    [detection],
  )

  const derived = useMemo(
    () =>
      selected
        ? weightedMembraneLine(selected.collateral)
        : { maxLtv: 0, borrowLtv: 0, unknown: [] as string[] },
    [selected],
  )
  const liqFeeDefault = useMemo(
    () => (selected ? defaultLiqFee(selected) : { fee: 0, note: '' }),
    [selected],
  )

  const defaults = useMemo<ControlValues>(() => {
    if (!selected) return ZERO_CONTROLS
    return {
      membraneMaxLtv: derived.maxLtv,
      membraneLiqFee: liqFeeDefault.fee,
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
      {/* header */}
      <Box pt={SPACING.lg} display="grid" gap={SPACING.md}>
        <Text {...eyebrow}>position simulator</Text>
        <Text
          as="h1"
          fontFamily={TYPOGRAPHY.fontDisplay}
          fontSize="clamp(24px, 4vw, 38px)"
          lineHeight={1.12}
          letterSpacing="-0.01em"
          sx={{ textWrap: 'balance' }}
        >
          Put a real position through a real crash, twice.
        </Text>
        <Text fontSize="13px" color={SEMANTIC_COLORS.textSecondary} maxW="82ch" lineHeight={1.8}>
          One position. One measured price path — the 10-11 October 2025 window, minute by minute,
          off the same oracle rounds liquidations actually fire from. Two liquidation engines: the
          protocol the position sits on, and Membrane. The prices are identical in both runs, so
          whatever separates the two endings is the engine.
        </Text>
        <Box
          border="1px solid"
          borderColor={SEMANTIC_COLORS.warning}
          px={SPACING.md}
          py={SPACING.md}
          display="grid"
          gap={SPACING.xs}
        >
          <Text {...HEAD} color={SEMANTIC_COLORS.warning}>
            what this is not
          </Text>
          <Text fontSize="12px" color={SEMANTIC_COLORS.textPrimary} lineHeight={1.8} maxW="82ch">
            Membrane has no Ethereum mainnet deployment. Its per-asset LTV parameters here are
            modelled by us, not read from a live market, and they sit in the controls where you can
            change them. A simulation is not a forecast: this replays one measured window under a
            model, and the edge a model shows is not the edge you get live.
          </Text>
        </Box>
      </Box>

      {/* demo-first banner — persistent for as long as the worked example is on screen */}
      {isDemo && (
        <Box
          border="1px solid"
          borderColor={SEMANTIC_COLORS.warning}
          bg={SEMANTIC_COLORS.bgSecondary}
          px={SPACING.base}
          py={SPACING.md}
          display="grid"
          gap={SPACING.xs}
        >
          <Box display="flex" gap={SPACING.md} alignItems="baseline" flexWrap="wrap">
            <Text {...HEAD} color={SEMANTIC_COLORS.warning}>
              worked example — not a real wallet
            </Text>
            <Stamp provenance={demoPos.provenance} />
          </Box>
          <Text fontSize="12px" color={SEMANTIC_COLORS.textPrimary} lineHeight={1.8} maxW="82ch">
            {demoSummary()} The balances are invented so the page has something to show before you
            type anything. The Aave V3 risk parameters attached to them are real mainnet values, and
            the price path is real. Paste an address to replace all of this with your own.
          </Text>
        </Box>
      )}

      <AddressBar
        value={input}
        onChange={setInput}
        onSubmit={onSubmitAddress}
        loadedAddress={loaded?.address ?? null}
        onClear={onClearAddress}
        isLoading={isLoading}
        error={addressError}
      />

      {/* per-adapter outcome — every status, verbatim */}
      {loaded && (
        <Box
          bg={SEMANTIC_COLORS.bgSecondary}
          border="1px solid"
          borderColor={SEMANTIC_COLORS.borderSubtle}
          p={SPACING.base}
          display="grid"
          gap={SPACING.sm}
        >
          <Box
            display="flex"
            justifyContent="space-between"
            alignItems="baseline"
            gap={SPACING.md}
            flexWrap="wrap"
          >
            <Text {...eyebrow}>what each protocol said about {shortAddress(loaded.address)}</Text>
            <Stamp
              provenance={stamp(
                'onchain',
                'lending reads · public rpc',
                'Each protocol is read independently. One failing read never blanks the page and never changes another protocol’s answer.',
                loaded.results[0]?.fetchedAt,
              )}
            />
          </Box>
          {loaded.results.map((r) => (
            <Box
              key={`${r.protocol}-${r.label}`}
              display="flex"
              gap={SPACING.md}
              flexWrap="wrap"
              alignItems="baseline"
              borderBottom="1px solid"
              borderColor={SEMANTIC_COLORS.borderSubtle}
              py={SPACING.xs}
            >
              <Text fontSize="11.5px" color={SEMANTIC_COLORS.textPrimary} minW="120px">
                {r.label}
              </Text>
              <Text {...HEAD} color={STATUS_COLOR[r.status]} minW="90px">
                {r.status}
              </Text>
              <Text
                fontSize="11px"
                color={SEMANTIC_COLORS.textSecondary}
                flex="1 1 260px"
                lineHeight={1.7}
              >
                {r.status === 'ok'
                  ? `${r.positions.length} position${r.positions.length === 1 ? '' : 's'}`
                  : (r.message ?? 'no detail was returned')}
              </Text>
              <Text {...monoXs} {...tabular}>
                {r.tookMs !== undefined ? `${r.tookMs.toLocaleString('en-US')} ms` : ''}
              </Text>
            </Box>
          ))}
          {positions.length === 0 && (
            <Text fontSize="12px" color={SEMANTIC_COLORS.textPrimary} lineHeight={1.8} maxW="82ch">
              No open position was found for this address on any protocol we can read, so there is
              nothing to simulate. The rows above say what each read returned. This page will not
              substitute an example position for yours.
            </Text>
          )}
        </Box>
      )}

      {/* positions */}
      {positions.length > 0 && (
        <Box display="grid" gap={SPACING.md}>
          {positions.length > 1 && (
            <Text
              fontSize="12px"
              color={SEMANTIC_COLORS.textSecondary}
              lineHeight={1.8}
              maxW="82ch"
            >
              {positions.length} positions found. The largest loan is selected by default because it
              is the one whose liquidation moves the most money — pick another to run it instead.
            </Text>
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

      {/* controls + comparison */}
      {selected && (
        <Box
          display="grid"
          gridTemplateColumns={{ base: '1fr', lg: '340px 1fr' }}
          gap={SPACING.md}
          alignItems="start"
        >
          <Controls
            values={values}
            onChange={onControlChange}
            onReset={onResetControls}
            derivedMaxLtv={derived.maxLtv}
            unknownLtvSymbols={derived.unknown}
            venueDetected={detection?.status === 'detected'}
            ltvProvenance={MEMBRANE_LTV_PROVENANCE}
            venueProvenance={venueProvenance}
            liqFeeDefaultNote={liqFeeDefault.note}
          />

          {comparison ? (
            <ComparisonPanel
              comparison={comparison}
              isDemo={isDemo}
              onSaveCard={onSaveCard}
              onCopyLink={onCopyLink}
              copyState={copyState}
            />
          ) : (
            <Box
              bg={SEMANTIC_COLORS.bgSecondary}
              border="1px solid"
              borderColor={scenarioError ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.borderSubtle}
              p={SPACING.base}
              display="grid"
              gap={SPACING.sm}
              transition={TRANSITIONS.colors}
            >
              <Text {...eyebrow}>03 / two engines, one price path</Text>
              <Text
                fontSize="12px"
                color={scenarioError ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.textSecondary}
                lineHeight={1.8}
                maxW="76ch"
              >
                {scenarioError
                  ? `The measured price path could not be loaded, so no run was produced: ${scenarioError}`
                  : 'Reading the measured October 2025 price path. The run starts as soon as it lands.'}
              </Text>
            </Box>
          )}
        </Box>
      )}

      {measuredError && (
        <Text {...monoXs} color={SEMANTIC_COLORS.warning} lineHeight={1.7} maxW="86ch">
          The measured Oct 10 liquidation statistics could not be loaded ({measuredError}), so the
          source protocol&apos;s repay size falls back to its documented close factor. The label
          under the run says which one was used.
        </Text>
      )}

      {comparison && scenario && (
        <EquityChart
          comparison={comparison}
          startTs={scenario.series.startTs}
          stepSeconds={scenario.series.stepSeconds}
        />
      )}

      {comparison && (
        <EventLog
          source={comparison.source}
          membrane={comparison.membrane}
          sourceTitle={comparison.position.label}
        />
      )}

      <DeploymentSection
        detection={detection}
        recallRate={values.recallRate}
        fastRate={values.fastRate}
      />

      {/* closing provenance */}
      <Box
        border="1px solid"
        borderColor={SEMANTIC_COLORS.borderSubtle}
        p={SPACING.base}
        display="grid"
        gap={SPACING.sm}
      >
        <Text {...eyebrow}>where every number came from</Text>
        <Box display="flex" gap={SPACING.sm} flexWrap="wrap">
          {scenario && <Stamp provenance={oct10Provenance(scenario.manifest)} />}
          <Stamp provenance={MEMBRANE_LTV_PROVENANCE} />
          {detection && <Stamp provenance={detection.provenance} />}
          {isDemo && <Stamp provenance={demoPos.provenance} />}
        </Box>
        {comparison && (
          <Text
            fontSize="11.5px"
            color={SEMANTIC_COLORS.textSecondary}
            lineHeight={1.8}
            maxW="86ch"
          >
            The source engine repaid{' '}
            {comparison.source.events.length === 0
              ? 'nothing over this window'
              : `at ${comparison.source.events.length} moment${comparison.source.events.length === 1 ? '' : 's'}`}
            , at a close factor of{' '}
            {pct(measuredRepayFraction(comparison.position.protocol, measured).fraction, 0)} per
            event — {measuredRepayFraction(comparison.position.protocol, measured).label}. Membrane
            repaid at {comparison.membrane.events.length.toLocaleString('en-US')} moment
            {comparison.membrane.events.length === 1 ? '' : 's'}, restoring the{' '}
            {pct(Math.max(0, values.membraneMaxLtv - BORROW_LTV_GAP))} borrow cap each time rather
            than clearing the loan, and paid {usd(comparison.membrane.penaltyPaidUsd)} in fees
            against the source protocol&apos;s {usd(comparison.source.penaltyPaidUsd)}.
          </Text>
        )}
        <Text {...monoXs} lineHeight={1.75} maxW="86ch">
          This page reads public mainnet state over a public RPC. It never asks for a wallet
          connection, never asks for a signature, and cannot move anything. Colour-coded stamps:
          teal is read on-chain this session, grey is a committed measured dataset, gold is modelled
          or fixture data.
        </Text>
      </Box>
    </Box>
  )
}

export default Simulator
