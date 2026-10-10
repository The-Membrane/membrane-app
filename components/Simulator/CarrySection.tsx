// The landing's carry proof: routes first, then the tracked books in one place.
// Exit-cost modelling belongs on each venue page, not in a global landing claim.

import React from 'react'
import NextLink from 'next/link'
import { Box, Button, Text } from '@chakra-ui/react'
import { useQuery } from '@tanstack/react-query'

import MarketBoards from '@/components/Carry/MarketBoards'
import { capacityMove, type Entry } from '@/components/Carry/venueLogLogic'
import StratsBoard from '@/components/Strats/StratsBoard'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { useChainRoute } from '@/hooks/useChainRoute'
import { stamp } from '@/lib/position-sim/types'

import AddressBar, { type AddressBarProps } from './AddressBar'
import ClaimsBlock from './ClaimsBlock'
import Stamp from './Stamp'
import { HERO_SUBHEAD } from './VerdictHero'

const LIVE_LOG = stamp(
  'onchain',
  'live · /api/venues/log',
  'Venue state changes recorded hourly; only discrete changes and >20% liquidity moves become entries.',
)

const useVenueLog = () =>
  useQuery<{ entries: Entry[] }>({
    queryKey: ['venue_log'],
    queryFn: async () => {
      const response = await fetch('/api/venues/log')
      if (!response.ok) throw new Error(`venue log ${response.status}`)
      return response.json()
    },
    staleTime: 1000 * 60 * 5,
    refetchOnMount: true,
  })

export const CTA_BTN = {
  bg: 'transparent',
  border: '1px solid',
  borderColor: SEMANTIC_COLORS.borderStrong,
  color: SEMANTIC_COLORS.textPrimary,
  borderRadius: 0,
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: '12px',
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

export const focusAddressBar = (): void => {
  if (typeof document === 'undefined') return
  const input = document.getElementById('sim-address-input') as HTMLInputElement | null
  if (!input) return
  input.scrollIntoView({ behavior: 'smooth', block: 'center' })
  input.focus({ preventScroll: true })
}

export const CarrySection: React.FC = () => {
  const { chainName } = useChainRoute()
  const { data: log, isLoading: logLoading } = useVenueLog()
  const newestMove = log?.entries?.map(capacityMove).find((move) => move !== null) ?? null

  return (
    <Box data-testid="sim-carry-section" minW={0} display="grid" gap={SPACING.xl}>
      <Box display="grid" gap={SPACING.sm}>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="12px"
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

      <ClaimsBlock />

      <Box id="sim-inline-board" data-testid="sim-inline-board" display="grid" gap={SPACING.base}>
        <MarketBoards routesOnly />
        <Box
          p={SPACING.base}
          border="1px solid"
          borderColor={SEMANTIC_COLORS.borderSubtle}
          bg={SEMANTIC_COLORS.bgPrimary}
          display="grid"
          gap={SPACING.sm}
        >
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="12px"
            letterSpacing="0.2em"
            textTransform="uppercase"
            color={SEMANTIC_COLORS.textSecondary}
          >
            latest measured capacity move
          </Text>
          {newestMove ? (
            <>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="18px"
                color={SEMANTIC_COLORS.textPrimary}
              >
                {newestMove.venue} exit capacity {newestMove.change}
              </Text>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="12px"
                color={SEMANTIC_COLORS.textSecondary}
              >
                {newestMove.metric} · {newestMove.from} → {newestMove.to} {newestMove.window} ·{' '}
                {new Date(newestMove.at).toISOString().slice(0, 10)}
              </Text>
            </>
          ) : (
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="12px"
              color={SEMANTIC_COLORS.textSecondary}
            >
              {logLoading ? 'Reading venue log…' : 'No measured capacity change recorded yet.'}
            </Text>
          )}
          <Stamp provenance={LIVE_LOG} />
        </Box>
        <NextLink href={`/${chainName}/carry`} style={{ textDecoration: 'underline' }}>
          <Text
            as="span"
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="12px"
            color={SEMANTIC_COLORS.textSecondary}
          >
            full carry board →
          </Text>
        </NextLink>
      </Box>

      <Box id="sim-inline-strats" data-testid="sim-inline-strats" minW={0}>
        <StratsBoard embedded />
        <NextLink href={`/${chainName}/carry#strats`} style={{ textDecoration: 'underline' }}>
          <Text
            as="span"
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="12px"
            color={SEMANTIC_COLORS.textSecondary}
          >
            carry strats on the full board →
          </Text>
        </NextLink>
      </Box>
    </Box>
  )
}

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
