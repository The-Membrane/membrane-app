// §07 ORACLE VS MARKET: one small card per market, one glance per card.
//
// Owner, 2026-10-16: "smaller cards, less words and primarily showcase the core stats
// (market & delta) w/ a style toggle if the user or curator has a relationship to it. It
// should be a one-glance understanding of the markets'/assets' health."
//
// Each card: the market, the delta (oracle vs DefiLlama, signed %) as the biggest figure,
// the status mark (✖ fired, red; ▲ hours of 24; below; ░ not measured or stale) and the $
// exposed in small print. The prices, the series, the holders and the links sit in the
// card's fold; the method, the T2 record and the caveats in one "How this is measured"
// fold. A card the viewer is tied to (a typed or connected address, read-only, or a
// chosen curator; lib/exposure) carries a tag: a live tie a heavy frame, a tie from the
// exposure snapshot "as of" its date and muted, a tie under $1 under the fold, a market the
// read could not check "░ unchecked". The viewer can highlight those cards or show only them.
//
// Owner, 2026-10-17 (round 4): the state reads as colour, both ways. A card whose oracle
// is ≥ 2% above OR below market now is pale red (▲ / ▼, the side in words); ≥ 2% the same
// way for 24 h is the warning red card (✖ fired). Within the line, the card stays paper.
// Cards are raised (NEWS.shadowRaised, hard and unblurred). Past a 100% gap the line under
// the figure gives both prices. A star keeps a market at the top (per viewer, this
// browser); a highlighted tie sorts above that. The grid scrolls inside a fixed height.
// Stale is hatched ░ with the figure withheld. Every number comes from the API or the
// chain read.

import React, { memo, useEffect, useMemo, useState } from 'react'
import { Box, HStack, Input, Link, Select, Stack, Text } from '@chakra-ui/react'
import { useQuery } from '@tanstack/react-query'

import { Eyebrow, SectionHeading } from '@/components/Carry/atoms'
import { NEWS, NEWS_FIGURE, shortAddress } from '@/components/NewsEdition/tokens'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { durationText, utc } from '@/lib/curatorFeed/format'
import { gapExposed, gapMark, usdWithBook } from '@/lib/curatorFeed/headlines'
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
import type { OracleGapMarketView, OracleGapResponse } from '@/lib/curatorFeed/service'
import {
  curatorsOf,
  exposureTargets,
  maxEthCalls,
  relationsOf,
  shortName,
  uncheckedMarkets,
  withRelations,
  type ExposureReport,
} from '@/lib/exposure'

import { Chip, Fold, getJson, HATCH, LABEL, Mono } from './atoms'
import { useExposure, useViewerAddress } from './hooks/useExposure'
import { useStarred } from './hooks/useStarred'
import {
  bothPricesLine,
  cardState,
  cardTag,
  cardTitles,
  notReadReason,
  pickCards,
  sortCards,
  stateLine,
  uncheckedNote,
  usdPrice,
  type CardState,
  type CardTag,
  type Tone,
} from './oracleGapView'

const ETHERSCAN = 'https://etherscan.io'

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

/**
 * The last 48 hourly points as a thin ink line, the condition as a dotted ink rule
 * labelled on the chart. An unobserved point or a missing hour breaks the line.
 */
