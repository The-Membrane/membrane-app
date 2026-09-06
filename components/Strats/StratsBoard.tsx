import React from 'react'
import { Box, Grid, HStack, Text, Wrap, WrapItem } from '@chakra-ui/react'
import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'next/router'
import NextLink from 'next/link'

import { Card } from '@/components/ui/Card'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { SectionHeading, Stamp } from '@/components/Carry/atoms'
import { fmtUsd, type Verdict } from '@/components/Radar/radarLogic'
import type { StratRow, DeltaDir } from '@/components/Strats/stratsLogic'

// Carry Strats — the auto-tracked, WALLET-FREE, shareable dashboard. It scans
// mainnet for real carry positions (scripts/discover-carry-strats.mjs) and shows
// each tracked strat's entry→now delta and weakest-prong verdict. Every number is
// a cached chain read or a recorded corpus row (see /api/strats); nothing modelled.

type StratsResponse = {
  count: number
  total_usd: number
  freshest_scan: string | null
  strats: StratRow[]
  provenance: {
    recorded: { window: string; note: string; flow_rows: number; snapshot_rows: number }
    modelled: null
  }
}

const VERDICT_COLOR: Record<Verdict, string> = {
  clear: SEMANTIC_COLORS.success,
  caution: SEMANTIC_COLORS.warning,
  exposed: SEMANTIC_COLORS.danger,
}
const DELTA_COLOR: Record<DeltaDir, string> = {
  up: SEMANTIC_COLORS.success,
  down: SEMANTIC_COLORS.danger,
  flat: SEMANTIC_COLORS.textTertiary,
}

const day = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 10) : '—')

const VerdictChip: React.FC<{ verdict: Verdict }> = ({ verdict }) => (
  <Box
    as="span"
    display="inline-block"
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="10px"
    letterSpacing="0.16em"
    textTransform="uppercase"
    color={VERDICT_COLOR[verdict]}
    border="1px solid"
    borderColor={VERDICT_COLOR[verdict]}
    borderRadius={0}
    px="8px"
    py="2px"
  >
    {verdict}
  </Box>
)

const VenueChip: React.FC<{ label: string; verdict: Verdict; href?: string }> = ({ label, verdict, href }) => {
  const chip = (
    <Box
      as="span"
      display="inline-block"
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize="9.5px"
      letterSpacing="0.08em"
      color={SEMANTIC_COLORS.textSecondary}
      border="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
      borderLeft="2px solid"
      borderLeftColor={VERDICT_COLOR[verdict]}
      borderRadius={0}
      px="6px"
      py="1px"
      transition={TRANSITIONS.colors}
      _hover={href ? { color: SEMANTIC_COLORS.success, borderColor: SEMANTIC_COLORS.success } : undefined}
    >
      {label}
    </Box>
  )
  if (!href) return chip
  // stopPropagation so the chip's venue-link never triggers the row's open-radar onClick.
  return (
    <NextLink href={href} onClick={(e: React.MouseEvent) => e.stopPropagation()}>
      {chip}
    </NextLink>
  )
}

/** entered→now delta clause: colored by sign, honest null when no baseline. */
const DeltaCell: React.FC<{ delta: number | null; dir: DeltaDir | null }> = ({ delta, dir }) => {
  if (delta == null || dir == null) {
    return (
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11px" color={SEMANTIC_COLORS.textTertiary}>
        no baseline yet
      </Text>
    )
  }
  const sign = dir === 'up' ? '+' : dir === 'down' ? '−' : ''
  const text = dir === 'flat' ? 'flat' : `${sign}${fmtUsd(Math.abs(delta))}`
  return (
    <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={DELTA_COLOR[dir]}>
      {text}
    </Text>
  )
}

