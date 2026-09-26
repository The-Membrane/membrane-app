// UNDER THE FOLD: THE PRODUCT.
//
// Owner layout ruling 2026-09-12 — ONE landing page. "The sim is borrows, while under the
// fold is carries." The hero sells carry in a single subhead and the simulator PROVES the
// rails with a borrow verdict; this block is where the carry product is actually sold, and
// it sells with EVIDENCE rather than description:
//
//   a. what it is, in three lines
//   b. the claims, verbatim from CARRY_CLAIMS (ClaimsBlock)
//   c. proof — tracked capital and venue change receipts, plus direct access to the boards
//   d. the modelled crossing, with its assumptions available on demand
//
// HONESTY RULES, non-negotiable on this surface:
//   - every number here is FETCHED LIVE or STAMPED MODELLED. Nothing is invented, and no
//     figure is hard-coded into this file.
//   - live evidence that has not fetched yet renders EMPTY (a thin pulsing baseline), never a
//     stale or placeholder number — the same discipline as DesireRouter.
//   - CrossingChart carries CROSSING_STAMP and a "modelled" chip of its own. It stays
//     visible. That chart is a MODEL, not an observation, and it must keep saying so.
//
// Rendered for BOTH modes at the same slot (Simulator.tsx), so the carry-first page and
// the borrower landing page make the same argument from the same component.

import React, { useState } from 'react'
import NextLink from 'next/link'
import { keyframes } from '@emotion/react'
import { Box, Button, Collapse, Text } from '@chakra-ui/react'
import { useQuery } from '@tanstack/react-query'

import CrossingChart from '@/components/Carry/CrossingChart'
import MarketBoards from '@/components/Carry/MarketBoards'
import StratsBoard from '@/components/Strats/StratsBoard'
import AddressBar, { type AddressBarProps } from './AddressBar'
import { alarmConsequence, capacityMove, consequence, type Entry } from '@/components/Carry/venueLogLogic'
import { CapacityCurve } from '@/components/Venue/CapacityCurve'
import { fmtUsd } from '@/components/Radar/radarLogic'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { useChainRoute } from '@/hooks/useChainRoute'
import { stamp } from '@/lib/position-sim/types'
import Stamp from './Stamp'

const STORED_STRATS = stamp(
  'dataset',
  'stored · /api/strats',
  'Tracked positions are cached mainnet reads. The scan timestamp, not the API fetch time, determines freshness.',
)
const LIVE_LOG = stamp(
  'onchain',
  'live · /api/venues/log',
  'Venue state changes recorded hourly; only discrete changes and >20% liquidity moves become entries.',
)
import ClaimsBlock from './ClaimsBlock'
import { HERO_SUBHEAD } from './VerdictHero'

/** Same button as ComparisonPanel's — one CTA style on this page, not two. */
export const CTA_BTN = {
  bg: 'transparent',
  border: '1px solid',
  borderColor: SEMANTIC_COLORS.borderStrong,
  color: SEMANTIC_COLORS.textPrimary,
  borderRadius: 0,
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: '10px',
  letterSpacing: '0.24em',
  textTransform: 'uppercase' as const,
  h: 'auto',
  px: SPACING.md,
  py: SPACING.sm,
  transition: TRANSITIONS.colors,
  _hover: {
    borderColor: SEMANTIC_COLORS.success,
    color: SEMANTIC_COLORS.success,
    bg: 'transparent',
  },
  _active: { opacity: 0.85 },
  _focus: FOCUS_STYLES.ring,
}

/**
 * Back up to the one action the page asks for. The id lives on AddressBar's input; if it
 * is not on the page (it always is, but a caller could render this block alone) the click
 * is a silent no-op rather than a thrown error.
 */
export const focusAddressBar = (): void => {
  if (typeof document === 'undefined') return
  const el = document.getElementById('sim-address-input') as HTMLInputElement | null
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  el.focus({ preventScroll: true })
}

const pulse = keyframes`
  0% { opacity: 0.18; }
  50% { opacity: 0.55; }
  100% { opacity: 0.18; }
`

/** The empty state of a live tile: a baseline, breathing. Never a number. */
const Pending: React.FC = () => (
  <Box
    data-testid="sim-carry-tile-pending"
    h="2px"
    w="56px"
    bg={SEMANTIC_COLORS.textTertiary}
    animation={`${pulse} 1.6s ease-in-out infinite`}
  />
)

