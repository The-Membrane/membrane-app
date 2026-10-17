// §07 ORACLE ABOVE MARKET: one small card per market, one glance per card.
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
// Rules (membrane-board design/DESIGN_RULES.md): calm is ink; red ✖ only for a fired
// market (its oracle priced the collateral ≥ 2% above market for 24 h); stale is hatched
// ░ with the figure withheld. Every number comes from the API or the chain read.

import React, { memo, useEffect, useMemo, useState } from 'react'
import { Box, HStack, Input, Link, Select, Stack, Text } from '@chakra-ui/react'
import { useQuery } from '@tanstack/react-query'

import { Eyebrow, SectionHeading } from '@/components/Carry/atoms'
import { NEWS_FIGURE, shortAddress } from '@/components/NewsEdition/tokens'
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
import { cardTag, cardTitles, pickCards, uncheckedNote, type CardTag } from './oracleGapView'

const ETHERSCAN = 'https://etherscan.io'

/** A USD price at 5 significant digits: $83,357 · $1.0645 · $0.000015853. */
const usdPrice = (x: number): string =>
  `$${Number(x.toPrecision(5)).toLocaleString('en-US', { maximumFractionDigits: 20 })}`

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
}> = ({ series, line, label }) => {
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
        style={{ stroke: SEMANTIC_COLORS.textTertiary, strokeWidth: 1, strokeDasharray: '1 2' }}
      />
      <text
        x={W - LBL + 3}
        y={y(line) + 3}
        style={{ fill: SEMANTIC_COLORS.textTertiary, fontSize: 9, fontFamily: TYPOGRAPHY.fontMono }}
      >
        {label}
      </text>
      {lo < 0 && (
        <line
          x1={PAD}
          x2={W - LBL}
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

// ── one card ──────────────────────────────────────────────────────────────────

/** The card's fold: the two prices, the series, who holds it, the links. */
const CardDetails: React.FC<{
  m: OracleGapMarketView
  r: OracleGapResponse
  onWatch: (symbol: string) => void
}> = ({ m, r, onWatch }) => (
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
    <GapSpark series={m.series} line={r.constants.gap} label={thresholdText(r.constants)} />
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
 *  figure, mark, $ exposed, fold. A long title in one card moves every figure in its row
 *  down together, and every card in a row ends on the same line. */
const CARD_ROWS = 6

const GapCard = memo(function GapCard({
  m,
  r,
  title,
  tag,
  onWatch,
}: {
  m: OracleGapMarketView
  r: OracleGapResponse
  /** The market's name, with a short id when another market shares it (cardTitles). */
  title: string
  tag?: CardTag
  onWatch: (symbol: string) => void
}) {
  const mark = gapMark(m, r)
  const hatched = m.i3.state === 'stale' || m.i3.state === 'unobserved'
  const ink = mark.alarm ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.textPrimary
  const frame = tag ? FRAME[tag.style] : undefined
  return (
    <Box
      as="article"
      aria-label={`${title}${tag ? `, ${tag.text}` : ''}`}
      data-tie={tag?.style}
      minW={0}
      display="grid"
      gridRow={`span ${CARD_ROWS}`}
      gridTemplateRows="subgrid"
      rowGap={0}
      alignContent="start"
      px={SPACING.md}
      pt={SPACING.sm}
      border="1px solid"
      borderColor={frame?.border ?? SEMANTIC_COLORS.borderSubtle}
      // The heavy frame is a second inset hairline: 2px of ink, no layout shift.
      boxShadow={frame?.inset ? `inset 0 0 0 1px ${frame.border}` : undefined}
      bgImage={hatched ? HATCH : undefined}
    >
      {/* The tag row is always there (empty without a tie) so the subgrid rows line up. */}
      <Box>
        {tag && frame && (
          <Text {...LABEL} fontWeight={frame.weight} color={frame.ink} overflowWrap="anywhere">
            {tag.text}
          </Text>
        )}
      </Box>
      <Mono size="13px" color={SEMANTIC_COLORS.textPrimary} title={m.market}>
        {title}
      </Mono>
      {hatched ? (
        // Stale or not measured: the figure is withheld. One line of ░ at the figure's
        // line height, so the card keeps its rhythm and nothing reads as a value.
        <Box
          h="40px"
          display="flex"
          alignItems="center"
          role="img"
          aria-label="figure withheld"
        >
          <Mono size="13px" color={SEMANTIC_COLORS.textSecondary}>
            ░░░░
          </Mono>
        </Box>
      ) : (
        <Text
          {...NEWS_FIGURE.display}
          fontSize="32px"
          lineHeight="40px"
          color={ink}
          title={m.i3.currentGap !== undefined ? 'oracle ÷ DefiLlama − 1, newest point' : undefined}
        >
          {mark.alarm && (
            <Box as="span" aria-hidden="true" mr="0.2em">
              ✖
            </Box>
          )}
          {mark.headline}
        </Text>
      )}
      <Text {...LABEL} color={mark.alarm ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.textSecondary}>
        {mark.mark && !mark.alarm ? `${mark.mark} ` : ''}
        {mark.detail}
      </Text>
      <Mono size="11px" color={SEMANTIC_COLORS.textTertiary}>
        {gapExposed(m, r.exposedMinUsd)}
      </Mono>
      <Fold summary="prices · holders">
        <CardDetails m={m} r={r} onWatch={onWatch} />
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

/** "0x7AdA…d142 · block 26,200,000 · Vault shares: 2 held · Morpho Blue positions: none" */
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
  const failed = d.results.flatMap((r) => r.failed)
  const names = [...new Set(failed.map((f) => f.error.name))].join(', ')
  return (
    <Mono size="11px" color={SEMANTIC_COLORS.textSecondary}>
      {who}
      {d.block !== undefined ? ` · block ${d.block.toLocaleString('en-US')}` : ''}
      {d.results.map((r) => ` · ${r.label}: ${statusOf(r)}`).join('')}
      {failed.length ? ` · ${failed.length} reads failed (${names})` : ''}
      {unchecked ? ` · ${uncheckedNote(unchecked)}` : ''}
    </Mono>
  )
}

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
        {r.total} markets · {counts.fired} fired · {counts.building} above{' '}
        {thresholdText(constants)} for under {constants.persistenceHours} h · {counts.below} below ·{' '}
        {counts.unobserved + counts.stale} not measured now
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

/** The cards, the viewer's controls and the folds. */
const GapBody: React.FC<{ r: OracleGapResponse; onWatch: (symbol: string) => void }> = ({
  r,
  onWatch,
}) => {
  const [all, setAll] = useState(false)
  const [dust, setDust] = useState(false)
  const [showUnchecked, setShowUnchecked] = useState(false)
  const [only, setOnly] = useState(false)
  const [curator, setCurator] = useState('')
  const viewer = useViewerAddress()
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
  })
  const shown = pick.held.length + pick.unheld.length
  const titles = useMemo(() => cardTitles(r.markets), [r.markets])
  const card = (m: OracleGapMarketView) => (
    <GapCard
      key={m.market}
      m={m}
      r={r}
      title={titles.get(m.market) ?? m.marketName}
      tag={cardTag(m, unchecked)}
      onWatch={onWatch}
    />
  )

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
              {pick.uncheckedCount ? ` · ${uncheckedNote(pick.uncheckedCount)}` : ''}
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

      <Box mt={SPACING.sm}>
        {shown === 0 && !r.meta.stale && !(only && unread) && (
          <Mono size="11px">
            {hasViewer && only
              ? `No market here ties to ${[viewer.address && shortAddress(viewer.address), curator && shortName(curator)].filter(Boolean).join(' or ')}${pick.uncheckedCount ? ` · ${uncheckedNote(pick.uncheckedCount)}` : ''}.`
              : `No market is ${line} or more above its DefiLlama price at the newest point.`}
          </Mono>
        )}
        {pick.held.length > 0 && <Box {...GRID}>{pick.held.map(card)}</Box>}
        {pick.unheld.length > 0 && (
          <Box mt={SPACING.sm}>
            <Chip active={dust} onClick={() => setDust(!dust)}>
              {dust ? 'hide' : 'show'} {pick.unheld.length} more{' '}
              {hasViewer && only
                ? `where your vaults supply under $${r.exposedMinUsd}`
                : `with under $${r.exposedMinUsd} of curated exposure`}
            </Chip>
          </Box>
        )}
        {dust && pick.unheld.length > 0 && (
          <Box {...GRID} mt={SPACING.sm}>
            {pick.unheld.map(card)}
          </Box>
        )}
        {/* A failed read never reads as "none": the markets it could not check stay one
            tap away, marked ░ unchecked. */}
        {pick.unchecked.length > 0 && (
          <Box mt={SPACING.sm}>
            <Chip active={showUnchecked} onClick={() => setShowUnchecked(!showUnchecked)}>
              {showUnchecked ? 'hide' : 'show'} {pick.unchecked.length} unchecked
            </Chip>
          </Box>
        )}
        {showUnchecked && pick.unchecked.length > 0 && (
          <Box {...GRID} mt={SPACING.sm}>
            {pick.unchecked.map(card)}
          </Box>
        )}
        {!(hasViewer && only) && r.total > pick.above.length && (
          <Box mt={SPACING.sm}>
            <Chip active={all} onClick={() => setAll(!all)}>
              {all ? 'show fewer' : `show all ${r.total}`}
            </Chip>
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
    <Box id="oracle-gap" scrollMarginTop="80px">
      <SectionHeading
        index="07"
        title="Oracle above market"
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
