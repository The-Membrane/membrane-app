// THE LANDING AT `/` (lane Q41). One page, one customer (a looper or carry trader with
// an open borrow), one service: replay their position on their venue and on Membrane,
// then one CTA with two doors. The framework's STORY, top to bottom:
//   S  headline (server-assigned A/B), the mechanism subhead, the wallet input + one button,
//      prefilled with the demo wallet under the demo banner so a stranger sees a result;
//   T+O one double-line chart with events, the dollar verdict, the forecast layer, limits;
//   R  "This is a replay. Membrane is the live version." and the two doors;
//   Y  objection cards, each answered from data.
// No popup, no email gate, no connect wall (V20). The headline, deck and prose are in
// the server HTML (SEO R1); the chart and its panels load behind dynamic().

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import dynamic from 'next/dynamic'
import NextLink from 'next/link'
import { Box, Button, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { DemoBanner } from '@/components/demo'
import AddressBar from '@/components/Simulator/AddressBar'
import { usdSigned } from '@/components/Simulator/format'
import { useSimHistory } from '@/components/Simulator/hooks/useSimHistory'
import { doorSet, intentFrom, type Door, type DoorHandlers, type PositionIntent } from '@/lib/landing/doors'
import { RUN_LABEL, type HeadlineKey } from '@/lib/landing/headline'
import { LANDING_PAGES, type LandingPageId } from '@/lib/landing/pages'
import { PROSE } from '@/lib/landing/prose'
import { track } from '@/lib/landing/instrumentation'
import type { CensusSummary } from '@/lib/landing/objections'
import { PENDING_STATES } from '@/lib/landing/returnVisit'
import { SCENARIOS } from '@/lib/landing/scenarios'

import { useReplay } from './hooks/useReplay'
import ObjectionCards from './ObjectionCards'
import { CAPS, deck, kicker, rule, ruleStrong, small, tabularNums } from './styles'
import Doors from './Doors'
import Details, { DetailLine } from './Details'

/** Server render and first paint: the T and O beats hold their place in the STORY order. */
const ChartSkeleton = () => (
  <>
    <Box as="section" data-story="T" minH="36px" />
    <Box h={{ base: '380px', md: '520px' }} borderTop={rule} />
    <Box as="section" data-story="O" minH="36px" />
  </>
)
const ReplayDesk = dynamic(() => import('./ReplayDesk'), { ssr: false, loading: ChartSkeleton })
const ManualPositionForm = dynamic(() => import('./ManualPositionForm'), { ssr: false, loading: () => <Box minH="160px" /> })
const DoorSheet = dynamic(() => import('./DoorSheet'), { ssr: false })

export interface ForecastLandingProps {
  /** Which landing: `/` (borrower) or `/carry`. */
  page?: LandingPageId
  headline: HeadlineKey
  census: CensusSummary | null
  /** Optional: the migrate flow's own handlers. Absent, the page's sheet opens. */
  doors?: Partial<DoorHandlers>
}

const LINK_BTN = {
  variant: 'unstyled' as const,
  w: 'fit-content',
  h: 'auto',
  minH: '44px',
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: '11px',
  letterSpacing: CAPS,
  textTransform: 'uppercase' as const,
  color: SEMANTIC_COLORS.textSecondary,
  textDecoration: 'underline',
  transition: TRANSITIONS.colors,
  _hover: { color: SEMANTIC_COLORS.success },
  _focus: FOCUS_STYLES.ring,
}

const sinceText = (ms: number) => {
  const h = Math.floor(ms / 3_600_000)
  return h < 1 ? 'under an hour ago' : h < 48 ? `${h}h ago` : `${Math.floor(h / 24)} days ago`
}

export const ForecastLanding: React.FC<ForecastLandingProps> = ({ page = 'borrower', headline, census, doors }) => {
  const cfg = LANDING_PAGES[page]
  const r = useReplay(headline, cfg.demo)
  // Client-only pieces mount after hydration, so the server HTML and the first client
  // render match exactly (a preloaded dynamic() chunk would otherwise render early).
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const [manualOpen, setManualOpen] = useState(false)
  const [sheet, setSheet] = useState<{ door: Door; intent: PositionIntent | null } | null>(null)
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle')

  // The address's own liquidation history feeds forecast use (b).
  const history = useSimHistory(r.mode === 'manual' ? null : r.shownAddress)
  const episodes = history.data && !history.data.error ? history.data.episodes : null
  const historyNote =
    r.mode === 'manual'
      ? 'a hand-entered position has no history'
      : history.isPending
        ? 'reading this address’s liquidation history'
        : 'liquidation history unavailable for this address'
  const stepSeconds = r.data?.series.stepSeconds ?? null
  const startTs = r.data?.series.startTs ?? null

  // --------------------------------------------------------------------- doors
  const intent = useMemo<PositionIntent | null>(
    () =>
      r.selected
        ? intentFrom(r.selected, {
            source: r.mode === 'demo' ? 'demo' : r.mode === 'manual' ? 'manual' : 'address',
            address: r.mode === 'manual' ? undefined : r.shownAddress ?? undefined,
            membraneLine: r.membraneLine,
            scenarioId: r.scenarioId,
          })
        : null,
    [r.selected, r.mode, r.shownAddress, r.membraneLine, r.scenarioId],
  )
  const open = useCallback(
    (door: Door) => (i: PositionIntent | null) => {
      track({
        name: 'deploy_click',
        headline,
        door,
        isDemo: r.isDemo,
        address: i?.address,
        protocol: i?.protocol ?? 'none',
        debtUsd: i ? i.debt.reduce((a, d) => a + d.valueUsd, 0) : 0,
      })
      if (door === 'migrate' && doors?.onMigrate && i) doors.onMigrate(i)
      else if (door === 'fresh' && doors?.onDeployFresh) doors.onDeployFresh(i)
      else setSheet({ door, intent: i })
    },
    [headline, r.isDemo, doors],
  )

  // --------------------------------------------------------------------- share
  const onCopy = useCallback(() => {
    try {
      const url = `${window.location.origin}/${r.shareQuery}`
      navigator.clipboard.writeText(url).then(
        () => setCopied('copied'),
        () => setCopied('failed'),
      )
    } catch {
      setCopied('failed')
    }
    setTimeout(() => setCopied('idle'), 2400)
  }, [r.shareQuery])
  const cardHref = r.mode === 'manual' ? null : `/api/og/replay${r.shareQuery}`

  const whose = r.isDemo ? 'this' : 'your'
  const sizeFirst = r.visitState === 'changed'

  const coming = SCENARIOS.filter((x) => x.status === 'coming')
  const hasBorrow = r.positions.some((p) => p.totalDebtUsd > 0)
  const focusInput = () => {
    const el = typeof document !== 'undefined' ? (document.getElementById('landing-address-input') as HTMLInputElement | null) : null
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el.focus()
    }
  }
  const shareRow = (
        <Box display="flex" flexWrap="wrap" gap={SPACING.md} alignItems="center" data-testid="share-row">
          <Button {...LINK_BTN} onClick={onCopy} data-testid="share-copy">
            {copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy link'}
          </Button>
          {cardHref && (
            <Text {...kicker}>
              <a href={cardHref} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'underline' }} data-testid="share-card">
                Result card
              </a>
            </Text>
          )}
          <Text {...kicker}>
            <NextLink href={`/ethereum/simulator${r.mode === 'address' && r.shownAddress ? `?a=${r.shownAddress}` : ''}`} style={{ textDecoration: 'underline' }}>
              Full run
            </NextLink>
          </Text>
        </Box>
  )

  return (
    <Box maxW="1180px" mx="auto" px={{ base: SPACING.base, md: SPACING.lg }} pt={SPACING.xl} pb={SPACING['2xl']} color={SEMANTIC_COLORS.textPrimary} display="grid" gap={SPACING.xl} minW={0}>
      {/* S — ABOVE THE FOLD: one H1, one subhead, the input and one button. */}
      <Box as="section" data-story="S" display="grid" gap={SPACING.base} minW={0}>
      <Box as="header" data-testid="landing-hero" display="grid" gap={SPACING.base} minW={0}>
        <Text
          as="h1"
          data-testid="landing-h1"
          data-headline={headline}
          fontFamily={TYPOGRAPHY.fontDisplay}
          fontWeight={TYPOGRAPHY.normal}
          fontSize={{ base: '34px', md: '56px' }}
          lineHeight={1.05}
          letterSpacing="-0.01em"
          maxW="22ch"
        >
          {cfg.headlines[headline].headline}
        </Text>
        <Text as="p" {...deck} maxW="60ch" data-testid="landing-subhead">
          <Text as="span" display={{ base: 'none', md: 'inline' }}>
            {cfg.subhead.desktop}
          </Text>
          <Text as="span" display={{ base: 'inline', md: 'none' }}>
            {cfg.subhead.phone}
          </Text>
        </Text>
      </Box>
      <Box data-testid="landing-input" display="grid" gap={SPACING.xs} justifyItems="start" minW={0}>
        <AddressBar
          value={r.input}
          onChange={r.setInput}
          onSubmit={r.submitAddress}
          loadedAddress={r.mode === 'address' ? r.shownAddress : null}
          onClear={r.backToDemo}
          isLoading={r.isLoading}
          error={r.addressError}
          submitLabel={RUN_LABEL}
          inputId="landing-address-input"
          readNote={null}
          hideConnect
        />
        <Button {...LINK_BTN} data-testid="manual-toggle" aria-expanded={manualOpen} onClick={() => setManualOpen((v) => !v)}>
          {manualOpen ? 'Hide' : 'Enter by hand'}
        </Button>
        {manualOpen && <ManualPositionForm protocols={r.protocols} initial={r.manual} onSubmit={r.submitManual} error={r.manualError} />}
      </Box>
      </Box>

      {/* RETURN VISIT */}
      {(r.visitState === 'returning' || r.visitState === 'changed') && r.shownAddress && (
        <Box data-testid={`return-${r.visitState}`} borderTop={rule} pt={SPACING.sm} display="grid" gap={SPACING.xs}>
          <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize="20px">
            {r.visitState === 'changed' ? 'Your position changed.' : 'Welcome back. Re-read today.'}
          </Text>
          {r.delta && (
            <Text {...small} {...tabularNums} color={SEMANTIC_COLORS.textPrimary}>
              {sinceText(r.delta.sinceMs)} · debt {usdSigned(r.delta.debtUsd)} · LTV {r.delta.ltvPoints >= 0 ? '+' : '−'}
              {Math.abs(r.delta.ltvPoints * 100).toFixed(1)} pts · gap {usdSigned(r.delta.lessUsd)} (simulator)
            </Text>
          )}
        </Box>
      )}

      {/* T + O — THE RESULT */}
      <DemoBanner show={r.isDemo} note={cfg.demo.bannerNote} />
      <Box as="section" data-testid="landing-result" display="grid" gap={SPACING.md} minW={0} mt={r.isDemo ? `-${SPACING.lg}` : undefined}>
        <Box display="flex" flexWrap="wrap" gap={SPACING.sm} alignItems="center" data-testid="scenario-picker" role="radiogroup" aria-label="Stress window">
          {SCENARIOS.filter((x) => x.status === 'live').map((x) => (
            <Button
              key={x.id}
              role="radio"
              aria-checked={x.id === r.scenarioId}
              onClick={() => r.setScenarioId(x.id)}
              flex="0 0 auto"
              w="auto"
              minH="44px"
              borderRadius={0}
              variant="outline"
              borderColor={x.id === r.scenarioId ? SEMANTIC_COLORS.textPrimary : SEMANTIC_COLORS.borderSubtle}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="11px"
              _focus={FOCUS_STYLES.ring}
            >
              {x.label}
            </Button>
          ))}
          <Text {...small} color={SEMANTIC_COLORS.textTertiary} title={`Coming: ${coming.map((x) => `${x.label} (${x.needs})`).join(' · ')}`} aria-label={`${coming.length} more stress windows coming`} data-testid="scenario-coming">
            +{coming.length}
          </Text>
        </Box>

        {!mounted ? (
          <ChartSkeleton />
        ) : (
          <ReplayDesk
            comparison={r.comparison}
            startTs={startTs}
            stepSeconds={stepSeconds}
            whose={whose}
            positions={r.positions}
            selected={r.selected}
            onSelect={r.selectKey}
            usdeExit={r.protocols?.usdeExitLiquidity ?? null}
            sizeFirst={sizeFirst}
            errors={r.readErrors}
            scenarioName={r.data?.manifest.name ?? '10 Oct 2025'}
            episodes={episodes}
            historyNote={historyNote}
            oct10={r.data?.series ?? null}
            isDemo={r.isDemo}
            measured={r.census}
            addressCensus={r.addressCensus}
            shareSlot={shareRow}
            carry={page === 'carry'}
            detection={r.detection}
          />
        )}

      </Box>

      {/* R — THE REVEAL AND THE TWO DOORS */}
      <Doors
        intent={intent}
        buttons={doorSet(r.mode, hasBorrow)}
        onMigrate={open('migrate')}
        onDeployFresh={open('fresh')}
        onFocusInput={focusInput}
      />

      {/* Y — OBJECTIONS */}
      <ObjectionCards census={census} cards={cfg.objections} />

      {/* FINE PRINT, ONCE. The prose stays in the server HTML (SEO R1/R10) inside a
          closed disclosure, at the bottom, rendered once. */}
      <Box as="footer" data-testid="landing-footer" display="grid" gap={SPACING.xs} borderTop={ruleStrong} pt={SPACING.base}>
        <Box as="section" aria-labelledby="landing-how" maxW="72ch">
          <Details label="How the replay works" testId="landing-how">
            <Text id="landing-how" as="h2" srOnly>
              How the replay works
            </Text>
            {PROSE.map((p) => (
              <Text key={p.slice(0, 24)} as="p" {...small} fontSize="13px" color={SEMANTIC_COLORS.textPrimary}>
                {p}
              </Text>
            ))}
          </Details>
        </Box>
        <Details label="† Fine print" testId="landing-fineprint">
          <DetailLine>† Modelled figures are not a guarantee. Membrane figures are simulator output; Membrane is pre-launch and its per-asset line is our assumption.</DetailLine>
          <DetailLine>Replay, not a forecast: the measured 10 Oct 2025 oracle path applied to the position on screen. On a census wallet Aave’s side is its measured close, drawn at the first event; otherwise Aave is modelled at the median repay size and fires the first minute over the line. Gas, MEV and slippage on seized collateral are not modelled.</DetailLine>
          <DetailLine>Forecasts are of the Binance spot price touching a level, not of a venue’s oracle, shown only where each registry cell’s class allows.</DetailLine>
          {coming.map((x) => (
            <DetailLine key={x.id}>
              {x.label} · coming: {x.needs}
            </DetailLine>
          ))}
          <DetailLine>Return visits: {PENDING_STATES['after-event']} {PENDING_STATES.deployed}</DetailLine>
          <DetailLine>Data compiled by Membrane.</DetailLine>
        </Details>
      </Box>

      {sheet && <DoorSheet door={sheet.door} intent={sheet.intent} onClose={() => setSheet(null)} />}
    </Box>
  )
}

export default ForecastLanding
