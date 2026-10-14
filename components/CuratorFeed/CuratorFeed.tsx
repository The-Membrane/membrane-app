// CURATOR ACTION FEED — what vault curators changed on Ethereum mainnet, and who holds
// what. Owner spec "Risk Manager Tooling — Planning Spec" (2026-10-05), data product #8.
//
// DeFi Dojo research (621 verified records): curator exposure + rate-spike attribution
// came up in 10 messages from 6 authors; after the Resolv / Stream / msUSD incidents
// members asked which vaults were exposed. Steakhouse cutting rsETH in 2025 was a signal
// anyone could have followed — this page makes such moves visible as they happen.
//
// COLOUR RULES (spec): a submitted change inside its timelock window = PENDING, amber;
// executed or resolved = history, grey; exits of one collateral by ≥ 2 curators inside
// the window (24–72h) = red. COPY RULES: factual only — what the chain recorded, who, how
// much, when. Never "safe", never a prediction. Every figure carries its provenance.
//
// §07 ORACLE ABOVE MARKET (membrane-board design/DESIGN_RULES.md): finding → evidence →
// action. Measured live (oracle price() vs DefiLlama), beside the retrospective record of
// the same rule (Q25 T2 I3). Calm is ink only; red ✖ only for a market whose oracle has
// priced its collateral ≥ 2 % above market for 24 h (a latent loss); building is ink ▲;
// stale is hatched ░ with the headline withheld. Every number comes from the API.

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import NextLink from 'next/link'
import { Box, HStack, Input, Link, Stack, Text } from '@chakra-ui/react'
import { useQuery } from '@tanstack/react-query'

import { Eyebrow, SectionHeading, Stamp } from '@/components/Carry/atoms'
import { Card } from '@/components/ui/Card'
import { useChainRoute } from '@/hooks/useChainRoute'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { compact, durationText, utc } from '@/lib/curatorFeed/format'
import {
  gapText,
  HOLD_SECONDS,
  i3Headline,
  MARKET_HOLD_SECONDS,
  MIN_PRICE_CONFIDENCE,
  recordCaveats,
  recordCredit,
  recordLines,
  thresholdText,
} from '@/lib/curatorFeed/oracleGap'
import type {
  AttributionView,
  ClusterView,
  ExposureResponse,
  FeedResponse,
  FeedRow,
  Group,
  MarketFlagView,
  OracleGapMarketView,
  OracleGapResponse,
  ShiftView,
  SpikeView,
  VaultExposureView,
} from '@/lib/curatorFeed/service'
import type { Tone } from '@/lib/curatorFeed/status'

const TONE: Record<Tone, string> = {
  amber: SEMANTIC_COLORS.warning,
  red: SEMANTIC_COLORS.danger,
  grey: SEMANTIC_COLORS.textTertiary,
}
const PROTOCOL: Record<string, string> = {
  'morpho-v1': 'MetaMorpho',
  'morpho-v2': 'Vault V2',
  'euler-earn': 'Euler Earn',
  'aave-v3': 'Aave v3',
}
const GROUPS: { key: Group; label: string }[] = [
  { key: 'all', label: 'all' },
  { key: 'exits', label: 'exits' },
  { key: 'caps', label: 'caps' },
  { key: 'queues', label: 'queues' },
  { key: 'timelock', label: 'timelocks' },
  { key: 'roles', label: 'roles' },
  { key: 'protocol', label: 'aave' },
]
const ETHERSCAN = 'https://etherscan.io'

const Mono: React.FC<{
  children: React.ReactNode
  color?: string
  size?: string
  as?: 'span' | 'p'
  title?: string
}> = ({ children, color, size = '11px', as = 'p', title }) => (
  <Text
    as={as}
    title={title}
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize={size}
    color={color ?? SEMANTIC_COLORS.textSecondary}
    sx={{ fontVariantNumeric: 'tabular-nums' }}
  >
    {children}
  </Text>
)

const Chip: React.FC<{ active?: boolean; onClick?: () => void; children: React.ReactNode }> = ({
  active,
  onClick,
  children,
}) => (
  <Box
    as="button"
    type="button"
    onClick={onClick}
    aria-pressed={active}
    px={SPACING.sm}
    py="2px"
    border="1px solid"
    borderRadius={0}
    borderColor={active ? SEMANTIC_COLORS.primary : SEMANTIC_COLORS.borderSubtle}
    color={active ? SEMANTIC_COLORS.primary : SEMANTIC_COLORS.textSecondary}
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="10px"
    letterSpacing="0.12em"
    textTransform="uppercase"
    _hover={{ borderColor: SEMANTIC_COLORS.borderStrong }}
  >
    {children}
  </Box>
)

const Tag: React.FC<{ tone: Tone; wrap?: boolean; children: React.ReactNode }> = ({
  tone,
  wrap,
  children,
}) => (
  <Text
    as="span"
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="9px"
    letterSpacing="0.16em"
    textTransform="uppercase"
    color={TONE[tone]}
    border="1px solid"
    borderColor={TONE[tone]}
    px="4px"
    whiteSpace={wrap ? 'normal' : 'nowrap'}
    overflowWrap="anywhere"
  >
    {children}
  </Text>
)

const statusLabel = (r: FeedRow, nowS: number): string => {
  if (r.status === 'pending')
    return `pending · ${durationText(Math.max(0, (r.validAt ?? nowS) - nowS))} left`
  if (r.status === 'executable') return 'timelock elapsed · not executed'
  if (r.status === 'cleared') return 'no longer pending'
  return r.status
}

/** "zero timelock: increaseAbsoluteCap, addAdapter +1" — V1 / Euler Earn report `timelock`. */
const zeroText = (fns: string[]): string =>
  fns.length === 1 && fns[0] === 'timelock'
    ? 'timelock 0'
    : `timelock 0: ${fns.slice(0, 2).join(', ')}${fns.length > 2 ? ` +${fns.length - 2}` : ''}`

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url)
  const body = await r.json()
  if (!r.ok) throw new Error(body?.error ?? `${url} ${r.status}`)
  return body as T
}

// ── oracle gap (lib/curatorFeed/oracleGap.ts) ─────────────────────────────────

/** Stale inputs: hatched, never coloured (DESIGN_RULES §4). */
const HATCH = `repeating-linear-gradient(135deg, ${SEMANTIC_COLORS.borderMedium} 0 1px, transparent 1px 6px)`

/** A USD price at 5 significant digits: $83,357 · $1.0645 · $0.000015853. */
const usdPrice = (x: number): string =>
  `$${Number(x.toPrecision(5)).toLocaleString('en-US', { maximumFractionDigits: 20 })}`

/**
 * The last 48 hourly points as a thin ink line, the condition as a dotted ink rule
 * labelled on the chart. An unobserved point or a missing hour breaks the line.
 */
const GapSpark: React.FC<{
  series: OracleGapMarketView['series']
  line: number
  label: string
}> = ({ series, line, label }) => {
  const W = 132
  const H = 30
  const PAD = 3
  const LABEL = 22
  const seen = series.filter((p): p is { ts: number; gap: number } => p.gap !== null)
  if (seen.length < 2) return null
  const t0 = series[0].ts
  const t1 = series[series.length - 1].ts
  const lo = Math.min(0, line, ...seen.map((p) => p.gap))
  const hi = Math.max(line, ...seen.map((p) => p.gap))
  const x = (ts: number) => PAD + ((ts - t0) / Math.max(1, t1 - t0)) * (W - LABEL - 2 * PAD)
  const y = (g: number) => PAD + (1 - (g - lo) / (hi - lo || 1)) * (H - 2 * PAD)
  const segs: string[][] = []
  let prev: number | undefined
  for (const p of series) {
    if (p.gap === null) {
      prev = undefined
      continue
    }
    if (prev === undefined || p.ts - prev > HOLD_SECONDS.hourly) segs.push([])
    segs[segs.length - 1].push(`${x(p.ts).toFixed(1)},${y(p.gap).toFixed(1)}`)
    prev = p.ts
  }
  return (
    <Box
      as="svg"
      width={`${W}px`}
      height={`${H}px`}
      viewBox={`0 0 ${W} ${H}`}
      flexShrink={0}
      role="img"
      aria-label={`Gap over the last ${series.length} hourly points, against the ${label} line`}
    >
      <line
        x1={PAD}
        x2={W - LABEL}
        y1={y(line)}
        y2={y(line)}
        style={{ stroke: SEMANTIC_COLORS.textTertiary, strokeWidth: 1, strokeDasharray: '1 2' }}
      />
      <text
        x={W - LABEL + 3}
        y={y(line) + 3}
        style={{ fill: SEMANTIC_COLORS.textTertiary, fontSize: 9, fontFamily: TYPOGRAPHY.fontMono }}
      >
        {label}
      </text>
      {lo < 0 && (
        <line
          x1={PAD}
          x2={W - LABEL}
          y1={y(0)}
          y2={y(0)}
          style={{ stroke: SEMANTIC_COLORS.borderSubtle, strokeWidth: 1 }}
        />
      )}
      {segs.map((pts) =>
        pts.length > 1 ? (
          <polyline
            key={pts[0]}
            points={pts.join(' ')}
            style={{ fill: 'none', stroke: SEMANTIC_COLORS.textSecondary, strokeWidth: 1.25 }}
          />
        ) : (
          <circle
            key={pts[0]}
            cx={Number(pts[0].split(',')[0])}
            cy={Number(pts[0].split(',')[1])}
            r={1.25}
            style={{ fill: SEMANTIC_COLORS.textSecondary }}
          />
        ),
      )}
    </Box>
  )
}