const GapSpark: React.FC<{
  series: OracleGapMarketView['series']
  line: number
  label: string
  /** On the warning card's red fill: every stroke in the card's own text colour. */
  onFill?: boolean
}> = ({ series, line, label, onFill }) => {
  const faint = onFill ? 'currentColor' : SEMANTIC_COLORS.textTertiary
  const ink = onFill ? 'currentColor' : SEMANTIC_COLORS.textSecondary
  const W = 132
  const H = 30
  const PAD = 3
  const LBL = 22
  const seen = series.filter((p): p is { ts: number; gap: number } => p.gap !== null)
  if (seen.length < 2) return null
  const t0 = series[0].ts
  const t1 = series[series.length - 1].ts
  const lo = Math.min(0, line, ...seen.map((p) => p.gap))
  const hi = Math.max(line, ...seen.map((p) => p.gap))
  const x = (ts: number) => PAD + ((ts - t0) / Math.max(1, t1 - t0)) * (W - LBL - 2 * PAD)
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
        x2={W - LBL}
        y1={y(line)}
        y2={y(line)}
        style={{ stroke: faint, strokeWidth: 1, strokeDasharray: '1 2' }}
      />
      <text
        x={W - LBL + 3}
        y={y(line) + 3}
        style={{ fill: faint, fontSize: 9, fontFamily: TYPOGRAPHY.fontMono }}
      >
        {label}
      </text>
      {lo < 0 && (
        <line
          x1={PAD}
          x2={W - LBL}
          y1={y(0)}
          y2={y(0)}
          style={{
            stroke: onFill ? 'currentColor' : SEMANTIC_COLORS.borderSubtle,
            strokeWidth: 1,
            opacity: onFill ? 0.4 : 1,
          }}
        />
      )}
      {/* Below market by the line: the mirrored condition, the same dotted rule. */}
      {lo <= -line && (
        <line
          x1={PAD}
          x2={W - LBL}
          y1={y(-line)}
          y2={y(-line)}
          style={{ stroke: faint, strokeWidth: 1, strokeDasharray: '1 2' }}
        />
      )}
      {segs.map((pts) =>
        pts.length > 1 ? (
          <polyline
            key={pts[0]}
            points={pts.join(' ')}
            style={{ fill: 'none', stroke: ink, strokeWidth: 1.25 }}
          />
        ) : (
          <circle
            key={pts[0]}
            cx={Number(pts[0].split(',')[0])}
            cy={Number(pts[0].split(',')[1])}
            r={1.25}
            style={{ fill: ink }}
          />
        ),
      )}
    </Box>
  )
}

// ── one card ──────────────────────────────────────────────────────────────────

/** The card's fold: the two prices, the series, who holds it, the links. */
const CardDetails: React.FC<{
  m: OracleGapMarketView
  r: OracleGapResponse
  onWatch: (symbol: string) => void
  onFill?: boolean
}> = ({ m, r, onWatch, onFill }) => (
  <Stack spacing={SPACING.xs} pb={SPACING.xs}>
    {m.latest && (
      <Mono size="11px">
        oracle {usdPrice(m.latest.oracleUsd)} · DefiLlama {usdPrice(m.latest.marketUsd)}
        {m.latest.marketConfidence !== undefined
          ? ` (confidence ${m.latest.marketConfidence})`
          : ''}
      </Mono>
    )}
    {m.i3.state === 'unobserved' && (
      <Mono size="11px">
        {m.lastRaw
          ? `DefiLlama confidence ${m.lastRaw.marketConfidence} under ${MIN_PRICE_CONFIDENCE}: raw ${gapText(m.lastRaw.rawGap)}, not counted`
          : 'No point this hour: the oracle reverts, or no fresh DefiLlama price.'}
      </Mono>
    )}
    <GapSpark
      series={m.series}
      line={r.constants.gap}
      label={thresholdText(r.constants)}
      onFill={onFill}
    />
    {m.vaults.length > 0 ? (
      <Mono size="11px">
        Held by{' '}
        {m.vaults
          .slice(0, 3)
          .map((v) => `${v.vaultName} (${shortName(v.curatorName)}) ${(v.share * 100).toFixed(1)}%`)
          .join(' · ')}
        {m.vaults.length > 3 ? ` · +${m.vaults.length - 3} more` : ''}
      </Mono>
    ) : (
      <Mono size="11px">No curated vault holds it at the last exposure read.</Mono>
    )}
    {/* rel.usd (the viewer's pro-rata $) is computed but not shown: a new kind of
        number waits for the owner (DESIGN_RULES §3). */}
    <Box>
      <Box as="button" type="button" {...ACTION} onClick={() => onWatch(m.collateralSymbol)}>
        watch {m.collateralSymbol} →
      </Box>
      <Link href={`${ETHERSCAN}/address/${m.oracle}#readContract`} isExternal {...ACTION}>
        oracle ↗
      </Link>
    </Box>
  </Stack>
)

/** The frame and tag of a card the viewer is tied to: a live tie is heavy ink; a snapshot
 *  tie (as of a date), a dust tie and an unchecked market are muted. */
const FRAME: Record<
  CardTag['style'],
  { border: string; inset: boolean; ink: string; weight: number }
