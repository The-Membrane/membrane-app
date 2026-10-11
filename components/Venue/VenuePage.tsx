import React from 'react'
import { Box, Grid, HStack, Text } from '@chakra-ui/react'
import { useQuery } from '@tanstack/react-query'
import NextLink from 'next/link'

import { Card } from '@/components/ui/Card'
import {
  TRANSACTION_CLASSES,
  type DriverResult,
  type TransactionClass,
} from '@/components/Venue/capacityDriverLogic'
import { CapacityCurve } from '@/components/Venue/CapacityCurve'
import { NetApyCard } from '@/components/NetApy/NetApyCard'
import { venueByKey } from '@/lib/netApy/venues'
import { fmtUsd } from '@/components/Radar/radarLogic'
import { Entry, consequence, alarmConsequence, fmtDuration } from '@/components/Carry/venueLogLogic'
import { Eyebrow, SectionHeading, Stamp } from '@/components/Carry/atoms'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { useChainRoute } from '@/hooks/useChainRoute'

/**
 * VenuePage — the /venue/[name] permalink. Every headline about a carry venue
 * becomes our distribution moment: one URL assembling the venue's recorded state,
 * its worst realized exits, the open flags AND the blind spots, what changed, and
 * what's being said. All corpus-driven, numbers-first, no prose explanations.
 *
 * Data: /api/venues/[venue]/summary (state + coverage + worst-outflows + alarms),
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
  corpus: {
    snapshots: number
    snapshotsObserved: number
    snapshotSpan: { start: string | null; end: string | null }
    flows: number
    flowSpan: { start: string | null; end: string | null }
    news: number
  }
  worstOutflows: {
    d1: { usd: number; date: string } | null
    d7: { usd: number; date: string } | null
  }
  alarms: {
    open: Array<{
      kind: string
      severity: 'watch' | 'alarm'
      evidence: Record<string, unknown> | null
      firedAt: string
    }>
    uncovered: Array<{ id: string; label: string; memo: string }>
  }
}

type NewsItem = {
  venue: string
  title: string
  source: string
  url: string
  publishedAt: string | null
  fetchedAt: string
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

const ProvFooter: React.FC<{ date: string }> = ({ date }) => (
  <Stamp>carry radar · recorded corpus · {date}</Stamp>
)

// --- the page --------------------------------------------------------------

export const VenuePage: React.FC<{ venue: string }> = ({ venue }) => {
  const { chainName } = useChainRoute()

  const { data: summary } = useQuery<VenueSummary>({
    queryKey: ['venue_summary', venue],
    queryFn: async () => {
      const r = await fetch(`/api/venues/${venue}/summary`)
      if (!r.ok) throw new Error(`venue summary ${r.status}`)
      return r.json()
    },
    staleTime: 1000 * 60 * 5,
    refetchOnMount: true,
  })

  const { data: logData } = useQuery<{ entries: Entry[] }>({
    queryKey: ['venue_log'],
    queryFn: async () => {
      const r = await fetch('/api/venues/log')
      if (!r.ok) throw new Error(`venue log ${r.status}`)
      return r.json()
    },
    staleTime: 1000 * 60 * 5,
    refetchOnMount: true,
  })

  const { data: newsData } = useQuery<{ items: NewsItem[] }>({
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
  const corpusDate = day(summary?.corpus.snapshotSpan.end ?? obs?.observedAt) || todayIso()

  // TVL prefers totalAssets (the cooldown/4626 venues), else the instant read (aave).
  const totalAssetsUsd = p?.totalAssets != null ? Number(p.totalAssets) / 1e18 : null
  const tvlUsd = totalAssetsUsd ?? obs?.instantUsd ?? null
  // Instant-exit liquidity: the protocol instant read where it exists (aave),
  // else the instant-exit-tier secondary-market depth (cooldown/4626 venues).
  const instantIsProtocol = obs?.instantUsd != null
  const instantLiquidityUsd = instantIsProtocol ? obs!.instantUsd : (p?.depthUsd ?? null)

  const logEntries = (logData?.entries ?? []).filter((e) => e.venue === venue)
  const newsItems = newsData?.items ?? []
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
          <Text as="span" fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.success}>
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
      <ProvFooter date={corpusDate} />

      {/* 01 / the state */}
      <SectionHeading index="01 /" title="The state" note="latest observed on-chain reading" />
      {obs ? (
        <>
          <Grid
            templateColumns={{ base: '1fr', sm: '1fr 1fr', lg: 'repeat(4, 1fr)' }}
            gap={SPACING.base}
          >
            <Stat
              label="gate"
              value={
                p?.cooldownDuration != null && p.cooldownDuration > 0
                  ? `${fmtDuration(p.cooldownDuration)} cooldown`
                  : instantIsProtocol
                    ? 'instant'
                    : 'no cooldown'
              }
              sub={`block ${obs.block.toLocaleString()}`}
            />
            <Stat
              label="TVL"
              value={tvlUsd != null ? fmtUsd(tvlUsd) : '—'}
              sub="total assets · $1/stable"
            />
            <Stat
              label={instantIsProtocol ? 'instant liquidity' : 'instant-exit depth'}
              value={instantLiquidityUsd != null ? fmtUsd(instantLiquidityUsd) : 'not derivable'}
              sub={
                instantIsProtocol
                  ? 'underlying held, exitable now'
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
              <Stamp>
                depth = the EXITABLE side (tokens swappable INTO on exit), $1/stable. This is the
                instant-exit tier only; protocol redemption (cooldown/instant) is a separate exit
                path.
              </Stamp>
            </Card>
          )}
          <ProvFooter date={day(obs.observedAt)} />
        </>
      ) : (
        <Card variant="default" p={SPACING.base}>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="11.5px"
            color={SEMANTIC_COLORS.textSecondary}
          >
            No observed snapshot yet for this venue.
          </Text>
        </Card>
      )}

      {/* 01b / swap-out capacity — what exits within a cost, fees included (on-chain quotes) */}
      <SectionHeading index="01b /" title="Swap-out capacity" note="what exits within a cost, fees included — is the depth 1:1? read the curve" />
      <CapacityCurve venue={venue} />

      {/* 01c / net at your size — the venue's own rate curve at one block (lib/netApy) */}
      {venueByKey(venue) ? (
        <>
          <SectionHeading index="01c /" title="Net at your size" note="your size moves the rate · incentives shown with end dates · projection, not a promise" />
          <NetApyCard venue={venue} />
        </>
      ) : null}

      {/* 02 / observed capacity driver accounting, never causal attribution */}
      <SectionHeading
        index="02 /"
        title="Why did capacity move?"
        note="first answer · which recorded inventory changed"
      />
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
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
          color={SEMANTIC_COLORS.textSecondary}
          mt={SPACING.base}
        >
          Component and transaction-flow accounting do not reveal why actors moved capital.
          Historical recorder snapshots may be unpinned; volatility and governance signals are not
          validated here. Pool-side inventory is not an executable exit quote.
        </Text>
      </Card>

      {/* 03 / worst recorded exits */}
      <SectionHeading
        index="03 /"
        title="Worst recorded exits"
        note="realized outflow, trailing 90 days"
      />
      <Grid templateColumns={{ base: '1fr', sm: '1fr 1fr' }} gap={SPACING.base}>
        <Stat
          label="worst 1-day outflow"
          value={summary?.worstOutflows.d1 ? fmtUsd(summary.worstOutflows.d1.usd) : '—'}
          sub={summary?.worstOutflows.d1 ? day(summary.worstOutflows.d1.date) : 'no flow rows'}
        />
        <Stat
          label="worst 7-day outflow"
          value={summary?.worstOutflows.d7 ? fmtUsd(summary.worstOutflows.d7.usd) : '—'}
          sub={
            summary?.worstOutflows.d7
              ? `week ending ${day(summary.worstOutflows.d7.date)}`
              : 'no flow rows'
          }
        />
      </Grid>
      {venue === 'sUSDe' && (
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="10px"
          color={SEMANTIC_COLORS.warning}
          mt={SPACING.sm}
          fontStyle="italic"
        >
          sUSDe caveat: recorded out-flows are cooldown INITIATIONS — the Withdraw event fires when
          a holder STARTS the cooldown, not when assets are received. A worst-outflow day marks
          demand to leave, not settled exits.
        </Text>
      )}
      <ProvFooter date={day(summary?.corpus.flowSpan.end)} />

      {/* 04 / open flags + what we cannot see */}
      <SectionHeading
        index="04 /"
        title="Open flags"
        note="failure-pattern alarms in danger — and the blind spots, same prominence"
      />
      <Card variant="default" p={SPACING.base}>
        <Eyebrow>open alarms</Eyebrow>
        <Box mt={SPACING.sm} mb={SPACING.base}>
          {openAlarms.length === 0 ? (
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="11.5px"
              color={SEMANTIC_COLORS.textSecondary}
            >
              None open. Silence is NOT all-clear — see the blind spots below.
            </Text>
          ) : (
            openAlarms.map((a, i) => (
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
                  color={a.severity === 'alarm' ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.warning}
                >
                  {a.kind}
                </Text>
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize="11px"
                  color={SEMANTIC_COLORS.textSecondary}
                >
                  {a.evidence ? JSON.stringify(a.evidence) : ''}
                </Text>
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize="9px"
                  letterSpacing="0.14em"
                  textTransform="uppercase"
                  color={a.severity === 'alarm' ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.warning}
                  textAlign={{ base: 'left', md: 'right' }}
                >
                  {a.severity}
                </Text>
              </Grid>
            ))
          )}
        </Box>
        <Eyebrow>what this alarm cannot see</Eyebrow>
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
        <Stamp>
          a quiet board is never a safe venue — the blind-spot list carries the same weight as the
          flags
        </Stamp>
      </Card>

      {/* 05 / what changed */}
      <SectionHeading
        index="05 /"
        title="What changed"
        note="state changes only — parameter moves and >20% liquidity shifts; drift never appears here"
      />
      <Card variant="default" p={SPACING.base}>
        {logEntries.length === 0 ? (
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="11.5px"
            color={SEMANTIC_COLORS.textSecondary}
          >
            Nothing yet — the recorder logs an entry when this venue actually changes something.
          </Text>
        ) : (
          <Box>
            {logEntries.map((e, i) => {
              const isAlarm = e.provenance === 'alarm'
              const c = isAlarm ? alarmConsequence(e) : consequence(e)
              const textColor = isAlarm
                ? c.tone === 'danger'
                  ? SEMANTIC_COLORS.danger
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
                  </Text>
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize="9px"
                    letterSpacing="0.14em"
                    textTransform="uppercase"
                    color={
                      isAlarm && !e.cleared ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.textTertiary
                    }
                    textAlign={{ base: 'left', md: 'right' }}
                  >
                    {e.provenance}
                  </Text>
                </Grid>
              )
            })}
          </Box>
        )}
        <ProvFooter date={corpusDate} />
      </Card>

      {/* 06 / what's being said */}
      <SectionHeading
        index="06 /"
        title="What's being said"
        note="raw headlines, newest first — information, not endorsement"
      />
      <Card variant="default" p={SPACING.base}>
        {newsItems.length === 0 ? (
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
                templateColumns={{ base: '1fr', md: '92px 130px 1fr' }}
                gap={SPACING.base}
                py={SPACING.sm}
                borderBottom={i === newsItems.length - 1 ? 'none' : '1px solid'}
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
                  {day(it.publishedAt)}
                </Text>
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
        <ProvFooter date={corpusDate} />
      </Card>

      {/* 07 / next-step row */}
      <NextRow />
    </Box>
  )
}

export default VenuePage
