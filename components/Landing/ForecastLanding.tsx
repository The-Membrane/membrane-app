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
import { shortAddress, usdSigned } from '@/components/Simulator/format'
import { useSimHistory } from '@/components/Simulator/hooks/useSimHistory'
import { DEMO_BORROWER_DATE } from '@/lib/position-sim/demoBorrower'
import { intentFrom, type Door, type DoorHandlers, type PositionIntent } from '@/lib/landing/doors'
import { HEADLINES, RUN_LABEL, SUBHEAD, type HeadlineKey } from '@/lib/landing/headline'
import { PROSE } from '@/lib/landing/prose'
import { track } from '@/lib/landing/instrumentation'
import type { CensusSummary } from '@/lib/landing/objections'
import { PENDING_STATES } from '@/lib/landing/returnVisit'
import { SCENARIOS } from '@/lib/landing/scenarios'

import { useReplay } from './hooks/useReplay'
import ObjectionCards from './ObjectionCards'
import { CAPS, credit, deck, kicker, rule, ruleStrong, small, tabularNums } from './styles'
import Doors from './Doors'

const ChartSkeleton = () => <Box h={{ base: '420px', md: '560px' }} borderTop={rule} />
const ReplayDesk = dynamic(() => import('./ReplayDesk'), { ssr: false, loading: ChartSkeleton })
const ManualPositionForm = dynamic(() => import('./ManualPositionForm'), { ssr: false, loading: () => <Box minH="160px" /> })
const DoorSheet = dynamic(() => import('./DoorSheet'), { ssr: false })

export interface ForecastLandingProps {
  headline: HeadlineKey
  census: CensusSummary | null
  /** Optional: the migrate flow's own handlers. Absent, the page's sheet opens. */
  doors?: Partial<DoorHandlers>
}