/** Tap target ≥ 44px on phones (DESIGN_RULES §8), inline on desktop. */
const ACTION = {
  display: 'inline-flex',
  alignItems: 'center',
  minH: { base: '44px', md: 'auto' },
  mr: SPACING.base,
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: '11px',
  color: SEMANTIC_COLORS.textSecondary,
  textDecoration: 'underline',
  _hover: { color: SEMANTIC_COLORS.textPrimary },
  _focusVisible: FOCUS_STYLES.ring,
} as const

/** Where a market stands, in words; the glyph carries the state (DESIGN_RULES §2). */
function gapStatus(m: OracleGapMarketView, r: OracleGapResponse): string {
  const { i3 } = m
  const line = thresholdText(r.constants)
  switch (i3.state) {
    case 'fired':
      return `✖ ${i3.hoursAboveConsecutive} h above ${line} · since ${utc(i3.firedSince ?? 0)}`
    case 'building':
      return `▲ ${i3.hoursAboveConsecutive} of ${i3.persistence} h above ${line}`
    case 'unobserved':
      return m.lastRaw
        ? `no point this hour: DefiLlama confidence ${m.lastRaw.marketConfidence} under ${MIN_PRICE_CONFIDENCE} (raw ${gapText(m.lastRaw.rawGap)}, not counted)`
        : 'no point this hour (oracle reverts, or no fresh DefiLlama price)'
    case 'stale':
      return `░ last point ${durationText(r.meta.now - (i3.lastTs ?? 0))} ago`
    default:
      return `below ${line}`
  }
}

/** The $ exposed (DESIGN_RULES §4): curated supply at the last exposure read. */
function exposedText(m: OracleGapMarketView, minUsd: number): string {
  if (m.curatedUsd === undefined) return 'no curated supply (no curated vault holds it)'
  if (m.curatedUsd < minUsd) return `under $${minUsd} curated supply`
  return `$${compact(m.curatedUsd)} curated supply${m.locked ? ' (book value: supply locked)' : ''}`
}

/** "$787M (book value: supply locked)" / "$5M (incl. $1M book value)" / "$5M" */
function usdWithBook(total: number, book: number): string {
  if (book > 0 && book >= total * 0.999) return `$${compact(total)} (book value: supply locked)`
  if (book > 0) return `$${compact(total)} (incl. $${compact(book)} book value)`
  return `$${compact(total)}`
}

/** "Held: Vault (Curator) 12.3% · …" */
function heldText(m: OracleGapMarketView): string {
  if (!m.vaults.length) return 'No curated vault holds it at the last exposure read.'
  const list = m.vaults
    .slice(0, 3)
    .map((v) => `${v.vaultName} (${v.curatorName}) ${(v.share * 100).toFixed(1)}%`)
    .join(' · ')
  return `Held: ${list}${m.vaults.length > 3 ? ` · +${m.vaults.length - 3} more` : ''}`
}

const GapRow: React.FC<{
  m: OracleGapMarketView
  r: OracleGapResponse
  onWatch: (symbol: string) => void
}> = ({ m, r, onWatch }) => {
  const fired = m.i3.state === 'fired'
  const ink = fired ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.textPrimary
  return (
    <Box py={SPACING.sm} borderBottom="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}>
      <HStack justify="space-between" align="center" spacing={SPACING.sm} flexWrap="wrap">
        <Mono size="12px" color={SEMANTIC_COLORS.textPrimary} title={m.market}>
          {m.marketName}
        </Mono>
        <HStack spacing={SPACING.sm} align="center">
          <GapSpark series={m.series} line={r.constants.gap} label={thresholdText(r.constants)} />
          {m.i3.currentGap !== undefined && (
            <Mono size="14px" color={ink} title="oracle ÷ DefiLlama − 1, newest point">
              {fired ? '✖ ' : ''}
              {gapText(m.i3.currentGap)}
            </Mono>
          )}
        </HStack>
      </HStack>
      <Mono size="12px" color={SEMANTIC_COLORS.textPrimary}>
        {exposedText(m, r.exposedMinUsd)}
      </Mono>
      <Mono size="11px" color={fired ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.textSecondary}>
        {gapStatus(m, r)}
      </Mono>
      {m.latest && (
        <Mono size="11px">
          oracle price() {usdPrice(m.latest.oracleUsd)} · DefiLlama {usdPrice(m.latest.marketUsd)}
          {m.latest.marketConfidence !== undefined
            ? ` (confidence ${m.latest.marketConfidence})`
            : ''}
        </Mono>
      )}
      <Mono size="11px">{heldText(m)}</Mono>
      <Box>
        <Box as="button" type="button" {...ACTION} onClick={() => onWatch(m.collateralSymbol)}>
          watch {m.collateralSymbol} in this feed →
        </Box>
        <Link href={`${ETHERSCAN}/address/${m.oracle}#readContract`} isExternal {...ACTION}>
          oracle ↗
        </Link>
      </Box>
    </Box>
  )
}

/** The retrospective record of the same rule, composed from i3Record.generated.json. */
const GapRecord: React.FC<{ r: OracleGapResponse }> = ({ r }) => (
  <Box>
    <Eyebrow>
      Record · {r.record.lane} {r.record.test.split(/\s/)[0]} · retrospective
    </Eyebrow>
    <Stack spacing={0} mt={SPACING.sm}>
      {recordLines(r.record).map((l) => (
        <Box
          key={`${l.label}|${l.date}`}
          py={SPACING.xs}
          borderBottom="1px solid"
          borderColor={SEMANTIC_COLORS.borderSubtle}
        >
          <Mono size="11px" color={SEMANTIC_COLORS.textTertiary}>
            {l.label}
            {l.date ? ` · ${l.date}` : ''}
          </Mono>
          <Mono size="12px" color={SEMANTIC_COLORS.textPrimary}>
            {l.value}
          </Mono>
        </Box>
      ))}
    </Stack>
    <Mono size="11px" color={SEMANTIC_COLORS.textTertiary}>
      {recordCaveats(r.record)}
    </Mono>
    <Text
      textAlign="right"
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize="11px"
      color={SEMANTIC_COLORS.textTertiary}
      mt={SPACING.xs}
      title={`results.json sha256 ${r.record.source.sha256}`}
    >
      {recordCredit(r.record)}
    </Text>
  </Box>
)

