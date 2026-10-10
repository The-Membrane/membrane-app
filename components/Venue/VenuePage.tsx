import React, { useState } from 'react'
import { Box, Grid, HStack, Input, Text } from '@chakra-ui/react'
import { useQuery } from '@tanstack/react-query'
import NextLink from 'next/link'

import { Card } from '@/components/ui/Card'
import {
  TRANSACTION_CLASSES,
  type DriverResult,
  type TransactionClass,
} from '@/components/Venue/capacityDriverLogic'
import { CapacityCurve } from '@/components/Venue/CapacityCurve'
import { FlowImpactCard, type ObservedCapacitySignal } from '@/components/Venue/FlowImpactCard'
import {
  isRecentObservedEvent,
  isRecentPublishedNews,
  newsFetchedAtLabel,
  selectObservedCapacitySignal,
  type NewsStorage,
  type ValidatedRouteFlowOutlook,
} from '@/components/Venue/flowImpactCardLogic'
import type { HistoricalInventoryEvidence } from '@/components/Venue/historicalInventoryScenarioLogic'
import { fmtUsd } from '@/components/Radar/radarLogic'
import {
  Entry,
  consequence,
  alarmConsequence,
  fmtDuration,
  isTermsOnlyNotice,
  termsSourceUrl,
} from '@/components/Carry/venueLogLogic'
import { Eyebrow, SectionHeading, Stamp } from '@/components/Carry/atoms'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { useChainRoute } from '@/hooks/useChainRoute'
import type { VenueMeasuredPersistenceResult } from '@/pages/api/_lib/venueForecastReads'

/**
 * VenuePage — the /venue/[name] permalink. Every headline about a carry venue
 * becomes our distribution moment: one URL assembling the venue's recorded state,
 * its verified exit history, the open flags AND the blind spots, what changed, and
 * what's being said. All corpus-driven, numbers-first, no prose explanations.
 *
 * Data: /api/venues/[venue]/summary (state + coverage + alarms),
 * /api/venues/log (filtered to this venue client-side) and /api/venues/news?venue=.
 * Every fetch overrides the app-wide refetchOnMount:false default so an empty
 * first fetch cannot stick for the session.
 */

// Mirror of pages/api/venues/[venue]/summary.ts VenueSummary (kept local so this
// client component never imports the server route). Keep in lockstep.
type DepthMarket = {
  name?: string
  kind?: string
  exitableUsd?: number
  skewPct?: number | null
}
type VenueSummary = {
  venue: string
  label: string
  kind: string
  observed: {
    block: number
    observedAt: string
    sourceAt?: string
    fetchedAt?: string
    firstLocalReceiptAt?: string
    instantUsd: number | null
    params: {
      totalAssets: string | null
      cooldownDuration: number | null
      utilizationPct: number | null
      depthUsd: number | null
      depthSkewPct: number | null
      depthMarkets: DepthMarket[] | null
    }
  } | null
  suppliedTvl: { usd: number; block: number; observedAt: string } | null
  corpus: {
    snapshots: number
    snapshotsObserved: number
    snapshotSpan: { start: string | null; end: string | null }
    flows: number | null
    flowSpan: { start: string | null; end: string | null }
    news: number | null
    status: 'database' | 'database_unreconciled' | 'local_only'
  }
  worstOutflows: {
    d1: { usd: number; date: string } | null
    d7: { usd: number; date: string } | null
  }
  alarms: {
    open: Array<{
      kind: string
      severity: 'watch' | 'alarm' | 'notice'
      evidence: Record<string, unknown> | null
      firedAt: string
    }>
    uncovered: Array<{ id: string; label: string; memo: string }>
    status: 'available' | 'database_unreconciled' | 'unknown'
  }
  provenance: {
    storage: 'database' | 'local_mac_recorder'
    observationStatus: 'fresh' | 'stale' | 'missing' | 'unknown'
    databaseStatus: 'available' | 'available_lagging' | 'unavailable'
    sourceAt: string | null
    fetchedAt: string | null
    firstLocalReceiptAt: string | null
  }
}

type VenueForecastResponse = {
  measuredPersistence?: VenueMeasuredPersistenceResult
  storage: 'database' | 'local_mac_recorder'
  route: { label: string; kind: string; limit: string; metric: 'instant_usd' | 'depth_usd' }
  latest: { block: number; observedAt: string; capacityUsd: number | null; coverage: string } | null
  coverage: {
    observedRows: number
    flowStatus: string
    flowReason: string
    maxGrossOutflowUsd: number | null
    maxNetOutflowUsd: number | null
  }
  forecast: {
    status: 'research_projection' | 'abstain'
    reason: string | null
    current: { capacityUsd: number; observedAt: string } | null
    projection: {
      targetAt: string
      bandLowUsd: number
      bandHighUsd: number
      relativeToAmount: 'below' | 'at_or_above' | 'uncertain'
    } | null
    sourceSpan: { completeSnapshots: number; incompleteSnapshots: number }
    backtest: {
      holdout: {
        eligible: number
        bandCoverage: number | null
        belowAmountEvents: number
        atOrAboveAmountControls: number
      }
    }
    duration: {
      observedEpisodes: number
      completed: number
      leftCensored: number
      rightCensored: number
      gapCensored: number
      maxCompletedObservedSpanHours: number | null
      durationForecast: { status: 'unavailable' }
    }
  }
  impactForecast?: ValidatedRouteFlowOutlook | { status: 'unavailable' }
}

type CapacityChangeSignal = {
  items: Array<{
    venue: string
    metric: 'instantUsd' | 'depthUsd'
    signal: ObservedCapacitySignal
  }>
}

type NewsItem = {
  venue: string
  title: string
  source: string
  url: string
  publishedAt: string | null
  fetchedAt: string
}

type NewsResponse = {
  items: NewsItem[]
  provenance: { storage: NewsStorage }
}