> = {
  live: {
    border: SEMANTIC_COLORS.textPrimary,
    inset: true,
    ink: SEMANTIC_COLORS.textPrimary,
    weight: 700,
  },
  snapshot: {
    border: SEMANTIC_COLORS.borderStrong,
    inset: false,
    ink: SEMANTIC_COLORS.textSecondary,
    weight: 400,
  },
  dust: {
    border: SEMANTIC_COLORS.borderSubtle,
    inset: false,
    ink: SEMANTIC_COLORS.textSecondary,
    weight: 400,
  },
  unchecked: {
    border: SEMANTIC_COLORS.borderSubtle,
    inset: false,
    ink: SEMANTIC_COLORS.textSecondary,
    weight: 400,
  },
}

/** A card's rows, shared with its neighbours through the grid's subgrid: tag, title,
 *  figure, both prices (past a 100% gap; empty otherwise), state, $ exposed, fold. A long
 *  title in one card moves every figure in its row down together, and every card in a row
 *  ends on the same line. */
const CARD_ROWS = 7

/** The card's fill by colour state. Neutral stays paper; pale is the danger tint; warning
 *  is the danger fill with paper-coloured text. */
const FILL: Record<Tone, { bg: string; ink?: string }> = {
  neutral: { bg: NEWS.paper },
  pale: { bg: NEWS.dangerTint },
  warning: { bg: NEWS.danger, ink: NEWS.paper },
}

/** The star: a 44px toggle in the card's top-right corner. */
const StarButton: React.FC<{ on: boolean; title: string; onClick: () => void }> = ({
  on,
  title,
  onClick,
}) => (
  <Box
    as="button"
    type="button"
    aria-pressed={on}
    aria-label={`Star ${title}`}
    title={on ? 'Starred: kept at the top' : 'Star to keep at the top'}
    onClick={onClick}
    position="absolute"
    top={0}
    right={0}
    w="44px"
    h="44px"
    display="flex"
    alignItems="center"
    justifyContent="center"
    fontSize="18px"
    lineHeight={1}
    color="inherit"
    opacity={on ? 1 : 0.6}
    transition={TRANSITIONS.colors}
    _hover={{ opacity: 1 }}
    _focusVisible={FOCUS_STYLES.ring}
  >
    <span aria-hidden="true">{on ? '★' : '☆'}</span>
  </Box>
)