const LINK_BTN = {
  variant: 'unstyled' as const,
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

export const ForecastLanding: React.FC<ForecastLandingProps> = ({ headline, census, doors }) => {
  const r = useReplay(headline)
  // Client-only pieces mount after hydration, so the server HTML and the first client
  // render match exactly (a preloaded dynamic() chunk would otherwise render early).
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const [manualOpen, setManualOpen] = useState(false)
  const [sheet, setSheet] = useState<{ door: Door; intent: PositionIntent } | null>(null)
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
    (door: Door) => (i: PositionIntent) => {
      track({ name: 'deploy_click', headline, door, isDemo: r.isDemo, address: i.address, protocol: i.protocol, debtUsd: i.debt.reduce((a, d) => a + d.valueUsd, 0) })
      const custom = door === 'migrate' ? doors?.onMigrate : doors?.onDeployFresh
      if (custom) custom(i)
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

  return (
    <Box maxW="1180px" mx="auto" px={{ base: SPACING.base, md: SPACING.lg }} pb={SPACING['2xl']} color={SEMANTIC_COLORS.textPrimary} display="grid" gap={SPACING.xl} minW={0}>
      {/* MASTHEAD: dateline between double rules. */}
      <Box borderTop={ruleStrong} borderBottom={ruleStrong} mt={SPACING.base} py={SPACING.xs} display="flex" justifyContent="space-between" flexWrap="wrap" gap={SPACING.sm}>
        <Text {...kicker}>Membrane · the replay desk</Text>
        <Text {...kicker} display={{ base: 'none', md: 'block' }}>
          Scenario · 10 Oct 2025 · Chainlink oracle, 1-minute
        </Text>
      </Box>

      {/* S — ABOVE THE FOLD */}
      <Box as="header" display="grid" gap={SPACING.base} minW={0}>
        <Text {...kicker}>Replay · your borrow on 10 Oct 2025</Text>
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
          {HEADLINES[headline].headline}
        </Text>
        <Text as="p" {...deck} maxW="60ch" data-testid="landing-subhead">
          {SUBHEAD}
        </Text>
        <Box display="grid" gap={SPACING.sm} justifyItems="start" minW={0}>
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
            readNote="Read-only · no signature · no deposit · no email"
          />
          <Button {...LINK_BTN} data-testid="manual-toggle" aria-expanded={manualOpen} onClick={() => setManualOpen((v) => !v)}>
            {manualOpen ? 'Hide manual entry' : 'Or enter a position by hand'}
          </Button>
        </Box>
        {manualOpen && <ManualPositionForm protocols={r.protocols} initial={r.manual} onSubmit={r.submitManual} error={r.manualError} />}
      </Box>

      {/* RETURN VISIT */}
      {(r.visitState === 'returning' || r.visitState === 'changed') && r.delta && r.shownAddress && (
        <Box data-testid={`return-${r.visitState}`} borderTop={rule} pt={SPACING.sm} display="grid" gap={SPACING.xs}>
          <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize="20px">
            {r.visitState === 'changed' ? 'Your position changed since last time. Size lines first.' : 'Welcome back. Your position, re-read today and replayed again.'}
          </Text>
          <Text {...small} {...tabularNums}>
            {shortAddress(r.shownAddress)} · last visit {sinceText(r.delta.sinceMs)} · debt {usdSigned(r.delta.debtUsd)} · collateral {usdSigned(r.delta.collateralUsd)} · LTV{' '}
            {r.delta.ltvPoints >= 0 ? '+' : '−'}
            {Math.abs(r.delta.ltvPoints * 100).toFixed(1)} pts · gap {usdSigned(r.delta.lessUsd)} (simulator)
          </Text>
        </Box>
      )}

      {/* T + O — THE CHART */}
      <Box display="grid" gap={SPACING.md} minW={0}>
        <DemoBanner show={r.isDemo} note={`a real wallet Aave V3 liquidated on ${DEMO_BORROWER_DATE} · paste yours above`} />
        <Box display="flex" flexWrap="wrap" gap={SPACING.sm} alignItems="center" data-testid="scenario-picker" role="radiogroup" aria-label="Stress window">
          <Text {...kicker}>Stress window</Text>
          {SCENARIOS.map((s) => {
            const active = s.id === r.scenarioId
            return s.status === 'live' ? (
              <Button
                key={s.id}
                role="radio"
                aria-checked={active}
                onClick={() => r.setScenarioId(s.id)}
                minH="44px"
                borderRadius={0}
                variant="outline"
                borderColor={active ? SEMANTIC_COLORS.textPrimary : SEMANTIC_COLORS.borderSubtle}
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="11px"
                _focus={FOCUS_STYLES.ring}
              >
                {s.label}
              </Button>
            ) : (
              <Text key={s.id} {...small} color={SEMANTIC_COLORS.textTertiary} title={s.needs} data-testid={`scenario-coming-${s.id}`}>
                {s.label} · coming
              </Text>
            )
          })}
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
          />
        )}


        <Box display="flex" flexWrap="wrap" gap={SPACING.md} alignItems="center" borderTop={rule} pt={SPACING.sm} data-testid="share-row">
          <Button {...LINK_BTN} onClick={onCopy} data-testid="share-copy">
            {copied === 'copied' ? 'Link copied' : copied === 'failed' ? 'Copy failed' : 'Copy link to this result'}
          </Button>
          {cardHref && (
            <Text {...kicker}>
              <a href={cardHref} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'underline' }} data-testid="share-card">
                Result card (image) →
              </a>
            </Text>
          )}
          <Text {...kicker}>
            <NextLink href={`/ethereum/simulator${r.mode === 'address' && r.shownAddress ? `?a=${r.shownAddress}` : ''}`} style={{ textDecoration: 'underline' }}>
              Full run detail →
            </NextLink>
          </Text>
        </Box>
      </Box>

      {/* R — THE REVEAL AND THE TWO DOORS */}
      <Doors intent={intent} onMigrate={open('migrate')} onDeployFresh={open('fresh')} />

      {/* Y — OBJECTIONS */}
      <ObjectionCards census={census} />

      {/* HOW IT WORKS — static prose, server-rendered (SEO R1/R10). */}
      <Box as="section" aria-labelledby="landing-how" display="grid" gap={SPACING.sm} borderTop={ruleStrong} pt={SPACING.base} maxW="72ch">
        <Text id="landing-how" as="h2" fontFamily={TYPOGRAPHY.fontDisplay} fontSize={{ base: '22px', md: '28px' }} fontWeight={TYPOGRAPHY.normal}>
          How the replay works
        </Text>
        {PROSE.map((p) => (
          <Text key={p.slice(0, 24)} as="p" {...small} fontSize="13px" color={SEMANTIC_COLORS.textPrimary}>
            {p}
          </Text>
        ))}
      </Box>

      <Text {...credit} textAlign="left" data-testid="return-pending-states">
        Return visits · {PENDING_STATES['after-event']} {PENDING_STATES.deployed}
      </Text>
      <Text {...credit}>† modelled, not a guarantee · Membrane figures are simulator output · data compiled by Membrane</Text>

      {sheet && <DoorSheet door={sheet.door} intent={sheet.intent} onClose={() => setSheet(null)} />}
    </Box>
  )
}

export default ForecastLanding
