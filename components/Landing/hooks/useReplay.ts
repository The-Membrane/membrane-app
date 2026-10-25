// THE LANDING'S STATE MACHINE. One hook owns what is on screen:
//   demo     the demo wallet (a real wallet Aave V3 liquidated on 10 Oct 2025), under the
//            "Demo — not yours" banner. What a stranger sees first (V20).
//   address  a pasted, connected, shared or remembered wallet, read live and replayed.
//   manual   a position entered by hand.
// The demo dies the moment a real position is read; a failed read shows its error and
// never falls back to demo numbers (the simulator's rule, components/Simulator).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/router'

import useWallet from '@/hooks/useWallet'
import {
  detectVenues,
  loadOct10,
  parseAddress,
  runAdapters,
  weightedMembraneLine,
  type AdapterResult,
  type Comparison,
  type Oct10Manifest,
  type Oct10Series,
  type ProtocolPosition,
  type VenueDetection,
  SYMBOL_TO_SERIES,
} from '@/lib/position-sim'
import type { HeadlineKey } from '@/lib/landing/headline'
import { track } from '@/lib/landing/instrumentation'
import { buildManualPosition, decodeManual, encodeManual, type ManualError, type ManualInput, type ProtocolsDoc } from '@/lib/landing/manualPosition'
import type { CensusRow } from '@/lib/landing/census'
import type { DemoConfig } from '@/lib/landing/pages'
import { largestPosition, positionKey, runReplay, type MeasuredLiquidations } from '@/lib/landing/replay'
import {
  classifyVisit,
  sameKey,
  readVisit,
  visitDelta,
  writeVisit,
  type VisitDelta,
  type VisitRecord,
  type VisitState,
} from '@/lib/landing/returnVisit'
import { DEFAULT_SCENARIO_ID, scenarioById } from '@/lib/landing/scenarios'
import { closedTotals } from '@/lib/landing/verdict'
import type { UsdeExitLiquidity } from '@/lib/landing/sizeSkew'

export type ReplayMode = 'demo' | 'address' | 'manual'
export type ReadSource = 'paste' | 'wallet' | 'link' | 'return'

export interface FullProtocolsDoc extends ProtocolsDoc {
  measuredLiquidations?: MeasuredLiquidations
  usdeExitLiquidity?: UsdeExitLiquidity
}