const GapCard = memo(function GapCard({
  m,
  r,
  title,
  tag,
  state,
  starred,
  onStar,
  onWatch,
}: {
  m: OracleGapMarketView
  r: OracleGapResponse
  /** The market's name, with a short id when another market shares it (cardTitles). */
  title: string
  tag?: CardTag
  state: CardState
  starred: boolean
  onStar: (market: string) => void
  onWatch: (symbol: string) => void
}) {
  const mark = gapMark(m, r)
  const hatched = m.i3.state === 'stale' || m.i3.state === 'unobserved'
  const fill = FILL[hatched ? 'neutral' : state.tone]
  const onFill = !!fill.ink
  const prices = bothPricesLine(m)
  const frame = tag ? FRAME[tag.style] : undefined
  const line = hatched
    ? `${mark.mark ? `${mark.mark} ` : ''}${mark.detail}`
    : stateLine(state, r.constants)
  const lineInk = onFill
    ? undefined
    : state.tone === 'neutral' || hatched
      ? SEMANTIC_COLORS.textSecondary
      : NEWS.danger
  return (
    <Box
      as="article"
      aria-label={`${title}${tag ? `, ${tag.text}` : ''}${starred ? ', starred' : ''}`}
      data-tie={tag?.style}
      data-tone={hatched ? 'hatched' : state.tone}
      data-dir={state.dir}
      position="relative"
      minW={0}
      display="grid"
      gridRow={`span ${CARD_ROWS}`}
      gridTemplateRows="subgrid"
      rowGap={0}
      alignContent="start"
      px={SPACING.md}
      pt={SPACING.sm}
      border="1px solid"
      borderColor={onFill ? NEWS.danger : (frame?.border ?? SEMANTIC_COLORS.borderSubtle)}
      bg={fill.bg}
      color={fill.ink}
      // Raised: the hard offset shadow token. A live tie adds its heavy frame as a second
      // inset hairline (2px of ink, no layout shift).
      boxShadow={
        frame?.inset ? `inset 0 0 0 1px ${frame.border}, ${NEWS.shadowRaised}` : NEWS.shadowRaised
      }
      bgImage={hatched ? HATCH : undefined}
      // On the warning fill every line takes the card's paper-coloured text.
      sx={
        onFill
          ? { '& p, & span, & a, & button, & summary': { color: 'inherit !important' } }
          : undefined
      }
    >
      <StarButton on={starred} title={title} onClick={() => onStar(m.market)} />
      {/* The tag row is always there (empty without a tie) so the subgrid rows line up. */}
      <Box pr="36px">
        {tag && frame && (
          <Text {...LABEL} fontWeight={frame.weight} color={frame.ink} overflowWrap="anywhere">
            {tag.text}
          </Text>
        )}
      </Box>
      <Box pr="36px">
        <Mono size="13px" color={SEMANTIC_COLORS.textPrimary} title={m.market}>
          {title}
        </Mono>
      </Box>
      {hatched ? (
        // Stale or not measured: the figure is withheld. One line of ░ at the figure's
        // line height, so the card keeps its rhythm and nothing reads as a value.
        <Box h="40px" display="flex" alignItems="center" role="img" aria-label="figure withheld">
          <Mono size="13px" color={SEMANTIC_COLORS.textSecondary}>
            ░░░░
          </Mono>
        </Box>
      ) : (
        <Text
          {...NEWS_FIGURE.display}
          fontSize="32px"
          lineHeight="40px"
          color={onFill ? undefined : SEMANTIC_COLORS.textPrimary}
          title={m.i3.currentGap !== undefined ? 'oracle ÷ DefiLlama − 1, newest point' : undefined}
        >
          {mark.headline}
        </Text>
      )}
      {/* Past a 100% gap the delta alone misleads: both prices, and how they were taken. */}
      <Box>
        {prices && (
          <Mono size="11px" color={SEMANTIC_COLORS.textPrimary}>
            {prices}
          </Mono>
        )}
      </Box>
      <Text {...LABEL} color={lineInk} fontWeight={state.tone === 'warning' ? 700 : 400}>
        {line}
      </Text>
      <Mono size="11px" color={SEMANTIC_COLORS.textTertiary}>
        {gapExposed(m, r.exposedMinUsd)}
      </Mono>
      <Fold summary="prices · holders">
        <CardDetails m={m} r={r} onWatch={onWatch} onFill={onFill} />
      </Fold>
    </Box>
  )
})

const GRID = {
  display: 'grid',
  gridTemplateColumns: {
    base: 'minmax(0, 1fr)',
    sm: 'repeat(2, minmax(0, 1fr))',
    lg: 'repeat(3, minmax(0, 1fr))',
    xl: 'repeat(4, minmax(0, 1fr))',
  },
  gap: SPACING.sm,
} as const

// ── the viewer: a curator, an address ─────────────────────────────────────────

const statusOf = (r: ExposureReport['results'][number]): string => {
  switch (r.status) {
    case 'ok':
      return `${r.holdings.length} held`
    case 'empty':
      return 'none'
    case 'unchecked':
      return 'not checked'
    default:
      return `░ ${r.error?.name ?? 'Error'}`
  }
}

/** "0x7AdA…d142 · block 26,200,000 · Vault shares: 2 held · Morpho Blue positions: none".
 *  Failed reads are said once: on the not-read line when they leave a tie unread, else
 *  here. */
const ReadLine: React.FC<{
  address: string
  q: ReturnType<typeof useExposure>
  unchecked: number
}> = ({ address, q, unchecked }) => {
  const who = shortAddress(address)
  if (q.isFetching)
    return (
      <Mono size="11px">
        Reading {who} on Ethereum · read-only · at most {maxEthCalls()} calls…
      </Mono>
    )
  if (q.error)
    return (
      <Mono size="11px" color={SEMANTIC_COLORS.textPrimary}>
        ░ Read failed · {q.error.name}: {q.error.message}
      </Mono>
    )
  const d = q.data
  if (!d) return null
  const reason = unchecked ? undefined : notReadReason(d)
  return (
    <Mono size="11px" color={SEMANTIC_COLORS.textSecondary}>
      {who}
      {d.block !== undefined ? ` · block ${d.block.toLocaleString('en-US')}` : ''}
      {d.results.map((r) => ` · ${r.label}: ${statusOf(r)}`).join('')}
      {reason ? ` · ${reason}` : ''}
    </Mono>
  )
}