const Figure: React.FC<{ children: React.ReactNode; color?: string }> = ({ children, color }) => (
  <Text
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="clamp(20px, 3vw, 30px)"
    lineHeight={1.05}
    sx={{ fontVariantNumeric: 'tabular-nums' }}
    color={color ?? SEMANTIC_COLORS.textPrimary}
  >
    {children}
  </Text>
)

const EvidenceDoor: React.FC<{
  title: string
  body: React.ReactNode
  open: boolean
  controls: string
  onClick: () => void
}> = ({ title, body, open, controls, onClick }) => (
  <Button
    type="button"
    onClick={onClick}
    aria-expanded={open}
    aria-controls={controls}
    h="auto"
    minH="112px"
    px={{ base: SPACING.base, md: SPACING['3xl'] }}
    py={SPACING.base}
    w="100%"
    display="grid"
    gridTemplateColumns="minmax(0, 1fr)"
    justifyItems="start"
    justifyContent="stretch"
    alignContent="space-between"
    gap={SPACING.md}
    whiteSpace="normal"
    textAlign="left"
    border="1px solid"
    borderColor={open ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.borderSubtle}
    borderRadius={0}
    bg={SEMANTIC_COLORS.bgPrimary}
    color={SEMANTIC_COLORS.textPrimary}
    transition={TRANSITIONS.colors}
    _hover={{ borderColor: SEMANTIC_COLORS.success, bg: SEMANTIC_COLORS.bgPrimary }}
    _active={{ opacity: 0.85 }}
    _focus={FOCUS_STYLES.ring}
  >
    <Box w="100%">
      <Text
        fontFamily={TYPOGRAPHY.fontDisplay}
        fontSize="20px"
        lineHeight={1.15}
        color={open ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.textPrimary}
      >
        {title}
      </Text>
      <Text
        mt={SPACING.xs}
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="11px"
        lineHeight={1.55}
        color={SEMANTIC_COLORS.textSecondary}
      >
        {body}
      </Text>
    </Box>
    <Text
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize="10px"
      letterSpacing="0.18em"
      textTransform="uppercase"
      color={SEMANTIC_COLORS.success}
    >
      {open ? 'close ↑' : 'open ↓'}
    </Text>
  </Button>
)

type StratsSummary = { count: number; total_usd: number; freshest_scan: string | null }

/** The two live reads this block makes. Both override the app-wide refetchOnMount:false
 *  default, so an empty or errored first fetch cannot stick for the whole session. */
const useStratsSummary = () =>
  useQuery<StratsSummary>({
    queryKey: ['strats_summary'],
    queryFn: async () => {
      const r = await fetch('/api/strats')
      if (!r.ok) throw new Error(`strats ${r.status}`)
      return r.json()
    },
    staleTime: 1000 * 60 * 5,
    refetchOnMount: true,
  })

const useVenueLog = () =>
  useQuery<{ entries: Entry[] }>({
    queryKey: ['venue_log'],
    queryFn: async () => {
      const r = await fetch('/api/venues/log')
      if (!r.ok) throw new Error(`venue log ${r.status}`)
      return r.json()
    },
    staleTime: 1000 * 60 * 5,
    refetchOnMount: true,
  })

export interface CarrySectionProps {
  /** The debt on the position currently on screen. 0 when there is none. */
  positionDebtUsd?: number
}

/** No position, no debt, still a real chart: the crossing is sized at a plain reference
 *  notional rather than at zero. It is modelled either way and stamped as such. */
const REFERENCE_SIZE_USD = 250_000