/** Finding: the headline in ink, or the hatched stale notice with the headline withheld. */
const GapFinding: React.FC<{ r: OracleGapResponse; collateral: string }> = ({ r, collateral }) => {
  const { meta, counts, constants } = r
  const line = thresholdText(constants)
  return (
    <>
      {meta.stale ? (
        <Box
          bgImage={HATCH}
          border="1px solid"
          borderColor={SEMANTIC_COLORS.borderSubtle}
          p={SPACING.md}
        >
          <Mono size="13px" color={SEMANTIC_COLORS.textPrimary}>
            ░ Stale · last point {durationText(meta.now - (meta.lastRunTs ?? 0))} ago. No finding
            until a new point.
          </Mono>
        </Box>
      ) : (
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.body}
          fontWeight={TYPOGRAPHY.medium}
          color={SEMANTIC_COLORS.textPrimary}
        >
          {i3Headline(counts.fired, constants)}
          {collateral ? ` · ${collateral}` : ''}
        </Text>
      )}
      {!meta.stale && counts.fired > 0 && (
        <Mono size="12px" color={SEMANTIC_COLORS.textPrimary}>
          {r.exposed.fired
            ? `Curated supply in ${r.exposed.fired} of them, last exposure read: ${usdWithBook(r.curatedUsd.fired, r.bookUsd.fired)}.`
            : `None holds $${r.exposedMinUsd} or more of curated supply (last exposure read).`}
        </Mono>
      )}
      <Mono size="11px">
        Oracle: price() at the head block, in loan token × DefiLlama&apos;s loan-token price.
        Market: DefiLlama&apos;s collateral price. Fires after {constants.persistenceHours} hourly
        points in a row at ≥ {line}. A revert, a price over {MARKET_HOLD_SECONDS / 3600} h old or a
        DefiLlama confidence under {MIN_PRICE_CONFIDENCE} is no point.
      </Mono>
      <Mono size="11px" color={SEMANTIC_COLORS.textTertiary}>
        {r.total} markets · {counts.fired} fired · {counts.building} above {line} for under{' '}
        {constants.persistenceHours} h · {counts.below} below · {counts.unobserved + counts.stale}{' '}
        without a point now · vaults as of block {meta.exposureBlock.toLocaleString()}
      </Mono>
    </>
  )
}

/** Evidence (markets above the line, or all on request) beside the record. */
const GapBody: React.FC<{ r: OracleGapResponse; onWatch: (symbol: string) => void }> = ({
  r,
  onWatch,
}) => {
  const [all, setAll] = useState(false)
  const [dust, setDust] = useState(false)
  // Stale: the markets that were above the line at their last point, hatched.
  const above = r.markets.filter((m) =>
    r.meta.stale
      ? m.i3.hoursAboveConsecutive > 0
      : m.i3.state === 'fired' || m.i3.state === 'building',
  )
  const shown = all ? r.markets : above
  // Markets without curated exposure sit below a one-line fold, never hidden.
  const held = shown.filter((m) => (m.curatedUsd ?? 0) >= r.exposedMinUsd)
  const unheld = shown.filter((m) => (m.curatedUsd ?? 0) < r.exposedMinUsd)
  return (
    <Box
      display="grid"
      gridTemplateColumns={{ base: '1fr', lg: 'minmax(0, 3fr) minmax(0, 2fr)' }}
      gap={SPACING.lg}
      mt={SPACING.sm}
    >
      <Box minW={0} bgImage={r.meta.stale ? HATCH : undefined}>
        {shown.length === 0 && !r.meta.stale && (
          <Mono size="11px">
            No market is {thresholdText(r.constants)} or more above its DefiLlama price at the
            newest point.
          </Mono>
        )}
        {held.map((m) => (
          <GapRow key={m.market} m={m} r={r} onWatch={onWatch} />
        ))}
        {unheld.length > 0 && (
          <Box mt={SPACING.sm}>
            <Chip active={dust} onClick={() => setDust(!dust)}>
              {dust ? 'hide' : 'show'} {unheld.length} more with under ${r.exposedMinUsd} of curated
              exposure
            </Chip>
          </Box>
        )}
        {dust && unheld.map((m) => <GapRow key={m.market} m={m} r={r} onWatch={onWatch} />)}
        {r.markets.length > above.length && (
          <Box mt={SPACING.sm}>
            <Chip onClick={() => setAll(!all)}>
              {all ? 'show fewer' : `show all ${r.markets.length}`}
            </Chip>
          </Box>
        )}
      </Box>
      <Box
        minW={0}
        borderTop={{ base: `1px solid ${SEMANTIC_COLORS.borderSubtle}`, lg: 'none' }}
        borderLeft={{ base: 'none', lg: `1px solid ${SEMANTIC_COLORS.borderSubtle}` }}
        pt={{ base: SPACING.sm, lg: 0 }}
        pl={{ base: 0, lg: SPACING.base }}
      >
        <GapRecord r={r} />
      </Box>
    </Box>
  )
}

const OracleGapSection: React.FC<{ collateral: string; onWatch: (symbol: string) => void }> = ({
  collateral,
  onWatch,
}) => {
  const { data, error, isLoading } = useQuery<OracleGapResponse>({
    queryKey: ['curator_oracle_gap', collateral],
    queryFn: () =>
      getJson(
        `/api/curator-feed?view=oracle-gap&limit=100${collateral ? `&collateral=${encodeURIComponent(collateral)}` : ''}`,
      ),
    staleTime: 5 * 60_000,
  })
  // The page renders client-side, so a #oracle-gap link lands before this section exists.
  useEffect(() => {
    if (data && window.location.hash === '#oracle-gap')
      document.getElementById('oracle-gap')?.scrollIntoView()
  }, [data])
  const meta = data?.meta
  return (
    <Box id="oracle-gap" scrollMarginTop="80px">
      <SectionHeading
        index="07"
        title="Oracle above market"
        note={
          meta?.lastRunTs !== undefined
            ? `measured · newest point block ${meta.lastRunBlock?.toLocaleString()} · ${utc(meta.lastRunTs)} (${durationText(meta.now - meta.lastRunTs)} ago) · ${meta.runs} hourly points`
            : undefined
        }
      />
      <Box minH="220px">
        {isLoading && <Mono>loading…</Mono>}
        {error && <Mono size="12px">Feed data unavailable.</Mono>}
        {data && !data.meta.measured && (
          <Mono size="12px" color={SEMANTIC_COLORS.textPrimary}>
            Not measured yet · the hourly collector adds a point each run.
          </Mono>
        )}
        {data?.meta.measured && (
          <>
            <GapFinding r={data} collateral={collateral} />
            <GapBody r={data} onWatch={onWatch} />
          </>
        )}
      </Box>
    </Box>
  )
}

// ── rows ───────────────────────────────────────────────────────────────────────

const ActionRow: React.FC<{ r: FeedRow; nowS: number }> = ({ r, nowS }) => (
  <Box
    borderLeft="2px solid"
    borderColor={TONE[r.tone]}
    pl={SPACING.sm}
    py={SPACING.xs}
    borderBottom="1px solid"
    borderBottomColor={SEMANTIC_COLORS.borderSubtle}
  >
    <HStack spacing={SPACING.sm} flexWrap="wrap" align="baseline">
      <Mono size="10px" color={SEMANTIC_COLORS.textTertiary}>
        {utc(r.ts)}
      </Mono>
      <Mono size="10px" color={SEMANTIC_COLORS.textTertiary}>
        {PROTOCOL[r.protocol]}
      </Mono>
      <Mono size="11px" color={SEMANTIC_COLORS.textPrimary} title={r.vault}>
        {r.vaultName}
      </Mono>
      <Mono size="10px">{r.curatorName}</Mono>
      <Tag tone={r.tone}>
        {r.inCluster ? `cluster · ${statusLabel(r, nowS)}` : statusLabel(r, nowS)}
      </Tag>
      {r.zeroTimelock.length > 0 && (
        <Box
          as="span"
          title={`Runs in one transaction at the last read: ${r.zeroTimelock.join(', ')}`}
        >
          <Tag tone="grey" wrap>
            {zeroText(r.zeroTimelock)}
          </Tag>
        </Box>
      )}
    </HStack>
    <Mono
      size="12px"
      color={r.tone === 'grey' ? SEMANTIC_COLORS.textSecondary : SEMANTIC_COLORS.textPrimary}
    >
      {r.text}{' '}
      <Link
        href={`${ETHERSCAN}/tx/${r.tx}`}
        isExternal
        color={SEMANTIC_COLORS.textTertiary}
        fontSize="10px"
      >
        tx ↗
      </Link>
    </Mono>
  </Box>
)