/**
 * "░ 92 ties not read · 100 reads failed: HttpRequestError · retry": the markets where the
 * read of whether the viewer's vaults or positions supply them failed, why, and a retry.
 * The one place the count is printed.
 */
const NotReadLine: React.FC<{
  count: number
  reason?: string
  onRetry: () => void
  retrying: boolean
  fold?: { open: boolean; toggle: () => void }
}> = ({ count, reason, onRetry, retrying, fold }) => (
  <HStack spacing={0} flexWrap="wrap" align="center" data-not-read>
    <Mono size="11px" color={SEMANTIC_COLORS.textPrimary} as="span">
      {uncheckedNote(count)}
      {reason ? ` · ${reason}` : ''}
      {'\u00a0·\u00a0'}
    </Mono>
    <Box as="button" type="button" {...ACTION} onClick={onRetry} disabled={retrying}>
      {retrying ? 'reading…' : 'retry'}
    </Box>
    {fold && (
      <Box as="button" type="button" {...ACTION} aria-pressed={fold.open} onClick={fold.toggle}>
        {fold.open ? 'hide them' : 'show them'}
      </Box>
    )}
  </HStack>
)

const FIELD = {
  size: 'sm' as const,
  borderRadius: 0,
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: '12px',
  minH: { base: '44px', md: '32px' },
  borderColor: SEMANTIC_COLORS.borderSubtle,
  transition: TRANSITIONS.colors,
  _focusVisible: FOCUS_STYLES.ring,
}

// ── the section ───────────────────────────────────────────────────────────────

/** "279 markets · 1 fired above · 0 fired below · 8 ≥ 2% above now · 16 ≥ 2% below now ·
 *  230 within ±2% · 24 not measured now": both sides, from the cards' own states. */
function toneCountsText(r: OracleGapResponse): string {
  const line = thresholdText(r.constants)
  const n = { firedAbove: 0, firedBelow: 0, above: 0, below: 0, within: 0, none: 0 }
  for (const m of r.markets) {
    const s = cardState(m, r.constants)
    if (m.i3.state === 'stale' || m.i3.state === 'unobserved') n.none++
    else if (s.tone === 'warning') n[s.dir === 'below' ? 'firedBelow' : 'firedAbove']++
    else if (s.tone === 'pale') n[s.dir === 'below' ? 'below' : 'above']++
    else n.within++
  }
  // r.markets is capped by the API's limit; past it the rest are not counted here.
  const rest = r.total - r.markets.length
  return [
    `${r.total} markets`,
    `${n.firedAbove} fired above`,
    `${n.firedBelow} fired below`,
    `${n.above} ≥ ${line} above now`,
    `${n.below} ≥ ${line} below now`,
    `${n.within} within ±${line}`,
    `${n.none} not measured now`,
    ...(rest > 0 ? [`${rest} not listed`] : []),
  ].join(' · ')
}

/** Finding: the headline in ink, or the hatched stale notice with the headline withheld. */
const GapFinding: React.FC<{ r: OracleGapResponse; collateral: string }> = ({ r, collateral }) => {
  const { meta, counts, constants } = r
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
          color={counts.fired > 0 ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.textPrimary}
        >
          {counts.fired > 0 && (
            <Box as="span" aria-hidden="true" mr="0.4em">
              ✖
            </Box>
          )}
          {i3Headline(counts.fired, constants)}
          {collateral ? ` · ${collateral}` : ''}
          {counts.fired > 0 && r.exposed.fired
            ? ` · ${usdWithBook(r.curatedUsd.fired, r.bookUsd.fired)} curated supply`
            : ''}
        </Text>
      )}
      <Mono size="11px" color={SEMANTIC_COLORS.textTertiary}>
        {toneCountsText(r)}
      </Mono>
    </>
  )
}