export function useReplay(headline: HeadlineKey, demo: DemoConfig) {
  const router = useRouter()

  // ---------------------------------------------------------------- scenario
  const [scenarioId, setScenarioId] = useState(DEFAULT_SCENARIO_ID)
  const scenario = scenarioById(scenarioId)
  const [data, setData] = useState<{ series: Oct10Series; manifest: Oct10Manifest } | null>(null)
  const [protocols, setProtocols] = useState<FullProtocolsDoc | null>(null)
  const [dataError, setDataError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    loadOct10()
      .then((d) => alive && setData(d))
      .catch((e: Error) => alive && setDataError(e.message))
    fetch(`${scenario.dataPath}/protocols.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: FullProtocolsDoc) => alive && setProtocols(j))
      .catch(() => alive && setProtocols(null))
    return () => {
      alive = false
    }
  }, [scenario.dataPath])

  // ---------------------------------------------------------------- reading
  const [mode, setMode] = useState<ReplayMode>('demo')
  const [input, setInput] = useState('')
  const [addressError, setAddressError] = useState<string | null>(null)
  const [isLoading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState<{
    address: `0x${string}`
    results: AdapterResult[]
    detection: VenueDetection
    source: ReadSource
  } | null>(null)
  const [manual, setManual] = useState<ManualInput | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)

  const readAddress = useCallback(
    async (raw: string, source: ReadSource) => {
      const parsed = parseAddress(raw)
      if (!parsed) {
        setAddressError('Not an address: 0x plus 40 hex characters.')
        return
      }
      setAddressError(null)
      setLoading(true)
      try {
        const [results, detection] = await Promise.all([runAdapters(parsed), detectVenues(parsed)])
        setLoaded({ address: parsed, results, detection, source })
        setSelectedKey(null)
        setMode('address')
        track({
          name: 'wallet_run',
          headline,
          source,
          address: parsed,
          scenarioId,
          protocols: results.filter((r) => r.positions.length > 0).map((r) => r.protocol),
        })
      } finally {
        setLoading(false)
      }
    },
    [headline, scenarioId],
  )

  // ------------------------------------------------------------- positions
  const demoPos = useMemo(() => demo.position(), [demo])
  const demoDet = useMemo(() => demo.detection(), [demo])

  const manualBuilt = useMemo(() => {
    if (!manual || !data) return null
    const series = data.series.columns[SYMBOL_TO_SERIES[manual.collateral]]
    const first = series?.find((v) => v !== null) ?? null
    return buildManualPosition(manual, protocols, first)
  }, [manual, data, protocols])
  const manualError: ManualError | null = manualBuilt && 'error' in manualBuilt ? manualBuilt.error : null

  const positions = useMemo<ProtocolPosition[]>(() => {
    if (mode === 'address' && loaded) return loaded.results.flatMap((r) => r.positions)
    if (mode === 'manual') return manualBuilt && 'position' in manualBuilt ? [manualBuilt.position] : []
    return [demoPos]
  }, [mode, loaded, manualBuilt, demoPos])

  const selected = useMemo(() => {
    const found = positions.find((p) => positionKey(p) === selectedKey)
    return found ?? largestPosition(positions)
  }, [positions, selectedKey])

  const detection = mode === 'address' ? loaded?.detection ?? null : mode === 'demo' ? demoDet : null

  // THE MEASURED SIDE (review D1). The demo position IS its census row, so Aave's side
  // is what Aave actually closed. A live address replays TODAY's position, which is not
  // the position the census measured, so its row (fetched below) is shown as a separate
  // line and never folded into today's replay.
  const census = mode === 'demo' ? demo.census : null

  const comparison = useMemo<Comparison | null>(() => {
    if (!selected || !data) return null
    return runReplay(selected, detection, { ...data, measured: protocols?.measuredLiquidations ?? null }, census)
  }, [selected, data, detection, protocols, census])

  const [addressCensus, setAddressCensus] = useState<CensusRow | null>(null)
  useEffect(() => {
    setAddressCensus(null)
    if (mode !== 'address' || !loaded) return
    let alive = true
    fetch(`/api/sim/census/${loaded.address}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { row: CensusRow | null } | null) => alive && setAddressCensus(j?.row ?? null))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [mode, loaded])

  const membraneLine = useMemo(() => (selected ? weightedMembraneLine(selected.collateral).maxLtv : 0), [selected])

  const isDemo = mode === 'demo'
  const shownAddress: `0x${string}` | null = mode === 'address' ? loaded?.address ?? null : mode === 'demo' ? demo.address : null

  // -------------------------------------------------------------- errors
  const readErrors = useMemo<string[]>(() => {
    const out: string[] = []
    if (dataError) out.push(`Measured price path failed to load: ${dataError}`)
    if (mode === 'address' && loaded) {
      for (const r of loaded.results) if (r.status === 'error') out.push(`${r.label} · ${r.message ?? 'read failed'}`)
      if (positions.length === 0) out.push('No open borrow on Aave, Spark, Morpho or Compound.')
    }
    return out
  }, [dataError, mode, loaded, positions])

  // ---------------------------------------------------------- return visit
  const [previous, setPrevious] = useState<VisitRecord | null>(null)
  const [visitState, setVisitState] = useState<VisitState>('first')
  const [delta, setDelta] = useState<VisitDelta | null>(null)
  const visitSettled = useRef(false)

  // URL hydration first, then memory. A shared link always wins over a remembered wallet.
  const hydrated = useRef(false)
  useEffect(() => {
    if (!router.isReady || hydrated.current) return
    hydrated.current = true
    const q = router.query
    const a = Array.isArray(q.a) ? q.a[0] : q.a
    const m = decodeManual(q.m)
    const prev = readVisit()
    setPrevious(prev)
    if (a && a.toLowerCase() === demo.address.toLowerCase()) {
      // A shared demo link reopens the demo. The live wallet was liquidated; reading it
      // today would replay whatever is left, which is not the result that was shared.
    } else if (a) {
      setInput(a)
      void readAddress(a, 'link')
    } else if (m) {
      setManual(m)
      setMode('manual')
    } else if (prev) {
      setInput(prev.address)
      void readAddress(prev.address, 'return')
    }
  }, [router.isReady, router.query, readAddress])

  // Once a real wallet's replay lands: classify, report, remember.
  useEffect(() => {
    if (mode !== 'address' || !loaded || !selected || !comparison) return
    const current = {
      address: loaded.address,
      positionKey: positionKey(selected),
      debtUsd: selected.totalDebtUsd,
      collateralUsd: selected.totalCollateralUsd,
      ltv: selected.ltv,
      lessUsd: closedTotals(comparison).lessUsd,
    }
    if (!visitSettled.current) {
      visitSettled.current = true
      const state = classifyVisit(previous, current)
      setVisitState(state)
      if (previous && state !== 'first' && previous.address.toLowerCase() === current.address.toLowerCase()) {
        // A delta only between the same position (review: store positionKey).
        if (sameKey(previous, current)) setDelta(visitDelta(previous, current, Date.now()))
        track({ name: 'return_visit', headline, state, address: current.address, sinceMs: Date.now() - previous.at })
      }
    }
    writeVisit({ ...current, at: Date.now(), scenarioId })
  }, [mode, loaded, selected, comparison, previous, headline, scenarioId])

  // ------------------------------------------------------- wallet prefill
  // The intent-preserving connect (V20): connecting supplies the address the reader
  // would have pasted. Only while nothing has been typed or read.
  const { address: walletAddress } = useWallet()
  const prefilled = useRef<string | null>(null)
  useEffect(() => {
    if (!walletAddress || isLoading || !hydrated.current) return
    if (input !== '' || mode !== 'demo') return
    if (prefilled.current === walletAddress) return
    prefilled.current = walletAddress
    setInput(walletAddress)
    void readAddress(walletAddress, 'wallet')
  }, [walletAddress, input, mode, isLoading, readAddress])

  // ------------------------------------------------------------- handlers
  const submitAddress = useCallback(() => {
    visitSettled.current = false
    void readAddress(input, 'paste')
  }, [input, readAddress])

  const submitManual = useCallback(
    (m: ManualInput) => {
      setManual(m)
      setMode('manual')
      setSelectedKey(null)
      track({ name: 'wallet_run', headline, source: 'manual', scenarioId, protocols: [m.venue] })
    },
    [headline, scenarioId],
  )

  const backToDemo = useCallback(() => {
    setMode('demo')
    setLoaded(null)
    setManual(null)
    setInput('')
    setAddressError(null)
    setSelectedKey(null)
  }, [])

  /** The link that reproduces what is on screen. */
  const shareQuery = useMemo(() => {
    const q = new URLSearchParams()
    if (mode === 'address' && loaded) q.set('a', loaded.address)
    else if (mode === 'manual' && manual) q.set('m', encodeManual(manual))
    else q.set('a', demo.address)
    q.set('s', scenarioId)
    return `?${q.toString()}`
  }, [mode, loaded, manual, scenarioId])

  return {
    scenario,
    scenarioId,
    setScenarioId,
    data,
    protocols,
    mode,
    isDemo,
    input,
    setInput,
    isLoading,
    addressError,
    submitAddress,
    backToDemo,
    manual,
    manualError,
    submitManual,
    positions,
    selected,
    selectKey: setSelectedKey,
    comparison,
    detection,
    census,
    addressCensus,
    membraneLine,
    shownAddress,
    loadedSource: loaded?.source ?? null,
    readErrors,
    visitState,
    previous,
    delta,
    shareQuery,
  }
}

export type ReplayState = ReturnType<typeof useReplay>