const StratRowView: React.FC<{ s: StratRow; onOpen: (address: string) => void; last: boolean; chain: string }> = ({
  s,
  onOpen,
  last,
  chain,
}) => (
  <Grid
    templateColumns={{ base: '1fr', md: '150px 1.4fr 130px 100px 96px' }}
    gap={SPACING.base}
    px={SPACING.base}
    py={SPACING.md}
    alignItems="center"
    borderBottom={last ? 'none' : '1px solid'}
    borderColor={SEMANTIC_COLORS.borderSubtle}
    cursor="pointer"
    role="button"
    tabIndex={0}
    transition={TRANSITIONS.colors}
    _hover={{ bg: SEMANTIC_COLORS.bgTertiary }}
    _focusVisible={FOCUS_STYLES.ring}
    onClick={() => onOpen(s.address)}
    onKeyDown={(e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onOpen(s.address)
      }
    }}
    title={s.address}
  >
    <Box>
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.textPrimary}>
        {s.short_address}
      </Text>
      {s.label && s.label !== 'auto' && (
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9px" color={SEMANTIC_COLORS.textTertiary} letterSpacing="0.08em">
          {s.label}
        </Text>
      )}
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="13px" color={SEMANTIC_COLORS.textPrimary} mt="2px">
        {fmtUsd(s.current_total_usd)}
      </Text>
    </Box>

    <Wrap spacing="6px">
      {s.held.length === 0 ? (
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" color={SEMANTIC_COLORS.textTertiary}>
          nothing held now
        </Text>
      ) : (
        s.held.map((h) => (
          <WrapItem key={h.venue}>
            <VenueChip label={`${h.label} ${fmtUsd(h.usd)}`} verdict={h.verdict} href={`/${chain}/venue/${h.venue}`} />
          </WrapItem>
        ))
      )}
    </Wrap>

    <DeltaCell delta={s.delta_usd} dir={s.delta_dir} />

    <Box>
      <VerdictChip verdict={s.verdict} />
      {s.weakest_venue && (
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9px" color={SEMANTIC_COLORS.textTertiary} mt="3px">
          {s.weakest_venue}
        </Text>
      )}
    </Box>

    <Text
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize="9px"
      letterSpacing="0.12em"
      textTransform="uppercase"
      color={SEMANTIC_COLORS.textTertiary}
      textAlign={{ base: 'left', md: 'right' }}
    >
      {day(s.watched_since)}
    </Text>
  </Grid>
)

const HeaderCell: React.FC<{ children: React.ReactNode; alignRight?: boolean }> = ({ children, alignRight }) => (
  <Text
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="9px"
    letterSpacing="0.16em"
    textTransform="uppercase"
    color={SEMANTIC_COLORS.textTertiary}
    textAlign={{ base: 'left', md: alignRight ? 'right' : 'left' }}
  >
    {children}
  </Text>
)