/** The method, the T2 record and its caveats, the wallet read: one fold. */
const HowMeasured: React.FC<{ r: OracleGapResponse }> = ({ r }) => {
  const { meta, constants } = r
  const line = thresholdText(constants)
  return (
    <Fold summary="How this is measured" mt={SPACING.base}>
      <Stack spacing={SPACING.sm} pb={SPACING.sm} maxW="760px">
        <Mono size="11px">
          Oracle: price() at the head block, in loan token × DefiLlama&apos;s loan-token price.
          Market: DefiLlama&apos;s collateral price. Delta: oracle ÷ market − 1. Fires after{' '}
          {constants.persistenceHours} hourly points in a row at ≥ {line}. A revert, a price over{' '}
          {MARKET_HOLD_SECONDS / 3600} h old or a DefiLlama confidence under {MIN_PRICE_CONFIDENCE}{' '}
          is no point.
        </Mono>
        <Mono size="11px">
          {meta.runs} hourly points · newest block {meta.lastRunBlock?.toLocaleString('en-US')} ·
          vaults and $ exposed as of block {meta.exposureBlock.toLocaleString('en-US')} (
          {utc(meta.exposureTs)}). In a supply-locked market the $ is book value, not live supply.
        </Mono>
        <Mono size="11px">
          Your address: read-only, no signature, at one block through public Ethereum RPCs (the next
          one if one fails). balanceOf on every Morpho vault of the exposure read; where you hold
          shares, convertToAssets, and for a MetaMorpho vault the markets it supplies now
          (withdrawQueue, then position() above 0); Morpho Blue position() on each market here. A
          Vault V2&apos;s markets, and a vault whose live read fails, are the exposure read&apos;s:
          tagged &quot;as of&quot; its date. A tie under ${r.exposedMinUsd} sits under the fold.
          Other protocols are not read.
        </Mono>
        <Box pt={SPACING.xs}>
          <Eyebrow>
            Record · {r.record.lane} {r.record.test.split(/\s/)[0]} · retrospective
          </Eyebrow>
          <Stack spacing={0} mt={SPACING.xs}>
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
      </Stack>
    </Fold>
  )
}

/** The scroll box: about three rows of cards on desktop, four cards on a phone. Its own
 *  scrollbar, keyboard-scrollable; the page does not run on. The padding keeps the raised
 *  cards' offset shadow inside the clip. */
const SCROLL = {
  maxH: { base: '760px', md: '600px' },
  overflowY: 'auto',
  overscrollBehavior: 'contain',
  pr: SPACING.xs,
  pb: SPACING.xs,
  borderTop: `1px solid ${SEMANTIC_COLORS.borderSubtle}`,
  borderBottom: `1px solid ${SEMANTIC_COLORS.borderSubtle}`,
  pt: SPACING.sm,
  _focusVisible: FOCUS_STYLES.ring,
} as const

