// UNDER THE FOLD: THE PRODUCT.
//
// Owner layout ruling 2026-09-12 — ONE landing page. "The sim is borrows, while under the
// fold is carries." The hero sells carry in a single subhead and the simulator PROVES the
// rails with a borrow verdict; this block is where the carry product is actually sold, and
// it sells with EVIDENCE rather than description:
//
//   a. what it is, in three lines
//   b. the claims, verbatim from CARRY_CLAIMS (ClaimsBlock)
//   c. proof — live tiles off /api/strats and /api/venues/log, plus the modelled crossing
//   d. the way back up to the paste box, and out to the two live boards
//
// HONESTY RULES, non-negotiable on this surface:
//   - every number here is FETCHED LIVE or STAMPED MODELLED. Nothing is invented, and no
//     figure is hard-coded into this file.
//   - a tile that has not fetched yet renders EMPTY (a thin pulsing baseline), never a
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
import { alarmConsequence, consequence, type Entry } from '@/components/Carry/venueLogLogic'
import { fmtUsd } from '@/components/Radar/radarLogic'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { useChainRoute } from '@/hooks/useChainRoute'
import { demoDetection } from '@/lib/position-sim/demo'
import { stamp, type Provenance } from '@/lib/position-sim/types'
import Stamp from './Stamp'

const LIVE_STRATS = stamp('onchain', 'live · /api/strats', 'Tracked carry strats, refreshed by the hourly recorder; served from stored scans.')
const LIVE_LOG = stamp('onchain', 'live · /api/venues/log', 'Venue state changes recorded hourly; only discrete changes and >20% liquidity moves become entries.')
import type { VenueDetection } from '@/lib/position-sim/venues'

import ClaimsBlock from './ClaimsBlock'
import VenueCapacity from './VenueCapacity'
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

const Tile: React.FC<{
  label: string
  stamp: Provenance
  pending: boolean
  children: React.ReactNode
}> = ({ label, stamp, pending, children }) => (
  <Box
    border="1px solid"
    borderColor={SEMANTIC_COLORS.borderSubtle}
    bg={SEMANTIC_COLORS.bgPrimary}
    borderRadius={0}
    p={SPACING.base}
    display="grid"
    gap={SPACING.sm}
    alignContent="start"
  >
    <Box minH="26px" display="flex" alignItems="center">
      {pending ? <Pending /> : children}
    </Box>
    <Text
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize="10px"
      letterSpacing="0.24em"
      textTransform="uppercase"
      color={SEMANTIC_COLORS.textSecondary}
    >
      {label}
    </Text>
    <Stamp provenance={stamp} />
  </Box>
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

type StratsSummary = { count: number; total_usd: number }

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
  /** The hero's address-bar props, so the reader can run a wallet from HERE without
   *  scrolling back up (owner 2026-09-21). */
  addressBar?: AddressBarProps
  /** The debt on the position currently on screen. 0 when there is none. */
  positionDebtUsd?: number
  /**
   * The venue detection on screen — the demo's, or the one a pasted address produced.
   *
   * Expected POST-excludeOwnCollateral (Simulator.tsx filters on the way in). Optional
   * so this block still renders standalone; when it is omitted it falls back to the
   * committed demo snapshot, which is what the page opens on anyway.
   */
  detection?: VenueDetection
}

/** No position, no debt, still a real chart: the crossing is sized at a plain reference
 *  notional rather than at zero. It is modelled either way and stamped as such. */
const REFERENCE_SIZE_USD = 250_000