const ClusterCard: React.FC<{ c: ClusterView }> = ({ c }) => (
  <Box border="1px solid" borderColor={SEMANTIC_COLORS.danger} p={SPACING.md}>
    <HStack justify="space-between" align="baseline" flexWrap="wrap">
      <HStack spacing={SPACING.sm} align="baseline">
        <Tag tone="red">{c.claim.replace(/-/g, ' ')}</Tag>
        <Mono size="13px" color={SEMANTIC_COLORS.danger}>
          {c.text}
        </Mono>
      </HStack>
      <Mono size="10px" color={SEMANTIC_COLORS.textTertiary}>
        {utc(c.start)} → {utc(c.end)}
      </Mono>
    </HStack>
    <Mono size="11px">Curators: {c.curatorNames.join(', ')}</Mono>
    <Mono size="11px">Vaults: {c.vaultNames.join(', ')}</Mono>
    {c.protocolActionIds.length > 0 && (
      <Mono size="11px">
        Aave v3 also froze or set LTV 0 on {c.symbol} within the window (
        {c.protocolActionIds.length} action{c.protocolActionIds.length > 1 ? 's' : ''}).
      </Mono>
    )}
  </Box>
)

// ── sections ───────────────────────────────────────────────────────────────────

const VaultExposure: React.FC<{ collateral: string }> = ({ collateral }) => {
  const [open, setOpen] = useState<string | null>(null)
  const minUsd = collateral ? 0 : 1_000_000
  const { data, error, isLoading } = useQuery<{
    block: number
    ts: number
    vaults: VaultExposureView[]
  }>({
    queryKey: ['curator_exposure_vaults', collateral, minUsd],
    queryFn: () =>
      getJson(
        `/api/curator-feed?view=exposure&by=vault&minUsd=${minUsd}${collateral ? `&collateral=${encodeURIComponent(collateral)}` : ''}`,
      ),
    staleTime: 5 * 60_000,
  })
  return (
    <Stack spacing={0} mt={SPACING.sm}>
      {isLoading && <Mono>loading…</Mono>}
      {error && <Mono color={SEMANTIC_COLORS.danger}>{String((error as Error).message)}</Mono>}
      {data?.vaults.slice(0, 80).map((v) => (
        <Box key={v.vault} borderBottom="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}>
          <HStack
            as="button"
            type="button"
            w="100%"
            justify="space-between"
            py={SPACING.xs}
            onClick={() => setOpen(open === v.vault ? null : v.vault)}
            aria-expanded={open === v.vault}
          >
            <Mono size="12px" color={SEMANTIC_COLORS.textPrimary} title={v.vault}>
              {open === v.vault ? '▾' : '▸'} {v.vaultName}{' '}
              <Text as="span" color={SEMANTIC_COLORS.textTertiary}>
                · {v.curatorName} · {PROTOCOL[v.protocol]}
              </Text>
            </Mono>
            <Mono size="11px">
              {v.liveUsd !== undefined ? `$${compact(v.liveUsd)}` : v.loanSymbol}
              {v.lockedUsd ? ` + $${compact(v.lockedUsd)} book value` : ''}
              {v.lostUsd ? ` + $${compact(v.lostUsd)} written off` : ''} · {v.allocations.length}{' '}
              allocation{v.allocations.length === 1 ? '' : 's'}
            </Mono>
          </HStack>
          {open === v.vault && (
            <Box pl={SPACING.base} pb={SPACING.sm}>
              {(v.lockedUsd || v.lostUsd) && v.totalUsd !== undefined ? (
                <Mono size="10.5px" color={SEMANTIC_COLORS.textTertiary}>
                  totalAssets() reports ${compact(v.totalUsd)}
                  {v.lockedUsd
                    ? `; $${compact(v.lockedUsd)} of it is supply in markets whose supply is locked (book value)`
                    : ''}
                  {v.lostUsd
                    ? `; $${compact(v.lostUsd)} of it is lostAssets(), written off and still counted (MetaMorpho v1.1)`
                    : ''}
                  .
                </Mono>
              ) : null}
              {Object.keys(v.timelocks).length > 0 && (
                <Mono size="10.5px" color={SEMANTIC_COLORS.textTertiary}>
                  Timelocks at the last read:{' '}
                  {Object.entries(v.timelocks)
                    .map(
                      ([f, sec]) => `${f} ${sec === 0 ? '0 (one transaction)' : durationText(sec)}`,
                    )
                    .join(' · ')}
                </Mono>
              )}
              {v.allocations.map((a) => (
                <HStack key={`${a.target}:${a.via ?? ''}`} justify="space-between" flexWrap="wrap">
                  <Mono size="11px" color={SEMANTIC_COLORS.textPrimary} title={a.target}>
                    {a.targetName}
                    {a.via ? (
                      <Text as="span" color={SEMANTIC_COLORS.textTertiary}>
                        {' '}
                        · via {a.via.slice(0, 6)}…{a.via.slice(-4)}
                      </Text>
                    ) : null}
                    {a.flags?.map((f) => (
                      <Box as="span" key={f} ml="6px">
                        <Tag tone="amber" wrap>
                          {f}
                        </Tag>
                      </Box>
                    ))}
                  </Mono>
                  <Mono size="11px">
                    {compact(a.amount)} {v.loanSymbol}
                    {a.usd !== undefined
                      ? ` ($${compact(a.usd)}${a.locked ? ' book value' : ''})`
                      : ''}{' '}
                    · {(a.share * 100).toFixed(1)}%
                  </Mono>
                </HStack>
              ))}
            </Box>
          )}
        </Box>
      ))}
    </Stack>
  )
}

const ExposureSection: React.FC<{ collateral: string }> = ({ collateral }) => {
  const [by, setBy] = useState<'collateral' | 'vault'>('collateral')
  const [open, setOpen] = useState<string | null>(null)
  const minUsd = collateral ? 0 : 1_000_000
  const { data, error, isLoading } = useQuery<ExposureResponse>({
    queryKey: ['curator_exposure', collateral, minUsd],
    queryFn: () =>
      getJson(
        `/api/curator-feed?view=exposure&minUsd=${minUsd}${collateral ? `&collateral=${encodeURIComponent(collateral)}` : ''}`,
      ),
    staleTime: 5 * 60_000,
  })
  return (
    <Box>
      <SectionHeading
        index="04"
        title="Who holds which collateral"
        note={data ? `head block ${data.block} · ${utc(data.ts)}` : undefined}
      />
      <Mono size="11px">
        Supply each vault has in markets backed by the collateral (Morpho Blue positions, Vault V2
        adapters, Euler Earn strategies) at the head block. USD at collection-time prices. Supply in
        a market whose supply is locked (flag below) is book value and is shown apart. MetaMorpho
        v1.1 vaults count written-off assets (lostAssets) in totalAssets; the vault view shows them
        apart.
        {!collateral && ' Rows of at least $1M shown; filter by a symbol to see all.'}
      </Mono>
      <HStack mt={SPACING.sm} spacing={SPACING.sm}>
        <Chip active={by === 'collateral'} onClick={() => setBy('collateral')}>
          by collateral
        </Chip>
        <Chip active={by === 'vault'} onClick={() => setBy('vault')}>
          by vault
        </Chip>
      </HStack>
      {by === 'vault' && <VaultExposure collateral={collateral} />}
      {by === 'collateral' && isLoading && <Mono>loading…</Mono>}
      {by === 'collateral' && error && (
        <Mono color={SEMANTIC_COLORS.danger}>{String((error as Error).message)}</Mono>
      )}
      <Stack spacing={0} mt={SPACING.sm} display={by === 'collateral' ? 'flex' : 'none'}>
        {data?.rows.slice(0, 60).map((row) => (
          <Box
            key={row.collateral}
            borderBottom="1px solid"
            borderColor={SEMANTIC_COLORS.borderSubtle}
          >
            <HStack
              as="button"
              type="button"
              w="100%"
              justify="space-between"
              py={SPACING.xs}
              onClick={() => setOpen(open === row.collateral ? null : row.collateral)}
              aria-expanded={open === row.collateral}
            >
              <Mono size="12px" color={SEMANTIC_COLORS.textPrimary}>
                {open === row.collateral ? '▾' : '▸'} {row.symbol}
              </Mono>
              <Mono size="11px">
                ${compact(row.usd)}
                {row.lockedUsd ? ` + $${compact(row.lockedUsd)} book value` : ''}
                {row.unpriced ? ` + ${row.unpriced} unpriced` : ''} · {row.holders.length} vault
                {row.holders.length === 1 ? '' : 's'} · {row.curatorCount} curator
                {row.curatorCount === 1 ? '' : 's'}
              </Mono>
            </HStack>
            {open === row.collateral && (
              <Box pl={SPACING.base} pb={SPACING.sm}>
                {row.holders.map((h) => (
                  <HStack key={h.vault} justify="space-between" flexWrap="wrap">
                    <Mono size="11px" color={SEMANTIC_COLORS.textPrimary} title={h.vault}>
                      {h.vaultName}{' '}
                      <Text as="span" color={SEMANTIC_COLORS.textTertiary}>
                        · {h.curatorName} · {PROTOCOL[h.protocol]}
                      </Text>
                    </Mono>
                    <Mono size="11px">
                      {compact(h.amount)} {h.loanSymbol}
                      {h.usd !== undefined
                        ? ` ($${compact(h.usd)}${h.lockedUsd ? ` incl. $${compact(h.lockedUsd)} book value` : ''})`
                        : ''}{' '}
                      · {(h.shareOfVault * 100).toFixed(1)}% of vault
                    </Mono>
                  </HStack>
                ))}
              </Box>
            )}
          </Box>
        ))}
      </Stack>
    </Box>
  )
}