const newsTimeUtc = (iso: string | null | undefined): string => {
  if (!iso) return 'unavailable'
  const timestamp = new Date(iso)
  return Number.isNaN(timestamp.getTime())
    ? 'unavailable'
    : `${timestamp.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

const day = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toISOString().slice(0, 10) : '—'
const todayIso = () => new Date().toISOString().slice(0, 10)
const fmtCapacityUsd = (value: number): string => {
  const amount = Math.abs(value)
  if (amount >= 1e9) return `$${(amount / 1e9).toFixed(2)}B`
  if (amount >= 1e6) return `$${(amount / 1e6).toFixed(2)}M`
  if (amount >= 1e3) return `$${(amount / 1e3).toFixed(2)}k`
  return `$${amount.toFixed(2)}`
}
const signedUsd = (value: number): string =>
  `${value > 0 ? '+' : value < 0 ? '−' : ''}${fmtCapacityUsd(value)}`
const smallPercent = (value: number): string =>
  value > 0 && value < 0.01 ? '<0.01%' : `${value.toFixed(2)}%`
const transactionClassLabel: Record<TransactionClass, string> = {
  swap: 'Swap transactions',
  lp_add: 'Liquidity added',
  lp_remove: 'Liquidity removed',
  mixed: 'Mixed-event transactions',
  direct_or_other: 'Direct / other transfers',
}
const observedTime = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
const tvlAge = (observedAt: string, now = Date.now()) => {
  const ageMs = Math.max(0, now - new Date(observedAt).getTime())
  const hours = Math.floor(ageMs / (60 * 60 * 1000))
  return { label: hours < 1 ? '<1h old' : `${hours}h old`, stale: ageMs > 36 * 60 * 60 * 1000 }
}

// --- small building blocks -------------------------------------------------

const Stat: React.FC<{
  label: string
  value: React.ReactNode
  sub?: React.ReactNode
  tone?: string
}> = ({ label, value, sub, tone }) => (
  <Card variant="default" p={SPACING.base}>
    <Eyebrow>{label}</Eyebrow>
    <Text
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize={TYPOGRAPHY.h3}
      fontWeight={TYPOGRAPHY.medium}
      color={tone ?? SEMANTIC_COLORS.textPrimary}
      mt={SPACING.xs}
    >
      {value}
    </Text>
    {sub && (
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="10px"
        color={SEMANTIC_COLORS.textTertiary}
        mt={SPACING.xs}
      >
        {sub}
      </Text>
    )}
  </Card>
)

const ProvFooter: React.FC<{ date: string; local?: boolean }> = ({ date, local = false }) =>
  local ? null : <Stamp>carry radar · recorded corpus · {date}</Stamp>

export const MeasuredPersistenceMetrics: React.FC<{
  value: VenueMeasuredPersistenceResult | undefined
}> = ({ value }) => {
  if (!value) return null
  const span = (hours: number | undefined) =>
    hours != null && Number.isFinite(hours) && hours >= 0 ? `${hours.toFixed(2)}h` : '—'
  const current =
    value.status === 'measured_history' && value.unavailableReason === null
      ? value.currentStatus === 'at_or_above'
        ? span(value.currentRun?.sampledSpanHours)
        : value.currentStatus === 'below'
          ? 'Below Q'
          : '—'
      : '—'
  const fraction =
    value.sampleShare.complete > 0 && value.sampleShare.fraction !== null
      ? `${value.sampleShare.atOrAboveQ.toLocaleString('en-US')} / ${value.sampleShare.complete.toLocaleString('en-US')} · ${(value.sampleShare.fraction * 100).toFixed(1)}%`
      : '—'
  const metrics = [
    {
      label: 'Current ≥ Q · sampled',
      value: current,
      color: current === 'Below Q' ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.textPrimary,
      detail: `First-to-last above-Q sample span as of ${value.asOf}. The current run is right censored; capacity between samples is unknown.`,
    },
    {
      label: 'Longest completed · sampled',
      value: span(value.longestCompletedRun?.sampledSpanHours),
      detail:
        'Longest historical sampled run with observed start and end crossings bracketed by complete samples. Capacity between samples is unknown.',
    },
    {
      label: '≥ Q / complete samples',
      value: fraction,
      detail: `${value.coverage.completeExpectedSamples} complete / ${value.coverage.expectedSamples} expected cadence slots; ${value.coverage.missingExpectedSamples} missing. This is an observed sample fraction.`,
    },
  ]
  return (
    <Box
      mt={SPACING.md}
      pt={SPACING.md}
      borderTop="1px solid"
      borderColor={SEMANTIC_COLORS.hairline}
    >
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.xs}
        color={SEMANTIC_COLORS.textSecondary}
      >
        Historical samples
        {value.source === 'recorded_cost_curve' && value.costCapPct != null
          ? ` · ${value.costCapPct}% cost cap${value.costCapSelection === 'default_recorded_level' ? ' (default)' : ''}`
          : ''}
      </Text>
      <Grid
        role="group"
        aria-label="Measured historical persistence"
        templateColumns={{ base: '1fr', md: 'repeat(3, minmax(0, 1fr))' }}
        gap={SPACING.md}
        mt={SPACING.sm}
      >
        {metrics.map((metric) => (
          <Box key={metric.label} minW={0} title={metric.detail}>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.label}
              textTransform="uppercase"
              letterSpacing="0.28em"
              color={SEMANTIC_COLORS.textSecondary}
            >
              {metric.label}
            </Text>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.small}
              color={metric.color ?? SEMANTIC_COLORS.textPrimary}
              mt={SPACING.xs}
            >
              {metric.value}
            </Text>
          </Box>
        ))}
      </Grid>
    </Box>
  )
}

export const parseExitQuestionInputs = (amountInput: string, horizonInput: string) => {
  const amount = Number(amountInput)
  const hours = Number(horizonInput)
  return {
    amountUsd: amountInput.trim() && Number.isFinite(amount) && amount > 0 ? amount : null,
    horizonHours:
      horizonInput.trim() && Number.isInteger(hours) && hours >= 1 && hours <= 720 ? hours : null,
  }
}

// --- the page --------------------------------------------------------------

export const VenuePage: React.FC<{ venue: string }> = ({ venue }) => {
  const { chainName } = useChainRoute()
  const [exitAmountInput, setExitAmountInput] = useState('10000')
  const [horizonHoursInput, setHorizonHoursInput] = useState('24')
  const { amountUsd: selectedExitUsd, horizonHours: selectedHorizonHours } =
    parseExitQuestionInputs(exitAmountInput, horizonHoursInput)
  const {
    data: forecastData,
    isLoading: forecastLoading,
    isError: forecastError,
  } = useQuery<VenueForecastResponse>({
    queryKey: ['venue_forecast', venue, selectedExitUsd, selectedHorizonHours],
    enabled: selectedExitUsd != null && selectedHorizonHours != null,
    queryFn: async () => {
      const params = new URLSearchParams({
        amountUsd: String(selectedExitUsd),
        horizonHours: String(selectedHorizonHours),
      })
      const response = await fetch(`/api/venues/${encodeURIComponent(venue)}/forecast?${params}`)
      if (!response.ok) throw new Error(`venue forecast ${response.status}`)
      return response.json()
    },
    staleTime: 1000 * 60,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
  })

  const { data: changeData } = useQuery<CapacityChangeSignal>({
    queryKey: ['venue_capacity_change', venue],
    enabled: process.env.NODE_ENV === 'development',
    queryFn: async () => {
      const response = await fetch(`/api/venues/capacity-change?venue=${encodeURIComponent(venue)}`)
      if (!response.ok) throw new Error(`capacity change ${response.status}`)
      return response.json()
    },
    staleTime: 1000 * 60 * 5,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    refetchInterval: 1000 * 60 * 5,
  })
  const measuredChangeItem = changeData?.items.find((item) => item.venue === venue)

  const { data: historicalEvidence } = useQuery<HistoricalInventoryEvidence>({
    queryKey: ['venue_historical_inventory_scenario', venue],
    enabled:
      process.env.NODE_ENV === 'development' &&
      ['sUSDe', 'aave-v3-usde', 'sGHO', 'sUSDS', 'scrvUSD'].includes(venue),
    queryFn: async () => {
      const response = await fetch(
        `/api/venues/historical-inventory-scenario?venue=${encodeURIComponent(venue)}`,
      )
      if (!response.ok) throw new Error(`historical inventory scenario ${response.status}`)
      return response.json()
    },
    staleTime: 1000 * 60 * 60,
    refetchOnMount: true,
  })

  const {
    data: summary,
    isError: summaryError,
    isLoading: summaryLoading,
  } = useQuery<VenueSummary>({
    queryKey: ['venue_summary', venue],
    queryFn: async () => {
      const r = await fetch(`/api/venues/${venue}/summary`)
      if (!r.ok) throw new Error(`venue summary ${r.status}`)
      return r.json()
    },
    staleTime: 1000 * 60 * 5,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    refetchInterval: 1000 * 60 * 5,
  })

  const { data: logData, isLoading: logLoading } = useQuery<{ entries: Entry[] }>({
    queryKey: ['venue_log', venue],
    queryFn: async () => {
      const r = await fetch(`/api/venues/log?venue=${encodeURIComponent(venue)}`)
      if (!r.ok) throw new Error(`venue log ${r.status}`)
      return r.json()
    },
    staleTime: 1000 * 60 * 5,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    refetchInterval: 1000 * 60 * 5,
  })

  const { data: newsData, isLoading: newsLoading } = useQuery<NewsResponse>({
    queryKey: ['venue_news', venue],
    queryFn: async () => {
      const r = await fetch(`/api/venues/news?venue=${encodeURIComponent(venue)}`)
      if (!r.ok) throw new Error(`venue news ${r.status}`)
      return r.json()
    },
    staleTime: 1000 * 60 * 15,
    refetchOnMount: true,
  })

  const {
    data: driverData,
    isLoading: driversLoading,
    isError: driversError,
  } = useQuery<DriverResult>({
    queryKey: ['venue_capacity_drivers', venue],
    queryFn: async () => {
      const r = await fetch(`/api/venues/${encodeURIComponent(venue)}/drivers`, {
        cache: 'no-store',
      })
      if (!r.ok) throw new Error(`venue drivers ${r.status}`)
      return r.json()
    },
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    refetchInterval: 60_000,
  })

  const label = summary?.label ?? venue
  const obs = summary?.observed ?? null
  const p = obs?.params
  const localProvenance =
    summary?.provenance.storage === 'local_mac_recorder' ? summary.provenance : null
  const corpusDate =
    day(
      localProvenance ? obs?.observedAt : (summary?.corpus.snapshotSpan.end ?? obs?.observedAt),
    ) || todayIso()

  // Aave supplied stock has its own last-valid source block/time. It need not
  // share the latest immediate-cash block after an independent read failure.
  const totalAssetsUsd = p?.totalAssets != null ? Number(p.totalAssets) / 1e18 : null
  const aaveTvl = summary?.kind === 'atoken-liquidity' ? summary.suppliedTvl : null
  const aaveTvlAge = aaveTvl ? tvlAge(aaveTvl.observedAt) : null
  const tvlUsd = summary?.kind === 'atoken-liquidity' ? (aaveTvl?.usd ?? null) : totalAssetsUsd
  // Aave's instant read is aggregate reserve cash, not a holder-specific
  // withdrawal quote. Other venues expose secondary-market exit depth.
  const instantIsProtocol = obs?.instantUsd != null
  const instantLiquidityUsd = instantIsProtocol ? obs!.instantUsd : (p?.depthUsd ?? null)

  const logEntries = (logData?.entries ?? []).filter((e) => e.venue === venue)
  const newsItems = newsData?.items ?? []
  const recentNews = newsItems.find((item) => isRecentPublishedNews(item.publishedAt))
  const observedChange = selectObservedCapacitySignal(
    measuredChangeItem,
    logData?.entries,
    venue,
    summary?.observed,
  )
  const latestEvent = logEntries
    .filter(
      (entry) =>
        entry.provenance === 'observed' &&
        !entry.cleared &&
        !isTermsOnlyNotice(entry) &&
        isRecentObservedEvent(entry.at) &&
        ['gate_change', 'cooldown_duration_changed', 'param_changed'].includes(entry.kind),
    )
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]
  const openAlarms = summary?.alarms.open ?? []
  const uncovered = summary?.alarms.uncovered ?? []

  const NextRow: React.FC = () => (
    <Card variant="default" p={SPACING.base} mt={SPACING.lg}>
      <Eyebrow>next</Eyebrow>
      <HStack spacing={SPACING.lg} flexWrap="wrap" mt={SPACING.sm}>
        <NextLink href={`/${chainName}/radar`} style={{ textDecoration: 'underline' }}>
          <Text
            as="span"
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.small}
            color={SEMANTIC_COLORS.textSecondary}
            _hover={{ color: SEMANTIC_COLORS.success }}
          >
            stress your size → /radar
          </Text>
        </NextLink>
        <NextLink href={`/${chainName}/carry`} style={{ textDecoration: 'underline' }}>
          <Text
            as="span"
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.small}
            color={SEMANTIC_COLORS.textSecondary}
            _hover={{ color: SEMANTIC_COLORS.success }}
          >
            the board → /carry
          </Text>
        </NextLink>
        <NextLink href={`/${chainName}/simulator`} style={{ textDecoration: 'underline' }}>
          <Text
            as="span"
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.small}
            color={SEMANTIC_COLORS.success}
          >
            Run this on your wallet →
          </Text>
        </NextLink>
      </HStack>
      <Stamp>Data compiled by Membrane.</Stamp>
    </Card>
  )

  return (
    <Box
      maxW="1140px"
      mx="auto"
      px={SPACING.base}
      py={SPACING.lg}
      bg={SEMANTIC_COLORS.bgPrimary}
      color={SEMANTIC_COLORS.textPrimary}
    >
      {/* header */}
      <Eyebrow>venue permalink · exit capacity, recorded</Eyebrow>
      <HStack align="baseline" spacing={SPACING.md} flexWrap="wrap" mt={SPACING.sm}>
        <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize={TYPOGRAPHY.h1} letterSpacing="-0.01em">
          {label}
        </Text>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.label}
          color={SEMANTIC_COLORS.textTertiary}
          textTransform="uppercase"
          letterSpacing="0.14em"
        >
          {summary?.kind ?? ''}
        </Text>
      </HStack>
      <ProvFooter date={corpusDate} local={Boolean(localProvenance)} />
      {localProvenance && (
        <Stamp>
          Local · {localProvenance.observationStatus} · {newsTimeUtc(localProvenance.sourceAt)}
        </Stamp>
      )}

      {/* 01 / the state */}
      <SectionHeading
        index="01 /"
        title="The state"
        note={
          summary?.kind === 'atoken-liquidity'
            ? 'latest exit reading · TVL has its own timestamp'
            : 'latest observed on-chain reading'
        }
      />
      {obs ? (
        <>
          <Grid
            templateColumns={{ base: '1fr', sm: '1fr 1fr', lg: 'repeat(4, 1fr)' }}
            gap={SPACING.base}
          >
            <Stat
              label="gate"
              value={
                p?.cooldownDuration == null
                  ? 'unavailable'
                  : p.cooldownDuration > 0
                    ? `${fmtDuration(p.cooldownDuration)} cooldown`
                    : 'no cooldown'
              }
              sub={`block ${obs.block.toLocaleString()}`}
            />
            <Stat
              label="TVL"
              value={tvlUsd != null ? fmtUsd(tvlUsd) : '—'}
              sub={
                <>
                  {summary?.kind === 'atoken-liquidity'
                    ? 'aToken supplied stock · approx. $1/stable'
                    : 'total assets · approx. $1/stable'}
                  {aaveTvl ? (
                    <>
                      {' · recorded '}
                      {observedTime(aaveTvl.observedAt)}
                      {' · block '}
                      {aaveTvl.block.toLocaleString()}
                      {' · '}
                      {aaveTvlAge?.label}
                      {aaveTvlAge?.stale ? ' · Stale' : ''}
                    </>
                  ) : summary?.kind === 'atoken-liquidity' ? (
                    ' · no verified supply reading'
                  ) : (
                    <>
                      {' · recorded '}
                      {observedTime(obs.observedAt)}
                    </>
                  )}
                </>
              }
            />
            <Stat
              label={instantIsProtocol ? 'reserve cash' : 'instant-exit depth'}
              value={instantLiquidityUsd != null ? fmtUsd(instantLiquidityUsd) : 'not derivable'}
              sub={
                instantIsProtocol
                  ? 'aggregate pool inventory · holder withdrawal unverified'
                  : 'secondary-market swap-into side'
              }
            />
            {p?.utilizationPct != null ? (
              <Stat
                label="utilization"
                value={`${p.utilizationPct.toFixed(1)}%`}
                sub="debt / (debt + available)"
                tone={p.utilizationPct > 90 ? SEMANTIC_COLORS.danger : undefined}
              />
            ) : p?.depthSkewPct != null ? (
              <Stat
                label="depth skew"
                value={`${p.depthSkewPct.toFixed(1)}%`}
                sub="worst pool one-sidedness"
                tone={p.depthSkewPct > 80 ? SEMANTIC_COLORS.warning : undefined}
              />
            ) : (
              <Stat label="depth skew" value="—" sub="single-sided buffer · no skew" />
            )}
          </Grid>

          {/* per-market depth breakdown */}
          {p?.depthMarkets && p.depthMarkets.length > 0 && (
            <Card variant="default" p={SPACING.base} mt={SPACING.base}>
              <Eyebrow>instant-exit tier · per-market depth</Eyebrow>
              <Box mt={SPACING.sm}>
                {p.depthMarkets.map((m, i) => (
                  <Grid
                    key={m.name ?? i}
                    templateColumns={{ base: '1fr', md: '1fr 110px 110px' }}
                    gap={SPACING.base}
                    py={SPACING.sm}
                    borderBottom={i === p.depthMarkets!.length - 1 ? 'none' : '1px solid'}
                    borderColor={SEMANTIC_COLORS.borderSubtle}
                    alignItems="baseline"
                  >
                    <Text
                      fontFamily={TYPOGRAPHY.fontMono}
                      fontSize="11px"
                      color={SEMANTIC_COLORS.textSecondary}
                    >
                      {m.name ?? m.kind ?? 'market'}
                    </Text>
                    <Text
                      fontFamily={TYPOGRAPHY.fontMono}
                      fontSize="11.5px"
                      color={SEMANTIC_COLORS.textPrimary}
                      textAlign={{ base: 'left', md: 'right' }}
                    >
                      {m.exitableUsd != null ? fmtUsd(m.exitableUsd) : '—'}
                    </Text>
                    <Text
                      fontFamily={TYPOGRAPHY.fontMono}
                      fontSize="10px"
                      color={SEMANTIC_COLORS.textTertiary}
                      textAlign={{ base: 'left', md: 'right' }}
                    >
                      {m.skewPct != null ? `${m.skewPct.toFixed(0)}% skew` : 'no skew'}
                    </Text>
                  </Grid>
                ))}
              </Box>
              <Stamp>Instant swap depth · protocol redemption is separate</Stamp>
            </Card>
          )}
          <ProvFooter date={day(obs.observedAt)} local={Boolean(localProvenance)} />
        </>
      ) : (
        <Card variant="default" p={SPACING.base}>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="11.5px"
            color={SEMANTIC_COLORS.textSecondary}
          >
            {summaryLoading
              ? 'Reading snapshot…'
              : summaryError
                ? 'Snapshot availability unknown.'
                : 'No observed snapshot yet for this venue.'}
          </Text>
        </Card>
      )}

      {/* 01b / swap-out capacity — what exits within a cost, fees included (on-chain quotes) */}
      <SectionHeading index="01b /" title="Swap-out capacity" note="Live quotes · fees included" />
      <Card variant="default" p={SPACING.base} mt={SPACING.base}>
        <Eyebrow>Exit scenario</Eyebrow>
        <Grid templateColumns={{ base: '1fr', sm: '1fr 1fr' }} gap={SPACING.base} mt={SPACING.md}>
          <Box>
            <Text
              as="label"
              htmlFor={`exit-size-${venue}`}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.label}
              color={SEMANTIC_COLORS.textSecondary}
            >
              Exit amount (USD)
            </Text>
            <Input
              id={`exit-size-${venue}`}
              type="number"
              inputMode="decimal"
              min={1}
              step="any"
              value={exitAmountInput}
              onChange={(event) => setExitAmountInput(event.target.value)}
              borderRadius={0}
              borderColor={SEMANTIC_COLORS.borderStrong}
              fontFamily={TYPOGRAPHY.fontMono}
              mt={SPACING.xs}
              _focus={FOCUS_STYLES.ring}
              aria-describedby={`exit-question-status-${venue}`}
            />
          </Box>
          <Box>
            <Text
              as="label"
              htmlFor={`exit-horizon-${venue}`}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.label}
              color={SEMANTIC_COLORS.textSecondary}
            >
              Future horizon (hours · 1h–30d)
            </Text>
            <Input
              id={`exit-horizon-${venue}`}
              type="number"
              inputMode="numeric"
              min={1}
              max={720}
              step={1}
              value={horizonHoursInput}
              onChange={(event) => setHorizonHoursInput(event.target.value)}
              borderRadius={0}
              borderColor={SEMANTIC_COLORS.borderStrong}
              fontFamily={TYPOGRAPHY.fontMono}
              mt={SPACING.xs}
              _focus={FOCUS_STYLES.ring}
              aria-describedby={`exit-question-status-${venue}`}
            />
          </Box>
        </Grid>
        <Text
          id={`exit-question-status-${venue}`}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
          color={SEMANTIC_COLORS.warning}
          mt={SPACING.md}
        >
          {selectedExitUsd == null || selectedHorizonHours == null
            ? 'Enter an amount and horizon.'
            : forecastLoading
              ? 'Reading evidence…'
              : forecastError || !forecastData
                ? 'Evidence unavailable'
                : 'Future exit · unvalidated'}
        </Text>
        {forecastData && selectedExitUsd != null && selectedHorizonHours != null && (
          <Box mt={SPACING.sm}>
            {forecastData.forecast.status === 'research_projection' &&
              forecastData.forecast.projection && (
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.xs}
                  color={SEMANTIC_COLORS.textSecondary}
                >
                  {forecastData.route.metric === 'depth_usd'
                    ? 'Exit inventory proxy'
                    : 'Market cash proxy'}{' '}
                  · {fmtUsd(forecastData.forecast.projection.bandLowUsd)}–
                  {fmtUsd(forecastData.forecast.projection.bandHighUsd)} ·{' '}
                  {newsTimeUtc(forecastData.forecast.projection.targetAt)}
                </Text>
              )}
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textSecondary}
              mt={SPACING.xs}
            >
              {forecastData.route.label} ·{' '}
              {forecastData.latest?.capacityUsd == null
                ? 'unavailable'
                : fmtUsd(forecastData.latest.capacityUsd)}{' '}
              · B{forecastData.latest?.block?.toLocaleString() ?? 'unknown'} ·{' '}
              {newsTimeUtc(forecastData.latest?.observedAt)} ·{' '}
              {forecastData.latest?.coverage ?? 'unverified'} ·{' '}
              {forecastData.storage === 'local_mac_recorder' ? 'local Mac' : 'database'}
            </Text>
            <MeasuredPersistenceMetrics value={forecastData.measuredPersistence} />
          </Box>
        )}
        <Box
          mt={SPACING.md}
          borderTop="1px solid"
          borderColor={SEMANTIC_COLORS.borderSubtle}
          pt={SPACING.md}
        >
          {!forecastData && (
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textSecondary}
            >
              {summary?.kind === 'atoken-liquidity'
                ? 'Aggregate reserve cash proxy'
                : summary?.kind === 'erc4626-vault-cash'
                  ? 'Aggregate vault cash proxy'
                  : 'Recorded instant capacity proxy'}{' '}
              · {instantLiquidityUsd != null ? fmtUsd(instantLiquidityUsd) : 'unavailable'} ·{' '}
              {obs
                ? `source block ${obs.block.toLocaleString()} · recorded ${newsTimeUtc(obs.observedAt)}`
                : 'source unavailable'}{' '}
              · aggregate only
            </Text>
          )}
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textSecondary}
            mt={SPACING.xs}
          >
            24h max flow ·{' '}
            {forecastData?.coverage.maxGrossOutflowUsd == null
              ? `unavailable (${forecastData?.coverage.flowReason ?? 'loading coverage'})`
              : `${fmtUsd(forecastData.coverage.maxGrossOutflowUsd)} gross / ${forecastData.coverage.maxNetOutflowUsd == null ? 'unavailable' : fmtUsd(forecastData.coverage.maxNetOutflowUsd)} net`}
          </Text>
        </Box>
      </Card>
      <FlowImpactCard
        venue={label}
        venueKey={venue}
        capacityMetric={observedChange.metric}
        amountUsd={selectedExitUsd}
        horizonHours={selectedHorizonHours}
        capacity={observedChange.signal}
        news={recentNews ? { ...recentNews, storage: newsData?.provenance?.storage } : null}
        event={
          latestEvent ? { label: latestEvent.kind.replaceAll('_', ' '), at: latestEvent.at } : null
        }
        outlook={
          forecastData?.impactForecast?.status === 'validated' ? forecastData.impactForecast : null
        }
        historicalScenario={
          historicalEvidence?.status === 'historical_scenario' ? historicalEvidence : null
        }
        historicalCoverage={
          historicalEvidence?.status === 'insufficient_history' ? historicalEvidence : null
        }
      />
      <CapacityCurve venue={venue} sizeUsd={selectedExitUsd ?? undefined} />

      {/* 02 / observed capacity driver accounting, never causal attribution */}
      <SectionHeading index="02 /" title="Inventory changes" note="Measured components" />
      <Card variant="default" p={SPACING.base}>
        {driversLoading ? (
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.small}
            color={SEMANTIC_COLORS.textSecondary}
          >
            Reading the last significant observed move…
          </Text>
        ) : driversError || !driverData ? (
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.small}
            color={SEMANTIC_COLORS.textSecondary}
          >
            The capacity-driver record could not be loaded. No cause is inferred.
          </Text>
        ) : driverData.status === 'unavailable' ? (
          <>
            <Eyebrow>breakdown unavailable</Eyebrow>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.small}
              color={SEMANTIC_COLORS.textSecondary}
              mt={SPACING.sm}
            >
              {driverData.message}
            </Text>
          </>
        ) : (
          <>
            <Eyebrow>
              latest significant observed move ·{' '}
              {driverData.metric === 'instant_usd'
                ? 'available USDe stock'
                : 'exit-side pool inventory'}
            </Eyebrow>
            <Grid
              templateColumns={{ base: '1fr', md: 'auto 1fr' }}
              gap={SPACING.lg}
              alignItems="baseline"
              mt={SPACING.sm}
            >
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.h2}
                fontWeight={TYPOGRAPHY.semibold}
                color={driverData.deltaUsd >= 0 ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.danger}
              >
                {signedUsd(driverData.deltaUsd)}
              </Text>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.small}
                color={SEMANTIC_COLORS.textSecondary}
              >
                {fmtCapacityUsd(driverData.from.usd)} → {fmtCapacityUsd(driverData.to.usd)}
              </Text>
            </Grid>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.label}
              color={SEMANTIC_COLORS.textSecondary}
              mt={SPACING.sm}
            >
              {observedTime(driverData.from.at)} → {observedTime(driverData.to.at)} · recorded
              blocks {driverData.from.block.toLocaleString()} →{' '}
              {driverData.to.block.toLocaleString()}
            </Text>
            {driverData.aaveStocks ? (
              <Box mt={SPACING.lg}>
                <Eyebrow>two reserve stocks · not a borrow/repay attribution</Eyebrow>
                <Grid
                  templateColumns={{ base: '1fr', sm: '1fr 1fr' }}
                  gap={SPACING.base}
                  mt={SPACING.sm}
                >
                  <Stat
                    label="available cash change"
                    value={signedUsd(driverData.aaveStocks.cashDeltaUsd)}
                    sub="USDe held by the aToken · this is the total move"
                  />
                  <Stat
                    label="outstanding variable debt change"
                    value={signedUsd(driverData.aaveStocks.debtDeltaUsd)}
                    sub={`${fmtCapacityUsd(driverData.aaveStocks.debtFromUsd)} → ${fmtCapacityUsd(driverData.aaveStocks.debtToUsd)} · separate stock`}
                  />
                </Grid>
              </Box>
            ) : (
              <Box mt={SPACING.lg}>
                <Eyebrow>measured market contribution · sums to the total</Eyebrow>
                <Box mt={SPACING.sm}>
                  {driverData.components.map((part, i) => (
                    <Grid
                      key={part.id}
                      templateColumns={{ base: '1fr', md: 'minmax(0, 1fr) auto auto' }}
                      gap={SPACING.base}
                      py={SPACING.sm}
                      borderBottom={i === driverData.components.length - 1 ? 'none' : '1px solid'}
                      borderColor={SEMANTIC_COLORS.borderSubtle}
                      alignItems="baseline"
                    >
                      <Text
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontSize={TYPOGRAPHY.small}
                        color={SEMANTIC_COLORS.textPrimary}
                      >
                        {part.name}
                      </Text>
                      <Text
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontSize={TYPOGRAPHY.xs}
                        color={SEMANTIC_COLORS.textSecondary}
                      >
                        {fmtCapacityUsd(part.fromUsd)} → {fmtCapacityUsd(part.toUsd)}
                      </Text>
                      <Text
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontSize={TYPOGRAPHY.small}
                        fontWeight={TYPOGRAPHY.medium}
                        color={
                          part.deltaUsd >= 0 ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.danger
                        }
                        textAlign={{ base: 'left', md: 'right' }}
                      >
                        {signedUsd(part.deltaUsd)}
                      </Text>
                    </Grid>
                  ))}
                </Box>
              </Box>
            )}
            {driverData.transactionEvidence ? (
              <Box
                mt={SPACING.lg}
                pt={SPACING.base}
                borderTop="1px solid"
                borderColor={SEMANTIC_COLORS.borderSubtle}
              >
                <Eyebrow>observed transaction classes · exit-token transfers</Eyebrow>
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.xs}
                  color={SEMANTIC_COLORS.textSecondary}
                  mt={SPACING.sm}
                >
                  Positive = net tokens into the exit side; negative = net tokens out. Classes come
                  from Curve pool events in the same transactions, not from inferred trader intent.
                </Text>
                <Box mt={SPACING.sm}>
                  {TRANSACTION_CLASSES.map((kind) => {
                    const value = driverData.transactionEvidence!.byClassUsdProxy[kind]
                    return (
                      <Grid
                        key={kind}
                        templateColumns={{ base: '1fr auto', md: 'minmax(0, 1fr) auto' }}
                        gap={SPACING.base}
                        py={SPACING.xs}
                        borderBottom="1px solid"
                        borderColor={SEMANTIC_COLORS.borderSubtle}
                        alignItems="baseline"
                      >
                        <Text
                          fontFamily={TYPOGRAPHY.fontMono}
                          fontSize={TYPOGRAPHY.small}
                          color={SEMANTIC_COLORS.textPrimary}
                        >
                          {transactionClassLabel[kind]}
                        </Text>
                        <Text
                          fontFamily={TYPOGRAPHY.fontMono}
                          fontSize={TYPOGRAPHY.small}
                          fontWeight={TYPOGRAPHY.medium}
                          color={
                            value > 0
                              ? SEMANTIC_COLORS.success
                              : value < 0
                                ? SEMANTIC_COLORS.danger
                                : SEMANTIC_COLORS.textSecondary
                          }
                          textAlign="right"
                        >
                          {signedUsd(value)}
                        </Text>
                      </Grid>
                    )
                  })}
                </Box>
                <Grid
                  templateColumns={{ base: '1fr', sm: 'repeat(2, 1fr)' }}
                  gap={SPACING.base}
                  mt={SPACING.sm}
                >
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.xs}
                    color={SEMANTIC_COLORS.textSecondary}
                  >
                    Classified transfer net{' '}
                    {signedUsd(driverData.transactionEvidence.transferNetUsdProxy)}
                  </Text>
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.xs}
                    color={SEMANTIC_COLORS.textSecondary}
                  >
                    Residual vs recorded inventory{' '}
                    {signedUsd(driverData.transactionEvidence.residualUsdProxy)} · max{' '}
                    {smallPercent(driverData.transactionEvidence.maxResidualPctOfGrossMovement)} of
                    gross movement
                  </Text>
                </Grid>
                {!driverData.transactionEvidence.blockPinnedSnapshots && (
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.xs}
                    color={SEMANTIC_COLORS.warning}
                    mt={SPACING.sm}
                  >
                    Historical observations were not read at pinned blocks. The event-flow match is
                    indicative, not an exact same-state attribution.
                  </Text>
                )}
              </Box>
            ) : (
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.xs}
                color={SEMANTIC_COLORS.textSecondary}
                mt={SPACING.lg}
              >
                Transaction-class evidence is not reconciled for this window; only the measured
                inventory change is shown.
              </Text>
            )}
            <Stamp>
              observed snapshots · $1/stable assumption · event {driverData.eventId.slice(0, 8)} ·
              snapshot {driverData.from.snapshotId.slice(0, 8)} →{' '}
              {driverData.to.snapshotId.slice(0, 8)}
            </Stamp>
          </>
        )}
      </Card>

      {/* 03 / complete-window withdrawal history */}
      <SectionHeading index="03 /" title="Withdrawal history" note="Complete windows only" />
      <Grid templateColumns={{ base: '1fr', sm: '1fr 1fr' }} gap={SPACING.base}>
        <Stat label="max observed 24h withdrawals" value="Unavailable" sub="Window unverified" />
        <Stat label="max observed 7d withdrawals" value="Unavailable" sub="Window unverified" />
      </Grid>

      {/* 04 / open flags + what we cannot see */}
      <SectionHeading
        index="04 /"
        title="Open alerts and notices"
        note={
          !summary || summary.alarms.status === 'unknown'
            ? 'Alarm records unavailable'
            : summary?.alarms.status === 'database_unreconciled'
              ? 'Database alerts · newer local snapshot'
              : 'Measured alerts · terms notices'
        }
      />
      <Card variant="default" p={SPACING.base}>
        <Eyebrow>open alerts and notices</Eyebrow>
        <Box mt={SPACING.sm} mb={SPACING.base}>
          {!summary || summary.alarms.status === 'unknown' ? (
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="11.5px"
              color={SEMANTIC_COLORS.textSecondary}
            >
              {summaryLoading ? 'Reading alarm status…' : 'Alarm status unavailable'}
            </Text>
          ) : openAlarms.length === 0 ? (
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="11.5px"
              color={SEMANTIC_COLORS.textSecondary}
            >
              None open · recorder blind spots below
            </Text>
          ) : (
            openAlarms.map((a, i) => {
              const event: Entry = {
                venue,
                kind: a.kind,
                at: a.firedAt,
                prev: null,
                next: null,
                provenance: 'alarm',
                severity: a.severity,
                evidence: a.evidence,
              }
              const c = alarmConsequence(event)
              const sourceUrl = termsSourceUrl(event)
              const color =
                c.tone === 'danger'
                  ? SEMANTIC_COLORS.danger
                  : c.tone === 'notice'
                    ? SEMANTIC_COLORS.info
                    : SEMANTIC_COLORS.textSecondary
              return (
                <Grid
                  key={`${a.kind}-${a.firedAt}`}
                  templateColumns={{ base: '1fr', md: '160px 1fr 90px' }}
                  gap={SPACING.base}
                  py={SPACING.sm}
                  borderBottom={i === openAlarms.length - 1 ? 'none' : '1px solid'}
                  borderColor={SEMANTIC_COLORS.borderSubtle}
                  alignItems="baseline"
                >
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize="10px"
                    letterSpacing="0.14em"
                    textTransform="uppercase"
                    color={color}
                  >
                    {isTermsOnlyNotice(event) ? 'terms-page notice' : a.kind.replace(/_/g, ' ')}
                  </Text>
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize="11px"
                    color={SEMANTIC_COLORS.textSecondary}
                  >
                    {c.text}
                    {sourceUrl && (
                      <Text
                        as="a"
                        href={sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        ml={SPACING.sm}
                        textDecoration="underline"
                        color={SEMANTIC_COLORS.info}
                      >
                        source terms ↗
                      </Text>
                    )}
                  </Text>
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize="9px"
                    letterSpacing="0.14em"
                    textTransform="uppercase"
                    color={color}
                    textAlign={{ base: 'left', md: 'right' }}
                  >
                    {isTermsOnlyNotice(event) ? 'notice' : a.severity}
                  </Text>
                </Grid>
              )
            })
          )}
        </Box>
        <Eyebrow>what this recorder cannot see</Eyebrow>
        <Box mt={SPACING.sm}>
          {uncovered.map((u) => (
            <Grid
              key={u.id}
              templateColumns={{ base: '1fr', md: '180px 1fr' }}
              gap={SPACING.base}
              py={SPACING.sm}
              borderBottom="1px solid"
              borderColor={SEMANTIC_COLORS.borderSubtle}
              alignItems="baseline"
            >
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="10px"
                letterSpacing="0.14em"
                textTransform="uppercase"
                color={SEMANTIC_COLORS.textTertiary}
              >
                {u.label}
              </Text>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="11px"
                color={SEMANTIC_COLORS.textTertiary}
                fontStyle="italic"
              >
                {u.memo}
              </Text>
            </Grid>
          ))}
        </Box>
      </Card>

      {/* 05 / what changed */}
      <SectionHeading index="05 /" title="What changed" note="Recorded changes" />
      <Card variant="default" p={SPACING.base}>
        {!logData ? (
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="11.5px"
            color={SEMANTIC_COLORS.textSecondary}
          >
            {logLoading ? 'Reading changes…' : 'Change history unavailable'}
          </Text>
        ) : logEntries.length === 0 ? (
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="11.5px"
            color={SEMANTIC_COLORS.textSecondary}
          >
            No recorded changes.
          </Text>
        ) : (
          <Box>
            {logEntries.map((e, i) => {
              const isAlarm = e.provenance === 'alarm'
              const c = isAlarm ? alarmConsequence(e) : consequence(e)
              const sourceUrl = termsSourceUrl(e)
              const textColor = isAlarm
                ? c.tone === 'danger'
                  ? SEMANTIC_COLORS.danger
                  : c.tone === 'notice'
                    ? SEMANTIC_COLORS.info
                    : SEMANTIC_COLORS.textTertiary
                : c.tone === 'warning'
                  ? SEMANTIC_COLORS.warning
                  : SEMANTIC_COLORS.textPrimary
              return (
                <Grid
                  key={`${e.at}-${e.kind}`}
                  templateColumns={{ base: '1fr', md: '110px 1fr 110px' }}
                  gap={SPACING.base}
                  py={SPACING.sm}
                  borderBottom={i === logEntries.length - 1 ? 'none' : '1px solid'}
                  borderColor={SEMANTIC_COLORS.borderSubtle}
                  alignItems="baseline"
                >
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize="10px"
                    letterSpacing="0.14em"
                    textTransform="uppercase"
                    color={SEMANTIC_COLORS.textTertiary}
                  >
                    {new Date(e.at).toISOString().slice(0, 10)}
                  </Text>
                  <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11.5px" color={textColor}>
                    {c.text}
                    {sourceUrl && (
                      <Text
                        as="a"
                        href={sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        ml={SPACING.sm}
                        textDecoration="underline"
                        color={SEMANTIC_COLORS.info}
                      >
                        source terms ↗
                      </Text>
                    )}
                  </Text>
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize="9px"
                    letterSpacing="0.14em"
                    textTransform="uppercase"
                    color={
                      isAlarm && c.tone === 'danger'
                        ? SEMANTIC_COLORS.danger
                        : isAlarm && c.tone === 'notice'
                          ? SEMANTIC_COLORS.info
                          : SEMANTIC_COLORS.textTertiary
                    }
                    textAlign={{ base: 'left', md: 'right' }}
                  >
                    {isTermsOnlyNotice(e) ? 'notice' : e.provenance}
                  </Text>
                </Grid>
              )
            })}
          </Box>
        )}
        <ProvFooter date={corpusDate} local={Boolean(localProvenance)} />
      </Card>

      {/* 06 / what's being said */}
      <SectionHeading index="06 /" title="What's being said" note="Unverified headlines" />
      <Card variant="default" p={SPACING.base}>
        {!newsData ? (
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="11.5px"
            color={SEMANTIC_COLORS.textSecondary}
          >
            {newsLoading ? 'Reading headlines…' : 'Headline status unavailable'}
          </Text>
        ) : newsItems.length === 0 ? (
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="11.5px"
            color={SEMANTIC_COLORS.textSecondary}
          >
            Nothing yet — headlines appear once the news fetcher has run for this venue.
          </Text>
        ) : (
          <Box>
            {newsItems.map((it, i) => (
              <Grid
                key={it.url}
                templateColumns={{ base: '1fr', md: '190px 130px 1fr' }}
                gap={SPACING.base}
                py={SPACING.sm}
                borderBottom={i === newsItems.length - 1 ? 'none' : '1px solid'}
                borderColor={SEMANTIC_COLORS.borderSubtle}
                alignItems="baseline"
              >
                <Box>
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize="10px"
                    color={SEMANTIC_COLORS.textTertiary}
                  >
                    Published · {newsTimeUtc(it.publishedAt)}
                  </Text>
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize="10px"
                    color={SEMANTIC_COLORS.textSecondary}
                  >
                    {newsFetchedAtLabel(newsData?.provenance?.storage)} ·{' '}
                    {newsTimeUtc(it.fetchedAt)}
                  </Text>
                </Box>
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize="10px"
                  letterSpacing="0.06em"
                  color={SEMANTIC_COLORS.textSecondary}
                >
                  {it.source}
                </Text>
                <Box
                  as="a"
                  href={it.url}
                  rel="noopener noreferrer"
                  target="_blank"
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize="11.5px"
                  color={SEMANTIC_COLORS.textPrimary}
                  transition={TRANSITIONS.colors}
                  _hover={{ color: SEMANTIC_COLORS.success, textDecoration: 'underline' }}
                  _focus={FOCUS_STYLES.ring}
                >
                  {it.title}
                </Box>
              </Grid>
            ))}
          </Box>
        )}
        <ProvFooter date={corpusDate} local={Boolean(localProvenance)} />
      </Card>

      {/* 07 / next-step row */}
      <NextRow />
    </Box>
  )
}

export default VenuePage
