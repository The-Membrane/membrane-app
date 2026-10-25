// THE REDESIGN'S BLOCKS (layout reference: a "[X] vs [Y]" comparison landing — two-column
// hero, proof bar, checkmark table, reveal panel, bar chart, one stat with a real row,
// closing band). Every figure here comes from the census summary (server-built from
// public/data/oct10-2025/evidence.json), from protocols.json via lib/landing/comparison,
// or from the replay on screen. Nothing is typed in. Server-rendered except the hero
// preview, which needs the client-side replay.

import React, { useEffect, useState } from 'react'
import NextLink from 'next/link'
import { Box, Button, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { shortAddress, usd } from '@/components/Simulator/format'
import { ASSET_COLORS } from '@/config/chartTheme'
import type { Comparison } from '@/lib/position-sim'
import { SOLIDITY_PIN, type CensusSummary } from '@/lib/landing/objections'
import type { ComparisonRow, Mark } from '@/lib/landing/comparison'

import Details, { DetailLine } from './Details'
import { CAPS, kicker, rule, ruleStrong, small, tabularNums } from './styles'

export const HARD_SHADOW = `3px 3px 0 ${SEMANTIC_COLORS.borderStrong}`

/** $34.7M · $1.2M · $640K: the proof figures, rounded for reading. Exact sums in Details. */
export const usdShort = (n: number): string => {
  const a = Math.abs(n)
  if (a >= 1e9) return `$${(n / 1e9).toFixed(1)}B`
  if (a >= 1e6) return `$${(n / 1e6).toFixed(1)}M`
  if (a >= 1e3) return `$${Math.round(n / 1e3)}K`
  return usd(n)
}

const windowDays = (w: string): string => {
  // "2025-10-10T00:00Z to 2025-10-11T23:59Z" → "10–11 Oct 2025"
  const m = w.match(/^(\d{4})-(\d{2})-(\d{2}).*?(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return w
  const mon = new Date(Date.UTC(+m[1], +m[2] - 1, 1)).toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })
  return m[3] === m[6] ? `${+m[3]} ${mon} ${m[1]}` : `${+m[3]}–${+m[6]} ${mon} ${m[1]}`
}

const h2 = {
  as: 'h2' as const,
  fontFamily: TYPOGRAPHY.fontDisplay,
  fontWeight: TYPOGRAPHY.normal,
  fontSize: { base: '24px', md: '32px' },
  lineHeight: 1.15,
  color: SEMANTIC_COLORS.textPrimary,
}

// ------------------------------------------------------------------ hero preview

/**
 * Series colours (chart-design: the ordered palette in config/chartTheme). Membrane takes
 * series 1, phosphor. The venue skips series 2 (cyber teal), which reads as a second green
 * beside phosphor at this size, and takes series 3, gold.
 */
const SERIES_MEMBRANE = ASSET_COLORS[0]
const SERIES_VENUE = ASSET_COLORS[2]

/** Minute series → SVG points, both lines on one scale. */
function paths(a: (number | null)[], b: (number | null)[], w: number, h: number): [string, string] {
  const vals = [...a, ...b].filter((x): x is number => x !== null && Number.isFinite(x))
  if (vals.length === 0) return ['', '']
  const lo = Math.min(...vals)
  const hi = Math.max(...vals)
  const span = hi - lo || 1
  const n = Math.max(a.length, b.length) - 1 || 1
  const stride = Math.max(1, Math.floor(n / 240))
  const pts = (s: (number | null)[]) => {
    const out: string[] = []
    for (let i = 0; i < s.length; i += stride) {
      const v = s[i]
      if (v === null || !Number.isFinite(v)) continue
      out.push(`${((i / n) * w).toFixed(1)},${(h - ((v - lo) / span) * h).toFixed(1)}`)
    }
    return out.join(' ')
  }
  return [pts(a), pts(b)]
}

/**
 * The hero's right column: a small copy of the replay's two lines and its short verdict.
 * The full chart, with events and limits, is the T + O block below; this links to it.
 */
export const HeroPreview: React.FC<{
  comparison: Comparison | null
  mounted: boolean
  isDemo: boolean
  verdict: string | null
  scenarioName: string
}> = ({ comparison, mounted, isDemo, verdict, scenarioName }) => {
  const W = 320
  const H = 140
  const [venue, mem] = comparison ? paths(comparison.source.equitySeries, comparison.membrane.equitySeries, W, H) : ['', '']
  return (
    <Box
      as="a"
      href="#landing-result"
      data-testid="hero-preview"
      display="grid"
      gap={SPACING.sm}
      border="1px solid"
      borderColor={SEMANTIC_COLORS.borderStrong}
      bg={SEMANTIC_COLORS.bgSecondary}
      boxShadow={HARD_SHADOW}
      p={SPACING.base}
      minW={0}
      transition={TRANSITIONS.colors}
      _hover={{ borderColor: SEMANTIC_COLORS.textSecondary }}
      _focus={FOCUS_STYLES.ring}
      aria-label="Jump to the full replay"
    >
      <Text {...kicker}>
        Replay · {scenarioName}
        {isDemo ? ' · demo' : ''}
      </Text>
      <Box h={`${H}px`} minW={0}>
        {mounted && comparison ? (
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img" aria-label="Equity on the venue and on Membrane through the replay">
            <polyline points={venue} fill="none" stroke={SERIES_VENUE} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
            <polyline points={mem} fill="none" stroke={SERIES_MEMBRANE} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          </svg>
        ) : (
          <Box h="100%" borderTop={rule} />
        )}
      </Box>
      <Box display="flex" gap={SPACING.md} flexWrap="wrap">
        <Text {...small}>
          <Text as="span" color={SERIES_VENUE} fontWeight={TYPOGRAPHY.bold}>
            ━
          </Text>{' '}
          {comparison ? comparison.position.label.split(' · ')[0] : 'Venue'}
        </Text>
        <Text {...small}>
          <Text as="span" color={SERIES_MEMBRANE} fontWeight={TYPOGRAPHY.bold}>
            ━
          </Text>{' '}
          Membrane (simulator)
        </Text>
      </Box>
      <Text {...small} {...tabularNums} color={SEMANTIC_COLORS.textPrimary} minH="1.6em" data-testid="hero-preview-verdict">
        {mounted ? verdict : null}
      </Text>
    </Box>
  )
}

// ---------------------------------------------------------------------- proof bar

export const ProofBar: React.FC<{ census: CensusSummary | null }> = ({ census }) => {
  if (!census) return null
  const stats = [
    ...(census.accounts !== null
      ? [{ n: census.accounts.toLocaleString('en-US'), label: `Aave accounts liquidated · ${windowDays(census.window)}` }]
      : []),
    { n: usdShort(census.venueClosedUsd), label: `Aave closed on ${census.walked.toLocaleString('en-US')} walked` },
    { n: usdShort(census.membraneClosedUsd), label: 'Membrane would have closed (simulator)' },
  ]
  return (
    <Box
      as="aside"
      aria-label="Census figures"
      data-testid="landing-proof"
      display="grid"
      gridTemplateColumns={{ base: 'minmax(0, 1fr)', md: `repeat(${stats.length}, minmax(0, 1fr))` }}
      borderTop={ruleStrong}
      borderBottom={rule}
    >
      {stats.map((s, k) => (
        <Box key={s.label} py={SPACING.base} pl={{ base: 0, md: k ? SPACING.lg : 0 }} borderLeft={{ base: 'none', md: k ? rule : 'none' }} borderTop={{ base: k ? rule : 'none', md: 'none' }}>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={{ base: '26px', md: '32px' }} lineHeight={1.1} color={SEMANTIC_COLORS.textPrimary} {...tabularNums}>
            {s.n}
          </Text>
          <Text {...kicker}>{s.label}</Text>
        </Box>
      ))}
    </Box>
  )
}

// --------------------------------------------------------------- comparison table

const MARK: Record<Mark, { glyph: string; color: string; sr: string }> = {
  yes: { glyph: '✓', color: SEMANTIC_COLORS.success, sr: 'yes' },
  no: { glyph: '✗', color: SEMANTIC_COLORS.textSecondary, sr: 'no' },
  partial: { glyph: 'partially', color: SEMANTIC_COLORS.warning, sr: 'partially' },
  na: { glyph: '—', color: SEMANTIC_COLORS.textTertiary, sr: 'not applicable' },
}

const CellView: React.FC<{ c: ComparisonRow['aave']; title: string }> = ({ c, title }) => (
  <Box as="td" p={SPACING.sm} borderTop={rule} verticalAlign="top" title={`${c.text} · ${title}`}>
    <Text as="span" display="block" fontFamily={TYPOGRAPHY.fontMono} fontSize={c.mark === 'partial' ? '11px' : '16px'} color={MARK[c.mark].color} aria-label={MARK[c.mark].sr}>
      {MARK[c.mark].glyph}
    </Text>
  </Box>
)

export const ComparisonTable: React.FC<{ rows: ComparisonRow[] }> = ({ rows }) => {
  if (rows.length === 0) return null
  const th = { as: 'th' as const, p: SPACING.sm, textAlign: 'left' as const, verticalAlign: 'bottom' as const, ...kicker }
  return (
    <Box as="section" aria-labelledby="landing-compare" data-testid="landing-compare" display="grid" gap={SPACING.md} minW={0}>
      <Text id="landing-compare" {...h2}>
        Aave V3 and Morpho Blue vs Membrane
      </Text>
      <Box border="1px solid" borderColor={SEMANTIC_COLORS.borderStrong} bg={SEMANTIC_COLORS.bgSecondary} boxShadow={HARD_SHADOW} minW={0}>
        <Box as="table" w="100%" sx={{ tableLayout: 'fixed', borderCollapse: 'collapse' }}>
          <Box as="thead">
            <Box as="tr">
              <Box {...th} w={{ base: '31%', md: '40%' }}>
                <Text as="span" srOnly>
                  Feature
                </Text>
              </Box>
              <Box {...th}>Aave V3</Box>
              <Box {...th}>Morpho Blue</Box>
              <Box {...th} color={SEMANTIC_COLORS.success}>
                Membrane
              </Box>
            </Box>
          </Box>
          <Box as="tbody">
            {rows.map((r) => (
              <Box as="tr" key={r.id} data-testid={`compare-${r.id}`}>
                <Box as="th" scope="row" p={SPACING.sm} borderTop={rule} textAlign="left" verticalAlign="top" fontFamily={TYPOGRAPHY.fontMono} fontWeight={TYPOGRAPHY.normal} fontSize={{ base: '12px', md: '13px' }} color={SEMANTIC_COLORS.textPrimary}>
                  {r.label}
                </Box>
                <CellView c={r.aave} title={r.sources[0] ?? ''} />
                <CellView c={r.morpho} title={r.sources[r.sources.length > 2 ? 1 : 0] ?? ''} />
                <CellView c={r.membrane} title={r.sources[r.sources.length - 1] ?? ''} />
              </Box>
            ))}
          </Box>
        </Box>
      </Box>
      <Details testId="landing-compare-details">
        {rows.map((r) => (
          <DetailLine key={r.id}>
            {r.label}: Aave V3 {MARK[r.aave.mark].sr}, {r.aave.text}; Morpho Blue {MARK[r.morpho.mark].sr}, {r.morpho.text}; Membrane {MARK[r.membrane.mark].sr}, {r.membrane.text}. Sources: {r.sources.join(' · ')}
          </DetailLine>
        ))}
        <DetailLine>Contract lines: membrane-solidity master @ {SOLIDITY_PIN}. Venue cells: public/data/oct10-2025/protocols.json.</DetailLine>
      </Details>
    </Box>
  )
}

// ------------------------------------------------------------------ chain bar chart

export const ChainBars: React.FC<{ census: CensusSummary | null }> = ({ census }) => {
  if (!census || census.byChain.length === 0) return null
  const max = Math.max(...census.byChain.map((c) => Math.max(c.venueClosedUsd, c.membraneClosedUsd))) || 1
  const bar = (v: number, color: string, label: string) => (
    <Box display="grid" gridTemplateColumns="minmax(0, 1fr) 64px" alignItems="center" gap={SPACING.sm}>
      <Box h="14px" bg="transparent" borderLeft={rule}>
        <Box h="100%" w={`${Math.max(0.5, (v / max) * 100)}%`} bg={color} aria-hidden />
      </Box>
      <Text {...small} {...tabularNums} color={SEMANTIC_COLORS.textPrimary} textAlign="right" aria-label={`${label} ${usd(v)}`}>
        {usdShort(v)}
      </Text>
    </Box>
  )
  return (
    <Box as="section" aria-labelledby="landing-bars" data-testid="landing-bars" display="grid" gap={SPACING.md} minW={0}>
      <Text id="landing-bars" {...h2}>
        Debt closed, by chain
      </Text>
      <Box display="flex" gap={SPACING.md} flexWrap="wrap">
        <Text {...kicker}>
          <Text as="span" color={SEMANTIC_COLORS.textSecondary}>■</Text> Aave closed (measured)
        </Text>
        <Text {...kicker}>
          <Text as="span" color={SEMANTIC_COLORS.success}>■</Text> Membrane would have (simulator)
        </Text>
      </Box>
      <Box display="grid" gap={SPACING.base} borderTop={ruleStrong} pt={SPACING.base}>
        {census.byChain.map((c) => (
          <Box key={c.chain} display="grid" gridTemplateColumns={{ base: 'minmax(0, 1fr)', md: '140px minmax(0, 1fr)' }} gap={SPACING.xs} data-testid={`bars-${c.chain}`}>
            <Text {...kicker} color={SEMANTIC_COLORS.textPrimary}>
              {c.chain} · {c.rows}
            </Text>
            <Box display="grid" gap={SPACING.xs} minW={0}>
              {bar(c.venueClosedUsd, SEMANTIC_COLORS.textSecondary, `${c.chain} Aave closed`)}
              {bar(c.membraneClosedUsd, SEMANTIC_COLORS.success, `${c.chain} Membrane would have closed`)}
            </Box>
          </Box>
        ))}
      </Box>
      <Details testId="landing-bars-details">
        <DetailLine>
          Aave V3 accounts liquidated {census.window}, walked minute by minute where the collateral has a price series ({census.walked.toLocaleString('en-US')} accounts; the number after each chain). Sums: Aave {usd(census.venueClosedUsd)} (measured), Membrane{' '}
          {usd(census.membraneClosedUsd)} (simulator). The census holds Aave only; no other venue has a measured row here.
        </DetailLine>
      </Details>
    </Box>
  )
}

// ----------------------------------------------------------- one stat, one real row

export const StatExample: React.FC<{ census: CensusSummary | null }> = ({ census }) => {
  if (!census || census.venueClosedUsd <= 0) return null
  const gap = Math.round((1 - census.membraneClosedUsd / census.venueClosedUsd) * 100)
  const ex = census.recoveredExample
  return (
    <Box as="section" aria-label="One figure and one account" data-testid="landing-stat" display="grid" gridTemplateColumns={{ base: 'minmax(0, 1fr)', md: 'minmax(0, 1fr) minmax(0, 2fr)' }} gap={SPACING.lg} borderTop={ruleStrong} pt={SPACING.lg} minW={0}>
      <Box>
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={{ base: '56px', md: '80px' }} lineHeight={1} color={SEMANTIC_COLORS.success} {...tabularNums}>
          {gap}%
        </Text>
        <Text {...kicker}>less debt closed (simulator)</Text>
      </Box>
      {ex && (
        <Box display="grid" gap={SPACING.sm} borderLeft={{ base: 'none', md: rule }} pl={{ base: 0, md: SPACING.lg }} minW={0}>
          <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize={{ base: '19px', md: '24px' }} lineHeight={1.3} color={SEMANTIC_COLORS.textPrimary} {...tabularNums}>
            Aave closed {usd(ex.aaveClosedUsd)} of a {usd(ex.debtUsd)} {ex.collSymbol} loan.
            {ex.minutesToFirstCure !== null ? ` Price was back under its line ${ex.minutesToFirstCure} min later.` : ''} Membrane would have closed{' '}
            {usd(ex.membraneClosedUsd)} (simulator).
          </Text>
          <Text {...kicker}>
            <NextLink href="/ethereum/evidence" style={{ textDecoration: 'underline' }}>
              {shortAddress(ex.user)} · census row →
            </NextLink>
          </Text>
        </Box>
      )}
    </Box>
  )
}

// ------------------------------------------------------------------- closing band

export const ClosingBand: React.FC<{ promise: string; children: React.ReactNode }> = ({ promise, children }) => (
  <Box
    as="section"
    aria-labelledby="landing-closing"
    data-testid="landing-closing"
    display="grid"
    gap={SPACING.base}
    border="1px solid"
    borderColor={SEMANTIC_COLORS.borderStrong}
    bg={SEMANTIC_COLORS.bgSecondary}
    boxShadow={HARD_SHADOW}
    p={{ base: SPACING.base, md: SPACING.xl }}
    minW={0}
  >
    <Text id="landing-closing" {...h2} fontSize={{ base: '28px', md: '44px' }}>
      {promise}
    </Text>
    {children}
  </Box>
)

// ------------------------------------------------------------- sticky phone CTA

/** Phones only: a bar pinned to the bottom while the hero input is off screen. */
export const StickyCta: React.FC<{ targetId: string; label: string; onGo: () => void }> = ({ targetId, label, onGo }) => {
  const [show, setShow] = useState(false)
  useEffect(() => {
    const el = document.getElementById(targetId)
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(([e]) => setShow(!e.isIntersecting), { threshold: 0 })
    io.observe(el)
    return () => io.disconnect()
  }, [targetId])
  if (!show) return null
  return (
    <Box
      data-testid="landing-sticky-cta"
      display={{ base: 'block', md: 'none' }}
      position="fixed"
      left={0}
      right={0}
      bottom={0}
      zIndex={20}
      bg={SEMANTIC_COLORS.bgPrimary}
      borderTop={ruleStrong}
      px={SPACING.base}
      py={SPACING.sm}
    >
      <Button
        onClick={onGo}
        w="100%"
        minH="48px"
        borderRadius={0}
        bg={SEMANTIC_COLORS.success}
        color={SEMANTIC_COLORS.bgPrimary}
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="12px"
        letterSpacing={CAPS}
        textTransform="uppercase"
        transition={TRANSITIONS.colors}
        _hover={{ bg: SEMANTIC_COLORS.success, opacity: 0.9 }}
        _active={{ opacity: 0.85 }}
        _focus={FOCUS_STYLES.ring}
      >
        {label}
      </Button>
    </Box>
  )
}
