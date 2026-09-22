// The position simulator.
//
// DEMO-FIRST (CLAUDE.md V20): this renders fully populated with a worked example on
// first paint. There is no empty state, no connect gate and no wallet anywhere in this
// file — the page reads public mainnet state and nothing else.
//
// The default wallet is now a REAL one (owner ruling 2026-09-11 — "why is the worked
// example not just the demo wallet shown?"). lib/position-sim/demo.ts serves a
// committed on-chain snapshot: a real borrower, its real borrow rate, its real venue
// balances. So the demo path and the pasted-address path finally carry the same KIND
// of number, and the page can lead with what the carry costs.
//
// The one hard rule about the demo is unchanged and still load-bearing: the moment a
// real address is read, the snapshot is GONE. A failed adapter shows its own error and
// never falls back to demo numbers, and a pasted address only ever gets what
// detectVenues found for IT — never the snapshot's deployment.
//
// TWO MODES, TWO DEMOS (owner ruling 2026-09-12 — "keep this build as a toggle flip in
// case we want to go back to borrower-first — or a separate page"). Same component,
// same engine, same controls; `mode` picks which wallet it opens on and which story
// leads the hero:
//   'carry'    lib/position-sim/demo.ts — a live mainnet carry, snapshot 2026-09-12.
//   'borrower' lib/position-sim/demoBorrower.ts — a real wallet Aave V3 liquidated on
//              10 Oct 2025, with NO deployment (a liquidated borrower had none, and we
//              do not assume one).
// config/simulatorMode.ts decides which one `/` and the nav point at. Both pages exist
// and both are indexable, so the flip is one constant and nothing else.

import { DEMO_BORROWER_MEASURED } from '@/lib/position-sim/demoBorrower'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import NextLink from 'next/link'
import { useRouter } from 'next/router'
import { Box, Button, Text } from '@chakra-ui/react'

import { DEFAULT_CHAIN } from '@/config/chains'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import {
  LANDING_SIM_MODE,
  OTHER_MODE,
  SIM_MODE_LINK_LABEL,
  SIM_ROUTE,
  resolveHeroVariant,
  type SimMode,
} from '@/config/simulatorMode'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import useWallet from '@/hooks/useWallet'
import type { LandingVariant } from '@/lib/landingVariant'
import { monoXs, tabular } from '@/components/Builder/styles'
import {
  MEMBRANE_LTV_PROVENANCE,
  buildPricePath,
  DEMO_SNAPSHOT_NOTE,
  carryCost,
  demoBorrowerDetection,
  demoBorrowerPosition,
  demoDetection,
  demoPosition,
  DEMO_ADDRESS,
  DEMO_BORROWER_ADDRESS,
  DEMO_BORROWER_NOTE,
  detectVenues,
  engineOutcome,
  excludeOwnCollateral,
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
import CarrySection from './CarrySection'
import { usd, utcClock } from './format'
import GuaranteeBlock from './GuaranteeBlock'
import HistoryProof from './HistoryProof'
import { useSimHistory } from './hooks/useSimHistory'
import PositionCard from './PositionCard'
import { recordLandingEvent } from './recordLandingEvent'
import { recordSimRead } from './recordRead'
import VerdictHero from './VerdictHero'

/**
 * Plain section title. There are no numbered eyebrows on this page any more.
 * The bottom margin is part of the section rhythm below (owner ruling 2026-09-12).
 */
const SECTION = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: '10px',
  letterSpacing: '0.24em',
  textTransform: 'uppercase' as const,
  color: SEMANTIC_COLORS.textSecondary,
  marginBottom: SPACING.md,
}

/**
 * THE SECTION SHELL — owner ruling 2026-09-12: "it all just blends in".
 *
 * Every top-level block on this page now sits in the same container, so the page reads
 * as a stack of BANDS instead of one continuous scroll of mono text. Three levers, all
 * of them consistent and none of them per-section decoration:
 *   · paddingY SPACING.xl (32px) — the same air above and below every band;
 *   · borderTop on borderStrong — a visible seam between bands, except at the very top
 *     (the hero opens the page and has nothing to be separated from);
 *   · ALTERNATING background — evidence bands (the history proof, the carry section,
 *     the run) sit on bgSecondary and are inset by SPACING.base, so what is measured
 *     looks different from what is asserted.
 * The page container's own gap is 0: the bands butt against each other, which is what
 * makes the seam and the background change legible. No copy changes with this.
 */