export const CarrySection: React.FC<CarrySectionProps> = ({ positionDebtUsd = 0, detection, addressBar }) => {
  const [openPanel, setOpenPanel] = useState<'board' | 'strats' | null>(null)
  const toggle = (p: 'board' | 'strats') => setOpenPanel((cur) => (cur === p ? null : p))
  const { chainName } = useChainRoute()
  // demoDetection() reads the committed snapshot and is pure, but it re-stamps its
  // provenance on every call — memoise so the venue rows do not re-key each render.
  const demoDet = React.useMemo(() => demoDetection(), [])
  const shown = detection ?? demoDet
  const { data: strats } = useStratsSummary()
  const { data: log } = useVenueLog()

  const stratsPending = !strats
  const logPending = !log
  // Newest entry that says something about capacity — terms-hash churn is not it.
  const newest: Entry | undefined = log?.entries?.find((e) => e.kind !== 'terms_page_changed')
  const newestLine = newest
    ? (newest.provenance === 'alarm' ? alarmConsequence(newest) : consequence(newest)).text
    : null

  const amountUsd = positionDebtUsd > 0 ? positionDebtUsd : REFERENCE_SIZE_USD

  return (
    <Box data-testid="sim-carry-section" display="grid" gap={SPACING.lg}>
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

      {/* b — THE FOUR CLAIMS, verbatim from CARRY_CLAIMS + its caveat. */}
      <ClaimsBlock />

      {/* c — THE EVIDENCE. Live tiles, then the modelled crossing. */}
      <Box display="grid" gap={SPACING.base}>
        <Box
          display="grid"
          gridTemplateColumns={{ base: '1fr', md: 'repeat(3, 1fr)' }}
          gap={SPACING.base}
        >
          <Tile label="tracked carry strats" stamp={LIVE_STRATS} pending={stratsPending}>
            <Figure>{strats?.count ?? 0}</Figure>
          </Tile>

          <Tile label="at risk in those books" stamp={LIVE_STRATS} pending={stratsPending}>
            <Figure>{fmtUsd(strats?.total_usd ?? 0)}</Figure>
          </Tile>

          <Tile
            label={
              newest
                ? `last venue change · ${newest.venue} · ${new Date(newest.at).toISOString().slice(0, 10)}`
                : 'last venue change'
            }
            stamp={LIVE_LOG}
            pending={logPending}
          >
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="11.5px"
              lineHeight={1.55}
              color={newestLine ? SEMANTIC_COLORS.textPrimary : SEMANTIC_COLORS.textSecondary}
            >
              {newestLine ?? 'no venue change recorded yet'}
            </Text>
          </Tile>
        </Box>

        {/* Owner ruling 2026-09-12: "Show our venue visualizer for the carrier's
            deployments." The claim above is that venue capital answers the margin
            call; this is the evidence that the venue could actually return it. */}
        <VenueCapacity detection={shown} />

        <Box display="grid" gap={SPACING.sm}>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="11px"
            lineHeight={1.6}
            color={SEMANTIC_COLORS.textSecondary}
          >
            exit cost priced into the yield — where the cheaper venue stops being cheaper
          </Text>
          {/* CROSSING_STAMP and the "modelled" chip are the component's own and stay
              visible. Do not wrap this in anything that hides them. */}
          <CrossingChart amountUsd={amountUsd} />
        </Box>
      </Box>

      {/* d — THE WAY ON. A second paste box (nobody scrolls back up for one), and the
          board and the strats OPEN HERE instead of navigating away. */}
      <Box display="grid" gap={SPACING.md}>
        {/* paste box on the left, the two panel toggles stacked to its right */}
        {/* Wide: paste box + a button column that stretches to the box's full height.
            Narrow: the column drops under the box and matches its WIDTH instead. */}
        <Box
          display="grid"
          gridTemplateColumns={{ base: '1fr', md: 'minmax(0, 560px) auto' }}
          gap={SPACING.md}
          justifyContent="center"
          alignItems="stretch"
        >
          {addressBar ? (
            <AddressBar {...addressBar} inputId="sim-address-input-carry" />
          ) : (
            <Button type="button" onClick={focusAddressBar} {...CTA_BTN} w="fit-content">
              Run your position ↑
            </Button>
          )}
          <Box
            display="grid"
            gridTemplateRows="1fr 1fr"
            gap={SPACING.sm}
            w={{ base: '100%', md: 'auto' }}
            maxW={{ base: '560px', md: 'none' }}
            justifySelf={{ base: 'center', md: 'stretch' }}
          >
          <Button
            type="button"
            onClick={() => toggle('board')}
            aria-expanded={openPanel === 'board'}
            {...CTA_BTN}
            h="100%"
            w="100%"
            {...(openPanel === 'board' ? { borderColor: SEMANTIC_COLORS.success, color: SEMANTIC_COLORS.success } : {})}
          >
            {openPanel === 'board' ? 'Hide the carry board ↑' : 'See the carry board ↓'}
          </Button>
          <Button
            type="button"
            onClick={() => toggle('strats')}
            aria-expanded={openPanel === 'strats'}
            {...CTA_BTN}
            h="100%"
            w="100%"
            {...(openPanel === 'strats' ? { borderColor: SEMANTIC_COLORS.success, color: SEMANTIC_COLORS.success } : {})}
          >
            {openPanel === 'strats' ? 'Hide tracked strats ↑' : 'Tracked strats ↓'}
          </Button>
          </Box>
        </Box>
        <Collapse in={openPanel === 'board'} animateOpacity unmountOnExit>
          <Box data-testid="sim-inline-board" pt={SPACING.sm} display="grid" gap={SPACING.sm} w="100%">
            <MarketBoards onLoadBoard={() => window.location.assign(`/${chainName}/carry`)} />
            <NextLink href={`/${chainName}/carry`} style={{ textDecoration: 'underline' }}>
              <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11px" color={SEMANTIC_COLORS.textSecondary}>
                full carry page →
              </Text>
            </NextLink>
          </Box>
        </Collapse>
        <Collapse in={openPanel === 'strats'} animateOpacity unmountOnExit>
          <Box data-testid="sim-inline-strats" pt={SPACING.sm} display="grid" gap={SPACING.sm} w="100%">
            <StratsBoard />
            <NextLink href={`/${chainName}/strats`} style={{ textDecoration: 'underline' }}>
              <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11px" color={SEMANTIC_COLORS.textSecondary}>
                full strats page →
              </Text>
            </NextLink>
          </Box>
        </Collapse>
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