const AttributionSection: React.FC<{
  collateral: string
  threshold?: number
  keptDrop?: number
}> = ({ collateral, threshold, keptDrop }) => {
  const [limit, setLimit] = useState(25)
  const { data, error, isLoading } = useQuery<{ rows: AttributionView[]; total: number }>({
    queryKey: ['curator_attribution', collateral, limit],
    queryFn: () =>
      getJson(
        `/api/curator-feed?view=attribution&limit=${limit}${collateral ? `&collateral=${encodeURIComponent(collateral)}` : ''}`,
      ),
    staleTime: 5 * 60_000,
    placeholderData: (prev) => prev,
  })
  const shown = data?.rows ?? []
  const total = data?.total ?? 0
  return (
    <Box>
      <SectionHeading
        index="05"
        title="Vault withdrawals that moved a market"
        note={`${total.toLocaleString()} blocks · claim class: observed driver`}
      />
      <Mono size="11px">
        Blocks where vault reallocations withdrew at least ${compact(threshold ?? 1_000_000)} (net,
        per transaction) from a Morpho Blue market and the market’s supply fell by{' '}
        {((keptDrop ?? 0.2) * 100).toFixed(0)}% or more, the borrow rate jumped (≥ 1.5× and ≥ +2 APR
        points), or utilization ended at 99% or above. Figures compare the end of block b−1 with the
        end of block b; other transactions in the block are included. APR is simple (rate × seconds
        per year).
      </Mono>
      {isLoading && <Mono>loading…</Mono>}
      {error && <Mono color={SEMANTIC_COLORS.danger}>{String((error as Error).message)}</Mono>}
      <Stack spacing={0} mt={SPACING.sm}>
        {shown.map((a) => (
          <Box
            key={`${a.market}:${a.block}`}
            borderLeft="2px solid"
            borderColor={
              a.spike || a.drained ? SEMANTIC_COLORS.warning : SEMANTIC_COLORS.borderSubtle
            }
            pl={SPACING.sm}
            py={SPACING.xs}
            borderBottom="1px solid"
            borderBottomColor={SEMANTIC_COLORS.borderSubtle}
          >
            <HStack spacing={SPACING.sm}>
              <Mono size="10px" color={SEMANTIC_COLORS.textTertiary}>
                {utc(a.ts)}
              </Mono>
              {a.spike && <Tag tone="amber">rate spike</Tag>}
              {a.drained && <Tag tone="amber">utilization ≥ 99%</Tag>}
            </HStack>
            <Mono size="12px" color={SEMANTIC_COLORS.textPrimary}>
              {a.text}{' '}
              <Link
                href={`${ETHERSCAN}/tx/${a.tx}`}
                isExternal
                color={SEMANTIC_COLORS.textTertiary}
                fontSize="10px"
              >
                tx ↗
              </Link>
            </Mono>
          </Box>
        ))}
      </Stack>
      {total > shown.length && (
        <Box mt={SPACING.sm}>
          <Chip onClick={() => setLimit(Math.min(500, limit + 100))}>
            {limit >= 500 ? 'filter to see more' : `show more (${total - shown.length} left)`}
          </Chip>
        </Box>
      )}
    </Box>
  )
}

const DRIVER: Record<string, string> = {
  'vault-reallocation': 'vault reallocation',
  'vault-redemption': 'vault redemption',
  'vault-deposit': 'vault deposit',
  'supplier-withdrawal': 'supplier withdrawal',
  'supplier-deposit': 'supplier deposit',
  borrow: 'new borrows',
  repay: 'repayments',
  liquidation: 'liquidation',
  'bad-debt': 'bad debt',
}

const SpikeSection: React.FC<{ collateral: string; minSupply?: number }> = ({
  collateral,
  minSupply,
}) => {
  const [only, setOnly] = useState<'' | 'reallocation' | 'drained'>('reallocation')
  const [minUsd, setMinUsd] = useState(10_000_000)
  const [limit, setLimit] = useState(25)
  const params = useMemo(() => {
    const p = new URLSearchParams({ view: 'spikes', minUsd: String(minUsd), limit: String(limit) })
    if (only) p.set('only', only)
    if (collateral) p.set('collateral', collateral)
    return p.toString()
  }, [collateral, only, minUsd, limit])
  const { data, error, isLoading } = useQuery<{ rows: SpikeView[]; total: number }>({
    queryKey: ['curator_spikes', params],
    queryFn: () => getJson(`/api/curator-feed?${params}`),
    staleTime: 5 * 60_000,
    placeholderData: (prev) => prev,
  })
  const rows = data?.rows ?? []
  return (
    <Box>
      <SectionHeading
        index="06"
        title="Borrow-rate spikes and who moved the market"
        note={`${(data?.total ?? 0).toLocaleString()} blocks · claim class: observed driver`}
      />
      <Mono size="11px">
        Morpho Blue markets that curated vaults use, where the borrow rate the market charged jumped
        (≥ 1.5× and ≥ +2 APR points) between two consecutive accruals, with at least $
        {compact(minSupply ?? 1_000_000)} supplied before. Every supply, withdrawal, borrow,
        repayment and liquidation in the block that set the new rate is listed. A vault withdrawal
        counts as a reallocation when the same transaction holds the allocator’s reallocation leg,
        else as a redemption. Shares (≈) are first-order effects on utilization at the state before
        the block, among the flows that pushed it up.
      </Mono>
      <HStack mt={SPACING.sm} spacing={SPACING.sm} flexWrap="wrap">
        <Chip active={only === 'reallocation'} onClick={() => setOnly('reallocation')}>
          reallocation-led
        </Chip>
        <Chip active={only === 'drained'} onClick={() => setOnly('drained')}>
          utilization ≥ 99%
        </Chip>
        <Chip active={only === ''} onClick={() => setOnly('')}>
          all drivers
        </Chip>
        <Mono size="10px" color={SEMANTIC_COLORS.textTertiary}>
          market supply ≥
        </Mono>
        {[1_000_000, 10_000_000, 50_000_000].map((x) => (
          <Chip key={x} active={minUsd === x} onClick={() => setMinUsd(x)}>
            ${compact(x)}
          </Chip>
        ))}
      </HStack>
      {isLoading && <Mono>loading…</Mono>}
      {error && <Mono color={SEMANTIC_COLORS.danger}>{String((error as Error).message)}</Mono>}
      {data && rows.length === 0 && (
        <Mono size="11px">No spike matches these filters in the collected range.</Mono>
      )}
      <Stack spacing={0} mt={SPACING.sm}>
        {rows.map((s) => (
          <Box
            key={`${s.market}:${s.block}`}
            borderLeft="2px solid"
            borderColor={
              s.top === 'vault-reallocation'
                ? SEMANTIC_COLORS.warning
                : SEMANTIC_COLORS.borderSubtle
            }
            pl={SPACING.sm}
            py={SPACING.xs}
            borderBottom="1px solid"
            borderBottomColor={SEMANTIC_COLORS.borderSubtle}
          >
            <HStack spacing={SPACING.sm} flexWrap="wrap">
              <Mono size="10px" color={SEMANTIC_COLORS.textTertiary}>
                {utc(s.ts)}
              </Mono>
              {s.supplyUsd !== undefined && (
                <Mono size="10px" color={SEMANTIC_COLORS.textTertiary}>
                  supply ${compact(s.supplyUsd)}
                </Mono>
              )}
              {s.top && (
                <Tag tone={s.top === 'vault-reallocation' ? 'amber' : 'grey'}>
                  {DRIVER[s.top]} ≈ {Math.round((s.topShare ?? 0) * 100)}%
                </Tag>
              )}
              {(s.utilAfter ?? 0) >= 0.99 && <Tag tone="amber">utilization ≥ 99%</Tag>}
            </HStack>
            <Mono size="12px" color={SEMANTIC_COLORS.textPrimary}>
              {s.text}{' '}
              {uniqTx(s).map((tx, i) => (
                <Link
                  key={tx}
                  href={`${ETHERSCAN}/tx/${tx}`}
                  isExternal
                  color={SEMANTIC_COLORS.textTertiary}
                  fontSize="10px"
                  mr="4px"
                >
                  tx{i ? i + 1 : ''} ↗
                </Link>
              ))}
            </Mono>
          </Box>
        ))}
      </Stack>
      {data && data.total > rows.length && (
        <Box mt={SPACING.sm}>
          <Chip onClick={() => setLimit(Math.min(500, limit + 50))}>
            {limit >= 500 ? 'filter to see more' : `show more (${data.total - rows.length} left)`}
          </Chip>
        </Box>
      )}
    </Box>
  )
}