/** The cards, the viewer's controls and the folds. */
const GapBody: React.FC<{ r: OracleGapResponse; onWatch: (symbol: string) => void }> = ({
  r,
  onWatch,
}) => {
  const [all, setAll] = useState(false)
  const [dust, setDust] = useState(false)
  const [showUnchecked, setShowUnchecked] = useState(false)
  const [only, setOnly] = useState(false)
  const [starredOnly, setStarredOnly] = useState(false)
  const [curator, setCurator] = useState('')
  const viewer = useViewerAddress()
  const { starred, toggle: toggleStar } = useStarred()
  const targets = useMemo(() => exposureTargets(r.markets, r.vaults), [r.markets, r.vaults])
  const curators = useMemo(() => curatorsOf(r.markets), [r.markets])
  const exposure = useExposure(viewer.address, targets)
  const report = viewer.address ? exposure.data : undefined
  const relations = useMemo(
    () =>
      relationsOf(r.markets, report, curator || undefined, {
        vaults: r.vaults,
        snapshotTs: r.meta.exposureTs,
        minUsd: r.exposedMinUsd,
      }),
    [r.markets, r.vaults, r.meta.exposureTs, r.exposedMinUsd, report, curator],
  )
  const unchecked = useMemo(() => new Set(uncheckedMarkets(r.markets, report)), [r.markets, report])
  const markets = useMemo(() => withRelations(r.markets, relations), [r.markets, relations])
  const states = useMemo(
    () => new Map(r.markets.map((m) => [m.market, cardState(m, r.constants)])),
    [r.markets, r.constants],
  )
  const tone = (m: OracleGapMarketView): Tone => states.get(m.market)?.tone ?? 'neutral'
  const hasViewer = !!curator || !!viewer.address
  // The address is not read yet, or its read threw: no claim about its markets (the read
  // line says which).
  const unread = !!viewer.address && !report
  const line = thresholdText(r.constants)
  const pick = pickCards({
    markets,
    stale: r.meta.stale,
    all,
    hasViewer,
    only,
    unchecked,
    minUsd: r.exposedMinUsd,
    starred,
    starredOnly,
    tone,
  })
  // Highlight mine (or a curator) on: the highlighted cards first, then starred, then by
  // severity.
  const order = (xs: OracleGapMarketView[]) =>
    sortCards(xs, { highlight: hasViewer && !only, starred, tone })
  const held = order(pick.held)
  const unheld = order(pick.unheld)
  const shown = held.length + unheld.length
  const titles = useMemo(() => cardTitles(r.markets), [r.markets])
  const starCount = r.markets.filter((m) => starred.has(m.market.toLowerCase())).length
  const reason = report ? notReadReason(report) : undefined
  const card = (m: OracleGapMarketView) => (
    <GapCard
      key={m.market}
      m={m}
      r={r}
      title={titles.get(m.market) ?? m.marketName}
      tag={cardTag(m, unchecked)}
      state={states.get(m.market)!}
      starred={starred.has(m.market.toLowerCase())}
      onStar={toggleStar}
      onWatch={onWatch}
    />
  )
  const anyGrid =
    held.length > 0 || (dust && unheld.length > 0) || (showUnchecked && pick.unchecked.length > 0)

  return (
    <Box mt={SPACING.sm}>
      <HStack spacing={SPACING.sm} flexWrap="wrap" align="end">
        <Box w={{ base: '100%', sm: '220px' }}>
          <Text
            as="label"
            htmlFor="oracle-gap-curator"
            {...LABEL}
            color={SEMANTIC_COLORS.textTertiary}
          >
            Curator
          </Text>
          <Select
            id="oracle-gap-curator"
            {...FIELD}
            value={curator}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setCurator(e.target.value)}
          >
            <option value="">none</option>
            {curators.map((c) => (
              <option key={c} value={c}>
                {shortName(c)}
              </option>
            ))}
          </Select>
        </Box>
        <Box w={{ base: '100%', sm: '360px' }}>
          <Text
            as="label"
            htmlFor="oracle-gap-address"
            {...LABEL}
            color={SEMANTIC_COLORS.textTertiary}
          >
            Your address · read-only
          </Text>
          <Input
            id="oracle-gap-address"
            {...FIELD}
            placeholder="0x… (or connect a wallet)"
            value={viewer.input}
            spellCheck={false}
            autoComplete="off"
            isInvalid={!!viewer.error}
            aria-invalid={!!viewer.error}
            aria-describedby={viewer.error ? 'oracle-gap-address-error' : undefined}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => viewer.setInput(e.target.value)}
            onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) =>
              e.key === 'Enter' && viewer.commit()
            }
            onBlur={() => viewer.commit()}
          />
        </Box>
        {hasViewer && (
          <HStack
            spacing={SPACING.xs}
            role="group"
            aria-label="Your markets"
            minH="32px"
            flexWrap="wrap"
          >
            <Chip active={!only} onClick={() => setOnly(false)}>
              Highlight mine
            </Chip>
            <Chip active={only} onClick={() => setOnly(true)}>
              Show only mine
            </Chip>
            <Mono size="11px" as="span">
              {pick.mine} of {r.total}
            </Mono>
          </HStack>
        )}
      </HStack>
      {viewer.error && (
        <Box id="oracle-gap-address-error">
          <Mono size="11px" color={SEMANTIC_COLORS.textPrimary}>
            {viewer.error}
          </Mono>
        </Box>
      )}
      {viewer.address && (
        <ReadLine address={viewer.address} q={exposure} unchecked={pick.uncheckedCount} />
      )}
      {/* A failed read never reads as "none": the count, why, and a retry. Under "Show
          only mine" the markets it could not settle stay one tap away. */}
      {viewer.address && report && pick.uncheckedCount > 0 && (
        <NotReadLine
          count={pick.uncheckedCount}
          reason={reason}
          retrying={exposure.isFetching}
          onRetry={() => void exposure.refetch()}
          fold={
            hasViewer && only && pick.unchecked.length > 0
              ? { open: showUnchecked, toggle: () => setShowUnchecked(!showUnchecked) }
              : undefined
          }
        />
      )}

      {/* The filters and folds sit above the scroll box, so they never scroll away. */}
      <HStack
        spacing={SPACING.xs}
        flexWrap="wrap"
        mt={SPACING.sm}
        role="group"
        aria-label="Filter the cards"
      >
        <Chip active={starredOnly} onClick={() => setStarredOnly(!starredOnly)}>
          ★ Starred {starCount}
        </Chip>
        {!starredOnly && unheld.length > 0 && (
          <Chip active={dust} onClick={() => setDust(!dust)}>
            {dust ? 'hide' : 'show'} {unheld.length} more{' '}
            {hasViewer && only
              ? `where your vaults supply under $${r.exposedMinUsd}`
              : `with under $${r.exposedMinUsd} of curated exposure`}
          </Chip>
        )}
        {!starredOnly && !(hasViewer && only) && r.total > pick.above.length && (
          <Chip active={all} onClick={() => setAll(!all)}>
            {all ? 'show fewer' : `show all ${r.total}`}
          </Chip>
        )}
      </HStack>

      <Box mt={SPACING.sm}>
        {shown === 0 && !r.meta.stale && !(only && unread) && (
          <Mono size="11px">
            {starredOnly
              ? starCount
                ? 'No starred market in this view.'
                : 'No starred market yet: ☆ on a card keeps it at the top.'
              : hasViewer && only
                ? `No market here ties to ${[viewer.address && shortAddress(viewer.address), curator && shortName(curator)].filter(Boolean).join(' or ')}.`
                : `No market is ${line} or more from its DefiLlama price at the newest point.`}
          </Mono>
        )}
        {anyGrid && (
          <Box
            {...SCROLL}
            tabIndex={0}
            role="region"
            aria-label={`Oracle vs market cards, ${held.length + (dust ? unheld.length : 0)} shown; scrolls`}
            data-card-scroll
          >
            {held.length > 0 && <Box {...GRID}>{held.map(card)}</Box>}
            {dust && unheld.length > 0 && (
              <Box {...GRID} mt={held.length ? SPACING.sm : 0}>
                {unheld.map(card)}
              </Box>
            )}
            {showUnchecked && pick.unchecked.length > 0 && (
              <Box {...GRID} mt={SPACING.sm}>
                {order(pick.unchecked).map(card)}
              </Box>
            )}
          </Box>
        )}
      </Box>
      <HowMeasured r={r} />
    </Box>
  )
}