export const CarrySection: React.FC<CarrySectionProps> = ({ positionDebtUsd = 0 }) => {
  const [openPanel, setOpenPanel] = useState<'board' | 'strats' | null>(null)
  const toggle = (p: 'board' | 'strats') => setOpenPanel((cur) => (cur === p ? null : p))
  const { chainName } = useChainRoute()
  const { data: strats } = useStratsSummary()
  const { data: log } = useVenueLog()

  const stratsPending = !strats
  const logPending = !log
  const newestMove = log?.entries?.map(capacityMove).find((move) => move !== null) ?? null
  const scanTime = strats?.freshest_scan ? new Date(strats.freshest_scan) : null
  const scanAgeMs = scanTime ? Date.now() - scanTime.getTime() : Number.POSITIVE_INFINITY
  const scanStale = !Number.isFinite(scanAgeMs) || scanAgeMs > 2 * 60 * 60 * 1000
  const scanNote =
    scanTime && Number.isFinite(scanTime.getTime())
      ? `${scanStale ? 'stale' : 'scanned'} ${scanTime.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
      : 'no completed scan'

  const amountUsd = positionDebtUsd > 0 ? positionDebtUsd : REFERENCE_SIZE_USD

  return (
    <Box
      data-testid="sim-carry-section"
      minW={0}
      display="grid"
      gridTemplateColumns="minmax(0, 1fr)"
      gap={SPACING.lg}
    >
      {/* a — WHAT IT IS */}
      <Box display="grid" gap={SPACING.sm}>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="10px"
          letterSpacing="0.24em"
          textTransform="uppercase"
          color={SEMANTIC_COLORS.textSecondary}
        >
          the product
        </Text>
        <Text
          as="h2"
          fontFamily={TYPOGRAPHY.fontDisplay}
          fontSize="clamp(26px, 4vw, 40px)"
          lineHeight={1.1}
          letterSpacing="-0.015em"
          color={SEMANTIC_COLORS.textPrimary}
          sx={{ textWrap: 'balance' }}
        >
          Carry that recalls debt instead of liquidating you.
        </Text>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="13px"
          lineHeight={1.6}
          color={SEMANTIC_COLORS.textSecondary}
          maxW="72ch"
        >
          Borrow against your collateral, deploy the debt into a venue, and the venue capital is
          what answers a margin call.
        </Text>
      </Box>

      {/* b — THREE VERIFIED REASONS, verbatim from CARRY_CLAIMS. */}
      <ClaimsBlock />

      {/* c — THE EVIDENCE. Capital first, then direct access to the two boards. */}
      <Box display="grid" gap={SPACING.base}>
        <Box
          display="grid"
          gridTemplateColumns={{
            base: 'minmax(0, 1fr)',
            md: 'minmax(0, 1.45fr) minmax(280px, 0.8fr)',
          }}
          border="1px solid"
          borderColor={SEMANTIC_COLORS.borderSubtle}
          bg={SEMANTIC_COLORS.bgPrimary}
        >
          <Box
            minW={0}
            p={{ base: SPACING.base, md: SPACING.lg }}
            display="grid"
            gap={SPACING.md}
            borderRight={{ base: 'none', md: '1px solid' }}
            borderBottom={{ base: '1px solid', md: 'none' }}
            borderColor={SEMANTIC_COLORS.borderSubtle}
          >
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="10px"
              letterSpacing="0.24em"
              textTransform="uppercase"
              color={SEMANTIC_COLORS.textSecondary}
            >
              capital across tracked strategies
            </Text>
            {stratsPending ? (
              <Pending />
            ) : (
              <Box display="grid" gap={SPACING.sm}>
                <Figure>{fmtUsd(strats?.total_usd ?? 0)}</Figure>
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={{ base: '12px', md: '13px' }}
                  lineHeight={1.6}
                  color={SEMANTIC_COLORS.textPrimary}
                >
                  measured across{' '}
                  <Text as="span" color={SEMANTIC_COLORS.success} fontWeight={600}>
                    {strats?.count ?? 0} tracked strategies
                  </Text>
                  , refreshed from stored mainnet reads. Exit capacity is tested below.
                </Text>
              </Box>
            )}
            <Stamp provenance={STORED_STRATS} note={scanNote} />
          </Box>

          <Box p={SPACING.base} display="grid" gap={SPACING.sm} alignContent="space-between">
            <Box display="grid" gap={SPACING.sm}>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="10px"
                letterSpacing="0.24em"
                textTransform="uppercase"
                color={SEMANTIC_COLORS.textSecondary}
              >
                latest measured capacity move
              </Text>
              {logPending ? (
                <Pending />
              ) : newestMove ? (
                <Box display="grid" gap={SPACING.xs}>
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize="clamp(18px, 2.3vw, 25px)"
                    lineHeight={1.2}
                    color={SEMANTIC_COLORS.textPrimary}
                    sx={{ fontVariantNumeric: 'tabular-nums' }}
                  >
                    {newestMove.venue} exit capacity {newestMove.change}
                  </Text>
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize="12px"
                    lineHeight={1.5}
                    color={SEMANTIC_COLORS.textSecondary}
                  >
                    {newestMove.metric} · {newestMove.from} → {newestMove.to} {newestMove.window} ·{' '}
                    {new Date(newestMove.at).toISOString().slice(0, 10)}
                  </Text>
                </Box>
              ) : (
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize="12px"
                  color={SEMANTIC_COLORS.textSecondary}
                >
                  No measured capacity change recorded yet.
                </Text>
              )}
              {/* A pool reserve is not an exit at par (owner 2026-09-26): what exits
                  within 0.5 / 1 / 5% cost incl. fees, on-chain quotes, block-stamped. */}
              {newest && <CapacityCurve venue={newest.venue} variant="compact" />}
            </Box>
            <Stamp provenance={LIVE_LOG} />
          </Box>
        </Box>

        <Box
          display="grid"
          gridTemplateColumns={{
            base: 'minmax(0, 1fr)',
            md: 'repeat(2, minmax(0, 1fr))',
          }}
          gap={SPACING.sm}
        >
          <EvidenceDoor
            title="Open the carry board"
            body="Compare the yields that survive their recorded exit costs, including the losing routes."
            open={openPanel === 'board'}
            controls="sim-inline-board"
            onClick={() => toggle('board')}
          />
          <EvidenceDoor
            title="Inspect the tracked books"
            body={
              strats
                ? `${fmtUsd(strats.total_usd)} across ${strats.count} strategies, sorted by capital and weakest venue.`
                : 'Mainnet strategy books, sorted by capital and weakest venue.'
            }
            open={openPanel === 'strats'}
            controls="sim-inline-strats"
            onClick={() => toggle('strats')}
          />
        </Box>

        <Collapse in={openPanel === 'board'} animateOpacity unmountOnExit>
          <Box
            id="sim-inline-board"
            data-testid="sim-inline-board"
            pt={SPACING.sm}
            display="grid"
            gap={SPACING.sm}
            w="100%"
          >
            <MarketBoards routesOnly />
            <NextLink href={`/${chainName}/carry`} style={{ textDecoration: 'underline' }}>
              <Text
                as="span"
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="11px"
                color={SEMANTIC_COLORS.textSecondary}
              >
                full carry page →
              </Text>
            </NextLink>
          </Box>
        </Collapse>
        <Collapse in={openPanel === 'strats'} animateOpacity unmountOnExit>
          <Box
            id="sim-inline-strats"
            data-testid="sim-inline-strats"
            pt={SPACING.sm}
            display="grid"
            gap={SPACING.sm}
            w="100%"
          >
            <StratsBoard />
            <NextLink href={`/${chainName}/strats`} style={{ textDecoration: 'underline' }}>
              <Text
                as="span"
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="11px"
                color={SEMANTIC_COLORS.textSecondary}
              >
                full strats page →
              </Text>
            </NextLink>
          </Box>
        </Collapse>

        <Box display="grid" gap={SPACING.sm}>
          {/* CROSSING_STAMP and the "modelled" chip are the component's own and stay
              visible. Do not wrap this in anything that hides them. */}
          <CrossingChart amountUsd={amountUsd} />
        </Box>
      </Box>
    </Box>
  )
}

/**
 * THE REPEAT, at the very foot of the page. Same sentence as the hero (imported, never
 * retyped) and the same two actions, so a reader who scrolled the whole page never has to
 * scroll back to find out what to do.
 */
export const SimCtaRepeat: React.FC<{ addressBar?: AddressBarProps }> = ({ addressBar }) => {
  const { chainName } = useChainRoute()
  return (
    <Box
      data-testid="sim-cta-repeat"
      borderTop="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
      pt={SPACING.base}
      display="flex"
      gap={SPACING.base}
      flexWrap="wrap"
      alignItems="center"
      justifyContent="space-between"
    >
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="13px"
        lineHeight={1.55}
        color={SEMANTIC_COLORS.textSecondary}
        maxW="70ch"
      >
        {HERO_SUBHEAD}
      </Text>
      <Box display="grid" gap={SPACING.md} flex="1 1 420px">
        {addressBar ? (
          <AddressBar {...addressBar} inputId="sim-address-input-foot" />
        ) : (
          <Button type="button" onClick={focusAddressBar} {...CTA_BTN} w="fit-content">
            Run your position ↑
          </Button>
        )}
        <NextLink href={`/${chainName}/carry`} style={{ textDecoration: 'none' }}>
          <Button as="span" {...CTA_BTN}>
            See the carry board →
          </Button>
        </NextLink>
      </Box>
    </Box>
  )
}

export default CarrySection