const FLAG_TAG: Record<string, string> = {
  'oracle-fixed': 'fixed-price oracle',
  'oracle-reported': 'reported-value oracle',
  'oracle-reverting': 'oracle reverting',
  'oracle-stale': 'oracle stale',
  'one-borrower': 'one borrower',
  'supply-locked': 'supply locked',
}

const FlagsSection: React.FC<{ collateral: string }> = ({ collateral }) => {
  const [held, setHeld] = useState(true)
  const [allMarkets, setAllMarkets] = useState(false)
  const { data, error, isLoading } = useQuery<{
    block?: number
    ts?: number
    markets: MarketFlagView[]
    shifts: ShiftView[]
  }>({
    queryKey: ['curator_flags', collateral],
    queryFn: () =>
      getJson(
        `/api/curator-feed?view=flags${collateral ? `&collateral=${encodeURIComponent(collateral)}` : ''}`,
      ),
    staleTime: 5 * 60_000,
  })
  const markets = (data?.markets ?? []).filter(
    (m) => !held || m.kinds.includes('oracle-reverting') || (m.curatedUsd ?? 0) > 0,
  )
  const shownMarkets = allMarkets ? markets : markets.slice(0, 20)
  return (
    <Box>
      <SectionHeading
        index="08"
        title="Market and curator flags"
        note={
          data?.block ? `block ${data.block.toLocaleString()} · ${utc(data.ts ?? 0)}` : undefined
        }
      />
      <Mono size="11px">
        Facts that kept depositors from leaving in the 2026 msY and AZND write-offs, read for every
        market curated vaults use: an oracle with no market price in its path (a fixed price, or
        only reported values such as a NAV feed); an oracle whose price() reverts, or whose feed
        stopped updating; one address owing most of a market&apos;s borrows. From the 2025 sdeUSD
        write-offs: a market fully borrowed for 7 days with no working market price, whose supply
        grows as book value. And one curator moving a position between its own vaults, then cutting
        it in the vaults that gave it up.
      </Mono>
      {isLoading && <Mono>loading…</Mono>}
      {error && <Mono color={SEMANTIC_COLORS.danger}>{String((error as Error).message)}</Mono>}
      {data && (
        <>
          <HStack mt={SPACING.sm} spacing={SPACING.sm} flexWrap="wrap">
            <Chip active={held} onClick={() => setHeld(true)}>
              held by curated vaults or reverting
            </Chip>
            <Chip active={!held} onClick={() => setHeld(false)}>
              all flagged markets
            </Chip>
            <Mono size="10px" color={SEMANTIC_COLORS.textTertiary}>
              {markets.length} markets · {data.shifts.length} curator shifts
            </Mono>
          </HStack>
          <Stack spacing={0} mt={SPACING.sm}>
            {shownMarkets.map((m) => (
              <Box
                key={m.market}
                borderLeft="2px solid"
                borderColor={
                  m.kinds.includes('oracle-reverting')
                    ? SEMANTIC_COLORS.danger
                    : SEMANTIC_COLORS.warning
                }
                pl={SPACING.sm}
                py={SPACING.xs}
                borderBottom="1px solid"
                borderBottomColor={SEMANTIC_COLORS.borderSubtle}
              >
                <HStack spacing={SPACING.sm} flexWrap="wrap" align="baseline">
                  <Mono size="12px" color={SEMANTIC_COLORS.textPrimary} title={m.market}>
                    {m.marketName}
                  </Mono>
                  {m.kinds.map((k) => (
                    <Tag key={k} tone={k === 'oracle-reverting' ? 'red' : 'amber'}>
                      {FLAG_TAG[k] ?? k}
                    </Tag>
                  ))}
                  {m.curatedUsd !== undefined && (
                    <Mono size="10px" color={SEMANTIC_COLORS.textTertiary}>
                      curated supply ${compact(m.curatedUsd)}
                      {m.kinds.includes('supply-locked') ? ' (book value)' : ''} · {m.vaults.length}{' '}
                      vault
                      {m.vaults.length === 1 ? '' : 's'}
                    </Mono>
                  )}
                </HStack>
                {m.texts.map((t) => (
                  <Mono key={t} size="11.5px" color={SEMANTIC_COLORS.textPrimary}>
                    {t}
                  </Mono>
                ))}
                {m.vaults.length > 0 && (
                  <Mono size="10.5px" color={SEMANTIC_COLORS.textTertiary}>
                    Held by:{' '}
                    {m.vaults
                      .slice(0, 6)
                      .map(
                        (v) =>
                          `${v.vaultName} (${v.curatorName}) ${(v.share * 100).toFixed(1)}% of vault` +
                          (m.kinds.includes('one-borrower') && v.borrowerShare !== undefined
                            ? `, ≈ ${Math.round(v.borrowerShare * 100)}% lent to that borrower`
                            : ''),
                      )
                      .join(' · ')}
                    {m.vaults.length > 6 ? ` · +${m.vaults.length - 6} more` : ''}
                  </Mono>
                )}
              </Box>
            ))}
          </Stack>
          {markets.length > 20 && (
            <Box mt={SPACING.sm}>
              <Chip onClick={() => setAllMarkets(!allMarkets)}>
                {allMarkets ? 'show fewer' : `show all ${markets.length}`}
              </Chip>
            </Box>
          )}
          <Mono size="11px" color={SEMANTIC_COLORS.textSecondary}>
            Curator shifts (claim class: possible leading signal):{' '}
            {data.shifts.length === 0 ? 'none in the collected range.' : ''}
          </Mono>
          <Stack spacing={0} mt={SPACING.xs}>
            {data.shifts.map((x) => (
              <Box
                key={`${x.market}:${x.day}:${x.curatorName}`}
                borderLeft="2px solid"
                borderColor={SEMANTIC_COLORS.warning}
                pl={SPACING.sm}
                py={SPACING.xs}
                borderBottom="1px solid"
                borderBottomColor={SEMANTIC_COLORS.borderSubtle}
              >
                <Mono size="10px" color={SEMANTIC_COLORS.textTertiary}>
                  {x.day}
                </Mono>
                <Mono size="11.5px" color={SEMANTIC_COLORS.textPrimary}>
                  {x.text}
                </Mono>
              </Box>
            ))}
          </Stack>
        </>
      )}
    </Box>
  )
}