export const OracleGapSection: React.FC<{
  collateral: string
  onWatch: (symbol: string) => void
}> = ({ collateral, onWatch }) => {
  const { data, error, isLoading } = useQuery<OracleGapResponse>({
    queryKey: ['curator_oracle_gap', collateral],
    // limit 500 (the API's cap): every market, so "Show only mine" sees all of them.
    queryFn: () =>
      getJson(
        `/api/curator-feed?view=oracle-gap&limit=500${collateral ? `&collateral=${encodeURIComponent(collateral)}` : ''}`,
      ),
    staleTime: 5 * 60_000,
    // A missing dataset is a 503, not a blip: say so after one retry.
    retry: 1,
  })
  // The page renders client-side, so a #oracle-gap link lands before this section exists.
  useEffect(() => {
    if (data && window.location.hash === '#oracle-gap')
      document.getElementById('oracle-gap')?.scrollIntoView()
  }, [data])
  const meta = data?.meta
  return (
    <Box id="oracle-gap" scrollMarginTop="80px" data-news-tokens>
      <SectionHeading
        index="07"
        title="Oracle vs market"
        note={
          meta?.lastRunTs !== undefined
            ? `measured · ${utc(meta.lastRunTs)} (${durationText(meta.now - meta.lastRunTs)} ago)`
            : undefined
        }
      />
      <Box minH="220px">
        {isLoading && <Mono>loading…</Mono>}
        {error && (
          <Mono size="12px" color={SEMANTIC_COLORS.textPrimary}>
            ░ Oracle gap unavailable.
          </Mono>
        )}
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