const Section: React.FC<{
  /** 'evidence' = measured/fetched material. Everything else is 'plain'. */
  tone?: 'plain' | 'evidence'
  /** The hero. Opens the page, so it carries no top seam. */
  first?: boolean
  children: React.ReactNode
}> = ({ tone = 'plain', first = false, children }) => (
  <Box
    as="section"
    py={SPACING.xl}
    borderTop={first ? undefined : '1px solid'}
    borderColor={first ? undefined : SEMANTIC_COLORS.borderStrong}
    bg={tone === 'evidence' ? SEMANTIC_COLORS.bgSecondary : SEMANTIC_COLORS.bgPrimary}
    px={tone === 'evidence' ? SPACING.base : undefined}
  >
    {children}
  </Box>
)

const HEAD = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: '9px',
  letterSpacing: '0.24em',
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
 * Owner ruling 2026-09-14: the protocol liquidation fee is 0 (membrane-solidity
 * 318f3915, script/DeployFullSystem.s.sol LIQ_FEE = 0). A pasted address therefore starts
 * at the deployed value, the same one the demo already used. The earlier default matched
 * the source protocol's collateral-weighted liquidation bonus so the comparison could not
 * be accused of handing Membrane a cheaper liquidator; that guarded against a claim the
 * deploy no longer makes, and it overstated Membrane's cost on every real address. The
 * control still exists: the reader can set any fee up to the 10% contract ceiling and the
 * URL carries it. The liquidator's own ramp (LiquidationEngine.sol:1504-1514) is not a
 * protocol fee and is outside this model.
 */
function defaultLiqFee(_p: ProtocolPosition): number {
  return 0
}

/** The one sentence the fine print owes the reader about the default wallet, per mode. */
const DEMO_WALLET_NOTE: Record<SimMode, string> = {
  carry:
    'The default wallet is a real mainnet borrower, snapshot 2026-09-12. No venue ' +
    'deployment was detected for it, so no cost line is shown; paste a wallet that ' +
    'borrows and deploys to see yours.',
  borrower:
    'The default wallet is a real Aave V3 account that was liquidated on 10 Oct 2025, ' +
    'selected from the 2,350 measured accounts in public/data/oct10-2025/evidence.json. ' +
    'It had no deployment and none is assumed; paste any address to read a live position.',
}

const ZERO_CONTROLS: ControlValues = {
  membraneMaxLtv: 0,
  membraneLiqFee: 0,
  recallRate: 0,
  fastRate: 0,
  deployedUsd: 0,
}

export interface SimulatorProps {
  /** Which demo the page opens on, and which story leads the hero. */
  mode?: SimMode
  /**
   * HERO FORM. Renders the verdict and the named guarantee and stops there, plus the
   * "why it held" receipt when the Membrane run survived. Used by the seniority landing
   * (components/Seniority/Hero.tsx); the whole page still lives at its own route.
   */
  hero?: boolean
  /** Hero form only: label for the primary connect button. */
  connectLabel?: string
  readNote?: string
  /**
   * THE LANDING H1 TEST (owner ruling 2026-09-15). Set only by the landing hero, to
   * the variant the server rendered above this simulator. When it is set, a successful
   * address read reports one 'run' event, which is the single conversion the test
   * scores. Absent everywhere else, so /[chain]/simulator records nothing.
   */
  landingVariant?: LandingVariant
}

