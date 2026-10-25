// THE CLIENT HALF OF THE PAGE: the chart and the forecast layer. Loaded behind dynamic()
// so the price path, the forecast engine and its ~1 MB hourly series stay out of the
// first-load bundle (SEO R12). The series are fetched at runtime from
// public/data/forecast, extended with the live Binance tail, and stamped.

import React, { useEffect, useMemo, useState } from 'react'
import { Box } from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'
import { loadSeries, type ForecastSymbol, type PriceSeries } from '@/lib/forecast'
import { CURE_WINDOW_SECONDS, type Comparison, type ProtocolPosition } from '@/lib/position-sim'
import type { HistoryEpisode } from '@/lib/position-sim/history'
import { anchorAsset, delayReadings, forwardReach, historyReadings, seriesIdFor, type Slot } from '@/lib/landing/forecastLayer'
import type { UsdeExitLiquidity } from '@/lib/landing/sizeSkew'
import { armedWindows } from '@/lib/landing/verdict'

import ForecastPanel from './ForecastPanel'
import ReplayChart from './ReplayChart'

export interface ReplayDeskProps {
  comparison: Comparison | null
  startTs: number | null
  stepSeconds: number | null
  whose: 'this' | 'your'
  positions: ProtocolPosition[]
  selected: ProtocolPosition | null
  onSelect: (key: string) => void
  usdeExit: UsdeExitLiquidity | null
  sizeFirst: boolean
  errors: string[]
  scenarioName: string
  /** The address's own liquidation episodes, or null while loading / for a hand-entered position. */
  episodes: HistoryEpisode[] | null
  historyNote: string
}

type SeriesState = { series: PriceSeries; stamp: string } | { error: string }

export const ReplayDesk: React.FC<ReplayDeskProps> = (p) => {
  // ------------------------------------------------------------ the series
  const wanted = useMemo(() => {
    const ids = new Set<string>()
    const a = p.selected ? anchorAsset(p.selected) : null
    const id = a ? seriesIdFor(a) : null
    if (id) ids.add(id)
    for (const ep of p.episodes ?? []) {
      const e = seriesIdFor(ep.collateral)
      if (e) ids.add(e)
    }
    return Array.from(ids).sort()
  }, [p.selected, p.episodes])

  const [loaded, setLoaded] = useState<Record<string, SeriesState>>({})
  useEffect(() => {
    let alive = true
    for (const id of wanted) {
      if (loaded[id]) continue
      loadSeries(id as ForecastSymbol, { live: true })
        .then(({ series, stamp }) => {
          if (!alive) return
          const at = stamp.fetchedAt ? ` · fetched ${new Date(stamp.fetchedAt).toISOString().slice(11, 16)}Z` : ` · through ${stamp.through}`
          setLoaded((m) => ({ ...m, [id]: { series, stamp: `${stamp.source}${at}` } }))
        })
        .catch((e: Error) => alive && setLoaded((m) => ({ ...m, [id]: { error: e.message } })))
    }
    return () => {
      alive = false
    }
  }, [wanted, loaded])

  const seriesFor = (symbol: string): PriceSeries | null => {
    const id = seriesIdFor(symbol)
    const s = id ? loaded[id] : undefined
    return s && 'series' in s ? s.series : null
  }
  const loadingFor = (symbol: string): boolean => {
    const id = seriesIdFor(symbol)
    return id !== null && !loaded[id]
  }

  // ----------------------------------------------------------- the slots
  const anchor = p.selected ? anchorAsset(p.selected) : null
  const anchorSeries = anchor ? seriesFor(anchor) : null
  const anchorLoading = anchor ? loadingFor(anchor) : false

  const windows = useMemo(
    () =>
      p.comparison && p.stepSeconds
        ? armedWindows(p.comparison, p.comparison.membrane.equitySeries.length, Math.round(CURE_WINDOW_SECONDS / p.stepSeconds))
        : [],
    [p.comparison, p.stepSeconds],
  )
  const loadingSlot = { status: 'pending' as const, reason: 'loading the hourly price history' }
  const delay = useMemo<Slot<ReturnType<typeof delayReadings> extends Slot<infer T> ? T : never> | null>(() => {
    if (!p.comparison || p.startTs === null || !p.stepSeconds) return null
    if (anchorLoading) return loadingSlot
    return delayReadings(p.comparison, windows, p.startTs, p.stepSeconds, anchorSeries)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.comparison, windows, p.startTs, p.stepSeconds, anchorSeries, anchorLoading])

  const history = useMemo(() => {
    if (p.episodes === null) return { status: 'pending' as const, reason: p.historyNote }
    if ((p.episodes ?? []).some((e) => loadingFor(e.collateral))) return loadingSlot
    return historyReadings(p.episodes, seriesFor)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.episodes, p.historyNote, loaded])

  const reachSlot = useMemo(() => {
    if (!p.selected) return { status: 'pending' as const, reason: 'no position' }
    if (anchorLoading) return loadingSlot
    return forwardReach(p.selected, Math.floor(Date.now() / 1000), anchorSeries)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.selected, anchorSeries, anchorLoading])

  const stamp = useMemo(() => {
    const s = Object.values(loaded).find((x): x is { series: PriceSeries; stamp: string } => 'series' in x)
    return s?.stamp ?? null
  }, [loaded])

  return (
    <Box display="grid" gap={SPACING.lg} minW={0}>
      <ReplayChart
        comparison={p.comparison}
        startTs={p.startTs}
        stepSeconds={p.stepSeconds}
        whose={p.whose}
        positions={p.positions}
        selected={p.selected}
        onSelect={p.onSelect}
        usdeExit={p.usdeExit}
        sizeFirst={p.sizeFirst}
        delay={delay}
        errors={p.errors}
        scenarioName={p.scenarioName}
      />
      {delay && <ForecastPanel delay={delay} history={history} reach={reachSlot} stamp={stamp} />}
    </Box>
  )
}

export default ReplayDesk