/** Transactions behind the drivers that pushed utilization up (largest first), max 3. */
const uniqTx = (s: SpikeView): string[] =>
  [...new Set(s.drivers.filter((d) => d.share > 0).map((d) => d.tx))].slice(0, 3)

// ── page body ──────────────────────────────────────────────────────────────────

export const CuratorFeed: React.FC = () => {
  const [collateralInput, setCollateralInput] = useState('')
  const [collateral, setCollateral] = useState('')
  const [group, setGroup] = useState<Group>('all')
  const [windowH, setWindowH] = useState(72)
  const [limit, setLimit] = useState(100)
  const params = useMemo(() => {
    const p = new URLSearchParams({ group, window: String(windowH), limit: String(limit) })
    if (collateral) p.set('collateral', collateral)
    return p.toString()
  }, [collateral, group, windowH, limit])
  const { data, error, isLoading, isFetching } = useQuery<FeedResponse>({
    queryKey: ['curator_feed', params],
    queryFn: () => getJson(`/api/curator-feed?${params}`),
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  })
  const nowS = data?.meta.now ?? Math.floor(Date.now() / 1000)
  const m = data?.meta
  const [showExecutable, setShowExecutable] = useState(false)
  // "watch this market": filter every section to its collateral and go to the top.
  const watch = useCallback((symbol: string) => {
    setCollateralInput(symbol)
    setCollateral(symbol)
    window.scrollTo({ top: 0 })
  }, [])
  const pending = data?.open.filter((r) => r.status === 'pending') ?? []
  const executable = data?.open.filter((r) => r.status === 'executable') ?? []

  return (
    <Box maxW="1100px" mx="auto" px={SPACING.base} py={SPACING.lg}>
      <Eyebrow>Risk tooling · Ethereum mainnet</Eyebrow>
      <Text
        fontFamily={TYPOGRAPHY.fontDisplay}
        fontSize={TYPOGRAPHY.h1}
        color={SEMANTIC_COLORS.textPrimary}
      >
        Curator action feed
      </Text>
      <Mono size="12px">
        Supply-cap changes, market removals, write-offs, queue changes, timelock and role changes by
        MetaMorpho, Morpho Vault V2 and Euler Earn curators, with Aave v3 cap / freeze changes as
        the protocol-level comparison. Amber: a submitted change still inside its timelock window
        (or past it and not yet executed). Grey: history. Red: the same collateral exited by two or
        more curators inside the window.
      </Mono>
      {m && (
        <Stamp>
          blocks {m.fromBlock.toLocaleString()}–{m.toBlock.toLocaleString()} · {utc(m.fromTs)} →{' '}
          {utc(m.toTs)} · collected {m.collectedAt.slice(0, 16).replace('T', ' ')} UTC ·{' '}
          {m.logs.chunks.toLocaleString()} log ranges, {m.logs.rechecked.toLocaleString()} re-read
          on a second endpoint, {m.logs.recovered.toLocaleString()} logs recovered by the re-read
          {m.lastRun
            ? ` · last run ${m.lastRun.mode}, blocks ${m.lastRun.fromBlock.toLocaleString()}–${m.lastRun.toBlock.toLocaleString()}`
            : ''}
        </Stamp>
      )}

      <HStack mt={SPACING.base} spacing={SPACING.sm} flexWrap="wrap">
        <Input
          size="sm"
          w="200px"
          borderRadius={0}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="12px"
          placeholder="collateral: rsETH or 0x…"
          value={collateralInput}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCollateralInput(e.target.value)}
          onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) =>
            e.key === 'Enter' && setCollateral(collateralInput.trim())
          }
          onBlur={() => setCollateral(collateralInput.trim())}
          aria-label="Filter by collateral symbol or address"
        />
        {GROUPS.map((g) => (
          <Chip key={g.key} active={group === g.key} onClick={() => setGroup(g.key)}>
            {g.label}
          </Chip>
        ))}
        <Mono size="10px" color={SEMANTIC_COLORS.textTertiary}>
          cluster window
        </Mono>
        {[24, 48, 72].map((h) => (
          <Chip key={h} active={windowH === h} onClick={() => setWindowH(h)}>
            {h}h
          </Chip>
        ))}
        {isFetching && <Mono size="10px">updating…</Mono>}
      </HStack>

      {error && (
        <Mono color={SEMANTIC_COLORS.danger} size="12px">
          {String((error as Error).message)}
        </Mono>
      )}
      {isLoading && <Mono>loading…</Mono>}

      {data && (
        <>
          <SectionHeading
            index="01"
            title="Clustered exits"
            note={`≥ 2 curators · ${windowH}h window · claim class: possible leading signal`}
          />
          <Mono size="11px">
            An exit counts when a vault set a cap to 0, submitted a forced removal, removed a market
            from its withdraw queue, or wrote off a Vault V2 adapter position (burnShares), and kept
            no other market with that collateral capped (read at the exit’s block). A cap moved to a
            new market with the same collateral is a migration and does not count; neither does a PT
            exit within 14 days of its maturity.
          </Mono>
          {data.clusters.length === 0 ? (
            <Mono size="11px">
              No collateral was exited by two or more curators inside a {windowH}h window in this
              range{collateral ? ` for ${collateral}` : ''}.
            </Mono>
          ) : (
            <Stack spacing={SPACING.sm}>
              {[...data.clusters]
                .sort((a, b) => b.curators.length - a.curators.length || b.end - a.end)
                .map((c) => (
                  <ClusterCard key={`${c.collateral}:${c.start}`} c={c} />
                ))}
            </Stack>
          )}

          <SectionHeading
            index="02"
            title="In a timelock window"
            note={`${pending.length} pending`}
          />
          {pending.length === 0 ? (
            <Mono size="11px">
              No submitted change is inside its timelock window
              {collateral ? ` for ${collateral}` : ''}.
            </Mono>
          ) : (
            <Box>
              {pending.map((r) => (
                <ActionRow key={r.id} r={r} nowS={nowS} />
              ))}
            </Box>
          )}
          {executable.length > 0 && (
            <Box mt={SPACING.sm}>
              <Chip active={showExecutable} onClick={() => setShowExecutable(!showExecutable)}>
                {showExecutable ? 'hide' : 'show'} {executable.length} submitted, window elapsed,
                not executed
              </Chip>
              {showExecutable && (
                <Box mt={SPACING.xs}>
                  <Mono size="10.5px">
                    These can still be executed at any time; the contract keeps them pending until
                    executed or revoked.
                  </Mono>
                  {executable.map((r) => (
                    <ActionRow key={r.id} r={r} nowS={nowS} />
                  ))}
                </Box>
              )}
            </Box>
          )}

          <SectionHeading index="03" title="Feed" note={`${data.total.toLocaleString()} actions`} />
          <Box>
            {data.rows.map((r) => (
              <ActionRow key={r.id} r={r} nowS={nowS} />
            ))}
          </Box>
          {data.nextBefore && (
            <Box mt={SPACING.sm}>
              <Chip onClick={() => setLimit(Math.min(500, limit + 100))}>
                {limit >= 500 ? 'filter to see older actions' : 'show more'}
              </Chip>
            </Box>
          )}
        </>
      )}

      <ExposureSection collateral={collateral} />
      <AttributionSection
        collateral={collateral}
        threshold={m?.thresholds.largeWithdrawUsd}
        keptDrop={m?.thresholds.keptSupplyDrop}
      />
      <SpikeSection collateral={collateral} minSupply={m?.thresholds.spikeMinSupplyUsd} />
      <OracleGapSection collateral={collateral} onWatch={watch} />
      <FlagsSection collateral={collateral} />

      {m && (
        <Card variant="subtle" mt={SPACING.xl} p={SPACING.base}>
          <Eyebrow>Sources and limits</Eyebrow>
          {[...m.sources, ...m.caveats].map((s) => (
            <Mono key={s} size="10.5px">
              · {s}
            </Mono>
          ))}
        </Card>
      )}
    </Box>
  )
}

// ── compact card ─────────────────────────────────────────────────────────────────
// Mounted on data pages (the Today edition's Safety body; the venue page), so it
// follows the newspaper rules (membrane-board design/DESIGN_RULES.md) on every page it
// sits on: a hairline rule instead of a filled card, no amber (amber means only the 8h
// window: a pending timelock is ink), red with ✖ only for a cluster of exits (curated
// capital leaving), muted ink for history, nothing under 11px, 44px targets. Its
// colours are the app tokens, so it reads in both app themes and inside the edition.