export const Simulator: React.FC<SimulatorProps> = ({
  mode = LANDING_SIM_MODE,
  hero = false,
  connectLabel,
  readNote,
  landingVariant,
}) => {
  const router = useRouter()
  /** Keeps the sibling-mode link on the chain the reader is already on. */
  const chainForLinks = typeof router.query.chain === 'string' ? router.query.chain : DEFAULT_CHAIN

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

  /**
   * THE H1 TEST's conversion, deduped. One 'run' per address per page load: a reader
   * who re-runs the same wallet, or whose wallet prefill lands on an address they had
   * already pasted, is one conversion, not two.
   */
  const landingFired = useRef<Set<string>>(new Set())

  /** Reads an address. Never clears the control overrides — the URL hydration path
   *  needs to apply them after the read lands.
   *
   *  `source` says where the address came from: 'wallet' when the connect prefill
   *  supplied it, 'paste' for a typed address and for one hydrated from a shared link.
   *  It is carried into the landing event and nowhere else. */
  const readAddress = useCallback(
    async (raw: string, source: 'paste' | 'wallet' = 'paste') => {
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
        // Landing H1 test: the run is the conversion. Fire-and-forget, deduped, and
        // only on the landing hero, which is the only caller that sets the variant.
        if (landingVariant && !landingFired.current.has(parsed)) {
          landingFired.current.add(parsed)
          recordLandingEvent({
            variant: landingVariant,
            kind: 'run',
            chain: chainForLinks,
            address: parsed,
            source,
          })
        }
      } finally {
        setLoading(false)
      }
    },
    [landingVariant, chainForLinks],
  )

  // ------------------------------------------------------- wallet prefill
  // THE INTENT-PRESERVING CONNECT (CLAUDE.md V20). There is still no wallet GATE here:
  // the page opens fully populated on the demo wallet and stays that way for a stranger.
  // Connecting simply supplies the address the reader would otherwise have pasted, so
  // the CTA they already saw runs on their own position instead of the demo's.
  //
  // It fires once per address (ref guard) and only while the reader has typed nothing
  // and read nothing — a pasted address, or one hydrated from the URL, always wins.
  const { address } = useWallet()
  const prefilled = useRef<string | null>(null)
  useEffect(() => {
    if (!address || isLoading) return
    if (input !== '' || loaded !== null) return
    if (prefilled.current === address) return
    prefilled.current = address
    setInput(address)
    void readAddress(address, 'wallet')
  }, [address, input, loaded, isLoading, readAddress])

  // --------------------------------------------------------------- positions
  // THE DEMO IS PICKED BY MODE, and by nothing else. Neither demo ever leaks into the
  // other page, and neither survives a pasted address.
  const demoPos = useMemo(
    () => (mode === 'borrower' ? demoBorrowerPosition() : demoPosition()),
    [mode],
  )
  const demoDet = useMemo(
    () => (mode === 'borrower' ? demoBorrowerDetection() : demoDetection()),
    [mode],
  )
  /** The one-line stamp beside the demo position. Names what it is, per mode. */
  const demoTag = mode === 'borrower' ? DEMO_BORROWER_NOTE : DEMO_SNAPSHOT_NOTE
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
  // The demo's deployment is no longer assumed — it is the venue scan the snapshot
  // recorded for the same real address, so both branches are now the same shape and
  // both go through toVenueRecall. A pasted address still only ever gets what
  // detectVenues found for IT.
  const rawDetection = loaded?.detection ?? demoDet
  // A venue balance that is already this position's collateral is not recallable venue
  // capital — it is the collateral the recall was supposed to save. Filtering here, on
  // the way in, keeps the cost model, the controls, the deployment section and the
  // engine looking at the same dollars. See excludeOwnCollateral for the measurement
  // that forced this.
  const detection = useMemo(
    () => excludeOwnCollateral(rawDetection, selected),
    [rawDetection, selected],
  )
  const detectedRecall = useMemo<VenueRecall | null>(() => toVenueRecall(detection), [detection])

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

  // -------------------------------------------------------------- carry cost
  // What the source protocol bills this position a year, and what the deployed slice
  // costs on Membrane (nothing). Zero when no rate was readable or nothing is
  // deployed — the hero then falls back to the safety verdict rather than inventing
  // a rate. See lib/position-sim/carryCost.ts for why undeployed debt is never costed.
  const carry = useMemo(() => carryCost(selected, detection), [selected, detection])

  // ---------------------------------------------------- the secondary proof
  // THE ADDRESS ON SCREEN. The demo wallet on the demo, the pasted one after a read —
  // never both, and never the other mode's demo. The hook is shared with HistoryProof
  // through react-query's cache, so this is one request, not two.
  const historyAddress =
    loaded?.address ?? (mode === 'borrower' ? DEMO_BORROWER_ADDRESS : DEMO_ADDRESS)
  const simHistory = useSimHistory(historyAddress)
  // The hero's history input. A failed scan reports savedUsd 0, which is exactly the
  // fallback condition — the hero drops back to the Oct 10 verdict rather than printing
  // an error where the headline goes. HistoryProof prints the error, in its own block.
  const heroHistory = useMemo(
    () => ({
      savedUsd: simHistory.data && !simHistory.data.error ? simHistory.data.totals.savedUsd : 0,
      savedCount: simHistory.data && !simHistory.data.error ? simHistory.data.totals.savedCount : 0,
      firstEventTs: simHistory.data?.since?.firstEventTs ?? null,
      loading: simHistory.isPending,
    }),
    [simHistory.data, simHistory.isPending],
  )
  /** ?hero=history flips the A/B by LINK, with no deploy. Captured ONCE at hydration
   *  (the page rewrites its own URL and would otherwise drop it) and carried in the
   *  URL state so copy-link keeps the variant. Falls back to HERO_VARIANT. */
  const [heroOverride, setHeroOverride] = useState<'oct10' | 'history' | null>(null)
  const heroVariant = resolveHeroVariant(heroOverride ?? undefined)

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
    if (s.hero !== undefined) setHeroOverride(s.hero)
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
      hero: heroOverride ?? undefined,
    }),
    [loaded, selected, values, heroOverride],
  )

  useEffect(() => {
    // Hero form never writes control state into the URL. On the landing this effect
    // rewrote an indexable canonical URL to /ethereum?p=aave-v3&ltv=…&dep=…, which
    // splits the page's SEO identity and makes a copied link carry demo controls.
    if (hero) return
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
  /** One set of address-bar props, mounted three times (hero, carry section, foot). */
  const addressBarProps = {
    value: input,
    onChange: setInput,
    onSubmit: onSubmitAddress,
    loadedAddress: loaded?.address ?? null,
    onClear: onClearAddress,
    isLoading,
    error: addressError,
  }


  /** Every caveat either run recorded, de-duplicated. Generated by the engine. */
  const runCaveats = useMemo<string[]>(
    () =>
      comparison
        ? Array.from(new Set([...comparison.source.caveats, ...comparison.membrane.caveats]))
        : [],
    [comparison],
  )

  /** Where the rate behind the cost headline came from. Only printed when one was. */
  const borrowRateNote = useMemo<string | undefined>(() => {
    if (!selected || carry.pricedDebtUsd <= 0) return undefined
    return `${selected.label} borrow rate read on-chain ${isDemo ? 'at snapshot' : 'at read time'}.`
  }, [selected, carry, isDemo])

  /** The standing notes this run owes the reader. The liquidation-history METHOD is
   *  printed VERBATIM from the API — the route knows which approximations the scan
   *  actually made (archive vs current params, truncation, an incomplete log span), and
   *  a hand-written copy here would go stale the first time one of them changed. */
  const finePrintNotes = useMemo<string[] | undefined>(() => {
    const out: string[] = []
    if (isDemo) out.push(DEMO_WALLET_NOTE[mode])
    const m = simHistory.data?.method
    if (m) out.push(m)
    return out.length > 0 ? out : undefined
  }, [isDemo, mode, simHistory.data])

  const stamps = useMemo<Provenance[]>(() => {
    const out: Provenance[] = []
    if (scenario) out.push(oct10Provenance(scenario.manifest))
    out.push(MEMBRANE_LTV_PROVENANCE)
    out.push(detection.provenance)
    if (isDemo) out.push(demoPos.provenance)
    return out
  }, [scenario, detection, isDemo, demoPos])

  /**
   * WHY IT HELD. Only rendered when the Membrane run finished with no collateral-seizing
   * liquidation (engineOutcome, lib/position-sim/outcome.ts) — the receipt behind that
   * verdict, not a second claim about it.
   *
   * The rows are the recall and cure events the engine ALREADY recorded for the event
   * log; nothing is recomputed and no engine logic is added here. `null` means the
   * position was liquidated (or there is no run yet), and the block is skipped.
   */
  const heldEvents = useMemo(() => {
    if (!comparison) return null
    if (engineOutcome(comparison.membrane).liquidated) return null
    return comparison.membrane.events.filter((e) => e.kind === 'recall' || e.kind === 'cure')
  }, [comparison])

  // ------------------------------------------------------------------ render
  return (
    <Box
      maxW="1240px"
      mx="auto"
      // Hero form lives inside the landing's own container: no inset of its own, so the
      // verdict shares the h1's left edge (alignment is grouping).
      px={hero ? 0 : { base: SPACING.md, md: SPACING.lg }}
      w={hero ? '100%' : undefined}
      pb={hero ? 0 : SPACING['2xl']}
      fontFamily={TYPOGRAPHY.fontMono}
      color={SEMANTIC_COLORS.textPrimary}
      display="grid"
      gap={SPACING.none}
    >
      {/* 1 — THE HERO. The verdict, the gap, the paste card, the graph that draws
          itself. No eyebrow, no thesis sentence, no disclosure box: those are §7.
          Borderless: it opens the page and has nothing above it to be separated from. */}
      <Section first>
        <VerdictHero
          comparison={comparison}
          carry={carry}
          mode={mode}
          hideSubhead={hero}
          compact={hero}
          primaryConnect={hero}
          connectLabel={connectLabel}
          readNote={readNote}
          heroVariant={heroVariant}
          history={heroHistory}
          isDemo={isDemo}
          measured={isDemo ? DEMO_BORROWER_MEASURED : null}
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
      </Section>

      {/* 2 — THE GUARANTEE, verbatim from GUARANTEE. Limit adjacent, never collapsed. */}
      <Section>
        <GuaranteeBlock />

        {/* 2h — WHY IT HELD. Hero form only: the guarantee states the rule, this states
            what the rule did on THIS run. One mono line per recorded event. */}
        {hero && heldEvents !== null && (
          <Box
            mt={SPACING.base}
            border="1px solid"
            borderColor={SEMANTIC_COLORS.borderSubtle}
            borderRadius={0}
            px={SPACING.base}
            py={SPACING.md}
            display="grid"
            gap={SPACING.sm}
          >
            <Text {...HEAD}>why it held</Text>
            {heldEvents.length === 0 ? (
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="11px"
                color={SEMANTIC_COLORS.textPrimary}
                {...tabular}
              >
                Stayed inside the 4% band for the whole window.
              </Text>
            ) : (
              heldEvents.map((e, k) => (
                <Text
                  key={`held-${e.minute}-${k}`}
                  title={e.why}
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize="11px"
                  color={SEMANTIC_COLORS.textPrimary}
                  {...tabular}
                >
                  {utcClock(e.ts)} · {e.kind} · recalled {usd(e.recalledUsd)} · repaid{' '}
                  {usd(e.repaidUsd)}
                </Text>
              ))
            )}
          </Box>
        )}
      </Section>

      {/* SECTIONS 2a THROUGH 9 belong to the full page only. In hero form the block
          above is the end of the component and the rest of the sim lives at its own
          route — nothing below is restructured, it is simply not mounted. */}
      {!hero && (
        <>
          {/* 2a — THE SECONDARY PROOF. The Oct 10 hero is a counterfactual about one day;
          this is what the same delay infrastructure would have done to the events that
          actually happened to the address on screen. A wallet with no history says so
          in one line and prints no number — never a manufactured near-miss.
          EVIDENCE band: measured events, not a claim. */}
          <Section tone="evidence">
            <HistoryProof address={historyAddress} />
          </Section>

          {/* 2b — THE PRODUCT, UNDER THE FOLD. Owner layout ruling 2026-09-12: one landing
          page — "the sim is borrows, while under the fold is carries". This is the first
          thing below the hero, on BOTH builds (it carries the claims that used to
          render standalone on the carry page), and it sells with live evidence rather
          than description. Its numbers are fetched or stamped modelled, never invented. */}
          <Section tone="evidence">
            <CarrySection
              positionDebtUsd={selected?.totalDebtUsd ?? 0}
              detection={detection}
              addressBar={addressBarProps}
            />
          </Section>

          {/* 3 — YOUR POSITION */}
          {positions.length > 0 && (
            <Section>
              <Box display="grid" gap={SPACING.md}>
                <Box display="flex" gap={SPACING.md} alignItems="baseline" flexWrap="wrap">
                  <Text {...SECTION}>your position</Text>
                  {isDemo && (
                    <Text {...SECTION} color={SEMANTIC_COLORS.textSecondary}>
                      real wallet · {demoTag}
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
                    selected={
                      positions.length > 1 && selected ? keyOf(p) === keyOf(selected) : undefined
                    }
                    onSelect={positions.length > 1 ? () => onSelectPosition(keyOf(p)) : undefined}
                  />
                ))}
              </Box>
            </Section>
          )}

          {/* 4 — WHAT YOU ARE ASSUMING */}
          {selected && (
            <Section>
              <Box display="grid" gap={SPACING.md}>
                <Text {...SECTION}>what you are assuming</Text>
                <Box maxW={{ base: '100%', md: '760px' }}>
                  <Controls
                    values={values}
                    onChange={onControlChange}
                    onReset={onResetControls}
                    unknownLtvSymbols={derived.unknown}
                    venueDetected={detection?.status === 'detected'}
                    assumedDeploymentNote={undefined}
                    ltvProvenance={MEMBRANE_LTV_PROVENANCE}
                    venueProvenance={venueProvenance}
                  />
                </Box>
              </Box>
            </Section>
          )}

          {/* 5 — THE RUN. EVIDENCE band: this is the measured comparison itself. */}
          {selected && (
            <Section tone="evidence">
              <Box display="grid" gap={SPACING.md}>
                <Text {...SECTION}>the run</Text>

                {measuredError && (
                  <Text {...monoXs} color={SEMANTIC_COLORS.warning} lineHeight={1.6}>
                    Measured Oct 10 liquidation statistics unavailable · documented close factor
                    used
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
            </Section>
          )}

          {/* 7 — FINE PRINT. Always rendered, never collapsed, last block before the CTA. */}
          <Section>
            <FinePrint
              caveats={runCaveats}
              unpricedSymbols={comparison?.unpricedSymbols ?? []}
              stamps={stamps}
              borrowRateNote={borrowRateNote}
              extraNotes={finePrintNotes}
            />
          </Section>

          {/* 8 — BACK TO THE TOP (owner 2026-09-22, replaces the repeated CTA). One control
          in the section-label style, so it reads as part of the page's own labelling
          rather than a widget. The hero holds the paste box it scrolls to. */}
          <Box display="flex" justifyContent="center" pt={SPACING.xl}>
            <Button
              type="button"
              data-testid="sim-jump-top"
              onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
              variant="unstyled"
              display="inline-flex"
              alignItems="center"
              gap={SPACING.sm}
              h="auto"
              px={SPACING.md}
              py={SPACING.sm}
              border="1px solid"
              borderColor={SEMANTIC_COLORS.borderStrong}
              borderRadius={0}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="10px"
              letterSpacing="0.24em"
              textTransform="uppercase"
              color={SEMANTIC_COLORS.textSecondary}
              _hover={{ color: SEMANTIC_COLORS.success, borderColor: SEMANTIC_COLORS.success }}
            >
              back to the top
            </Button>
          </Box>

          {/* 9 — THE OTHER BUILD. Both simulators are live and indexable; only one of them
          is the landing page (config/simulatorMode.ts). One line, at the foot, so the
          other ordering is reachable without spending a nav slot on it. Not a section:
          a footnote below the last band. */}
          <Text {...monoXs} color={SEMANTIC_COLORS.textSecondary} pt={SPACING.base}>
            <NextLink href={`/${chainForLinks}${SIM_ROUTE[OTHER_MODE[mode]]}`}>
              {SIM_MODE_LINK_LABEL[OTHER_MODE[mode]]}
            </NextLink>
          </Text>
        </>
      )}
    </Box>
  )
}

export default Simulator