export const StratsBoard: React.FC = () => {
  const router = useRouter()
  const chain = (Array.isArray(router.query.chain) ? router.query.chain[0] : router.query.chain) || 'ethereum'

  const { data, isFetching, error } = useQuery<StratsResponse>({
    queryKey: ['strats'],
    queryFn: async () => {
      const r = await fetch('/api/strats')
      if (!r.ok) throw new Error(`strats ${r.status}`)
      return r.json()
    },
    staleTime: 1000 * 60 * 5,
    refetchOnMount: true,
  })

  const openRadar = (address: string) => {
    router.push(`/${chain}/radar?address=${address}`)
  }

  const strats = data?.strats ?? []
  const stampDate = data?.freshest_scan ? day(data.freshest_scan) : new Date().toISOString().slice(0, 10)

  return (
    <Box maxW="1140px" mx="auto" px={SPACING.base} py={SPACING.lg} bg={SEMANTIC_COLORS.bgPrimary} color={SEMANTIC_COLORS.textPrimary}>
      <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize={TYPOGRAPHY.h1} color={SEMANTIC_COLORS.textPrimary} letterSpacing="-0.01em">
        Carry Strats
      </Text>
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.textSecondary} mt={SPACING.sm} maxW="680px">
        Real carry positions, auto-discovered on mainnet across our four instrumented
        venues — sUSDe, sUSDS, scrvUSD, and Aave USDe. No opt-in, no wallet connect.
        Each strat is stressed against the capacity and flow we have actually recorded.
      </Text>
      <HStack spacing={SPACING.lg} flexWrap="wrap" mt={SPACING.md}>
        <NextLink href={`/${chain}/carry`} style={{ textDecoration: 'underline' }}>
          <Text as="span" fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.textSecondary} _hover={{ color: SEMANTIC_COLORS.success }}>
            the board → /carry
          </Text>
        </NextLink>
      </HStack>

      {/* Header stat card — N strats · $ total · corpus provenance + freshness. */}
      <Card variant="subtle" p={SPACING.base} mt={SPACING.lg}>
        <HStack spacing={SPACING.xl} flexWrap="wrap" align="baseline">
          <Stat label="Strats tracked" value={data ? String(data.count) : '—'} />
          <Stat label="Total tracked" value={data ? fmtUsd(data.total_usd) : '—'} />
          <Stat
            label="Recorded corpus"
            value={
              data
                ? `${data.provenance.recorded.flow_rows.toLocaleString()} flows · ${data.provenance.recorded.snapshot_rows.toLocaleString()} snapshots`
                : '—'
            }
          />
          <Stat label="Positions as of" value={data?.freshest_scan ? day(data.freshest_scan) : 'not yet scanned'} />
        </HStack>
        <Stamp>carry radar · recorded corpus · {stampDate}</Stamp>
      </Card>

      {isFetching && !data && (
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.textSecondary} mt={SPACING.lg}>
          reading corpus + cached positions…
        </Text>
      )}
      {error && (
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.danger} mt={SPACING.lg}>
          {(error as Error).message}
        </Text>
      )}

      {data && (
        <Box mt={SPACING.xl}>
          <SectionHeading
            index="01 /"
            title={strats.length > 0 ? 'Tracked strats' : 'No strats tracked yet'}
            note={strats.length > 0 ? 'largest position first · click a row to open it in the radar' : undefined}
          />
          {strats.length === 0 ? (
            <Card variant="subtle" p={SPACING.base}>
              <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.textSecondary}>
                The discovery scan has not watched any strats yet. Run{' '}
                <Text as="span" color={SEMANTIC_COLORS.textPrimary}>npm run strats:discover</Text> then{' '}
                <Text as="span" color={SEMANTIC_COLORS.textPrimary}>npm run strats:refresh</Text>.
              </Text>
            </Card>
          ) : (
            <Card variant="default" p={0}>
              <Grid
                templateColumns={{ base: '1fr', md: '150px 1.4fr 130px 100px 96px' }}
                gap={SPACING.base}
                px={SPACING.base}
                py={SPACING.sm}
                borderBottom="1px solid"
                borderColor={SEMANTIC_COLORS.borderSubtle}
                display={{ base: 'none', md: 'grid' }}
              >
                <HeaderCell>Strat · size</HeaderCell>
                <HeaderCell>Venues held</HeaderCell>
                <HeaderCell>Entered → now</HeaderCell>
                <HeaderCell>Verdict</HeaderCell>
                <HeaderCell alignRight>Since</HeaderCell>
              </Grid>
              {strats.map((s, i) => (
                <StratRowView key={s.address} s={s} onOpen={openRadar} last={i === strats.length - 1} chain={chain} />
              ))}
              <Box px={SPACING.base} pb={SPACING.sm}>
                <Stamp>
                  carry radar · recorded corpus · {stampDate} — positions are cached chain reads; capacity + flow are the
                  recorder corpus (trailing {data.provenance.recorded.window}); the delta is arithmetic. Nothing modelled.
                </Stamp>
              </Box>
            </Card>
          )}
        </Box>
      )}
    </Box>
  )
}

const Stat: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <Box>
    <Text
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize="9px"
      letterSpacing="0.16em"
      textTransform="uppercase"
      color={SEMANTIC_COLORS.textTertiary}
      mb="2px"
    >
      {label}
    </Text>
    <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="16px" color={SEMANTIC_COLORS.textPrimary}>
      {value}
    </Text>
  </Box>
)

export default StratsBoard