const CARD_LABEL = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: '11px',
  lineHeight: '16px',
  letterSpacing: '0.12em',
  textTransform: 'uppercase' as const,
}

/** The card's short form of a cluster ("2 curators exited LBTC within 15h"); the full
 *  sentence (lib/curatorFeed/service.ts clusterText) is its tooltip and on the full page. */
const clusterLine = (c: ClusterView): string => {
  const h = c.tightestHours < 1 ? '<1h' : `${Math.round(c.tightestHours)}h`
  const unread = c.text.includes('remaining caps not read') ? ' · caps partly unread' : ''
  return `${c.curators.length} curators exited ${c.symbol} within ${h}${unread}`
}

const CardRow: React.FC<{ r: FeedRow; nowS: number }> = ({ r, nowS }) => {
  const red = r.tone === 'red'
  const history = r.tone === 'grey'
  const status = r.inCluster ? `cluster · ${statusLabel(r, nowS)}` : statusLabel(r, nowS)
  return (
    <Box borderBottom="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} py={SPACING.sm}>
      <HStack spacing={SPACING.sm} flexWrap="wrap" align="baseline">
        <Mono size="11px" as="span" color={SEMANTIC_COLORS.textTertiary}>
          {utc(r.ts)}
        </Mono>
        <Mono size="11px" as="span" color={SEMANTIC_COLORS.textTertiary}>
          {PROTOCOL[r.protocol]}
        </Mono>
        <Mono size="13px" as="span" color={SEMANTIC_COLORS.textPrimary} title={r.vault}>
          {r.vaultName}
        </Mono>
        <Mono size="11px" as="span" title={r.curatorName}>
          {/* An unnamed curator is its address: shortened, so it never takes a line. */}
          {/^0x[0-9a-fA-F]{40}$/.test(r.curatorName) ? `${r.curatorName.slice(0, 6)}…${r.curatorName.slice(-4)}` : r.curatorName}
        </Mono>
      </HStack>
      <Text
        {...CARD_LABEL}
        color={red ? SEMANTIC_COLORS.danger : history ? SEMANTIC_COLORS.textSecondary : SEMANTIC_COLORS.textPrimary}
        overflowWrap="anywhere"
      >
        {red && (
          <Box as="span" aria-hidden="true" mr="0.4em">
            ✖
          </Box>
        )}
        {status}
        {r.zeroTimelock.length > 0 && (
          <Box as="span" color={SEMANTIC_COLORS.textSecondary} title={`Runs in one transaction at the last read: ${r.zeroTimelock.join(', ')}`}>
            {' · '}
            {zeroText(r.zeroTimelock)}
          </Box>
        )}
      </Text>
      <Mono size="13px" color={history ? SEMANTIC_COLORS.textSecondary : SEMANTIC_COLORS.textPrimary}>
        {r.text}{' '}
        <Link
          href={`${ETHERSCAN}/tx/${r.tx}`}
          isExternal
          display="inline-block"
          py="14px"
          my="-14px"
          px="4px"
          fontSize="11px"
          color={SEMANTIC_COLORS.textSecondary}
        >
          tx ↗
        </Link>
      </Mono>
    </Box>
  )
}

/** The oracle-gap state in one line, from ?view=oracle-gap: ink; red with ✖ only when a
 *  market has fired (its oracle priced the collateral ≥ 2% above market for 24 h: a latent
 *  loss); ░ when the series is stale. No amber, nothing under 11px, a 44px target. */
const OracleGapLine: React.FC<{ r: OracleGapResponse; href: string }> = ({ r, href }) => {
  const m = r.meta
  const fired = m.measured && !m.stale && r.counts.fired > 0
  const text = !m.measured
    ? 'Oracle gap: not measured yet.'
    : m.stale
      ? `Oracle gap: last point ${durationText(m.now - (m.lastRunTs ?? 0))} ago.`
      : i3Headline(r.counts.fired, r.constants) +
        (r.exposed.fired
          ? ` · curated supply ${usdWithBook(r.curatedUsd.fired, r.bookUsd.fired)}`
          : '')
  return (
    <Box borderBottom="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}>
      <Link
        as={NextLink}
        href={href}
        display="inline-flex"
        alignItems="center"
        minH="44px"
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="13px"
        color={fired ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.textPrimary}
        _focusVisible={FOCUS_STYLES.ring}
      >
        {(fired || (m.measured && m.stale)) && (
          <Box as="span" aria-hidden="true" mr="0.4em">
            {fired ? '✖' : '░'}
          </Box>
        )}
        {text} →
      </Link>
    </Box>
  )
}

/** Compact feed: open exit clusters, the oracle-gap state, the next timelocks to elapse,
 *  the latest exits. Links to the full page. */
export const CuratorFeedCard: React.FC = () => {
  const { chainName } = useChainRoute()
  const { data, isError } = useQuery<FeedResponse>({
    queryKey: ['curator_feed_card'],
    queryFn: () => getJson('/api/curator-feed?group=exits&limit=5'),
    staleTime: 5 * 60_000,
    // A missing dataset is a 503, not a blip: say so after one retry, not four.
    retry: 1,
  })
  const { data: gap } = useQuery<OracleGapResponse>({
    queryKey: ['curator_oracle_gap_card'],
    queryFn: () => getJson('/api/curator-feed?view=oracle-gap&limit=1'),
    staleTime: 5 * 60_000,
    retry: 1,
  })
  const nowS = data?.meta.now ?? Math.floor(Date.now() / 1000)
  const pending = data?.open.filter((r) => r.status === 'pending') ?? []
  const empty = !!data && data.clusters.length === 0 && pending.length === 0 && data.rows.length === 0
  const collected = data ? Date.parse(data.meta.collectedAt) : NaN
  return (
    <Box
      as="section"
      aria-label="Curator actions"
      borderTop="1px solid"
      borderColor={SEMANTIC_COLORS.borderStrong}
      pt={SPACING.sm}
    >
      <Text {...CARD_LABEL} color={SEMANTIC_COLORS.textSecondary}>
        Curator actions
      </Text>
      {/* Unavailable is said in words, never left as an endless "loading…". */}
      {!data && !isError && <Mono size="13px">—</Mono>}
      {!data && isError && (
        <Mono size="13px" color={SEMANTIC_COLORS.textPrimary}>
          <Box as="span" aria-hidden="true" mr="0.4em">
            ░
          </Box>
          Feed unavailable.
        </Mono>
      )}
      {empty && <Mono size="13px">No curator exit in the feed window.</Mono>}
      {data?.clusters.slice(0, 2).map((c) => (
        <Mono key={`${c.collateral}:${c.start}`} size="13px" color={SEMANTIC_COLORS.danger} title={c.text}>
          <Box as="span" aria-hidden="true" mr="0.4em">
            ✖
          </Box>
          {clusterLine(c)} ({utc(c.end).slice(0, 10)})
        </Mono>
      ))}
      {gap && <OracleGapLine r={gap} href={`/${chainName}/curator-feed#oracle-gap`} />}
      {/* Compact: the full feed is one link away. */}
      {pending.slice(0, 2).map((r) => (
        <CardRow key={r.id} r={r} nowS={nowS} />
      ))}
      {data?.rows.slice(0, 2).map((r) => (
        <CardRow key={r.id} r={r} nowS={nowS} />
      ))}
      <HStack justify="space-between" align="center" spacing={SPACING.base} flexWrap="wrap">
        <Mono size="11px" color={SEMANTIC_COLORS.textTertiary}>
          {Number.isFinite(collected) ? `collected ${utc(Math.floor(collected / 1000))}` : ''}
        </Mono>
        <Link
          as={NextLink}
          href={`/${chainName}/curator-feed`}
          display="inline-flex"
          alignItems="center"
          minH="44px"
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="13px"
          color={SEMANTIC_COLORS.textPrimary}
          textDecoration="underline"
          textUnderlineOffset="3px"
        >
          Full feed →
        </Link>
      </HStack>
    </Box>
  )
}

export default CuratorFeed
