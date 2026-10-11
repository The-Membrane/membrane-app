import React, { useMemo, useState } from 'react'
import {
  Box,
  Button,
  Grid,
  HStack,
  Input,
  Menu,
  MenuButton,
  MenuItemOption,
  MenuList,
  MenuOptionGroup,
  Popover,
  PopoverBody,
  PopoverCloseButton,
  PopoverContent,
  PopoverTrigger,
  Portal,
  Select,
  Text,
  Wrap,
  WrapItem,
} from '@chakra-ui/react'
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
import {
  filterStrats,
  isTrackedReturnStale,
  venueFlows,
  type StratRow,
} from '@/components/Strats/stratsLogic'

// Carry Strats — the auto-tracked, WALLET-FREE, shareable dashboard. It scans
// mainnet for real carry positions (scripts/discover-carry-strats.mjs) and shows
// each tracked strat's current holdings and weakest-prong verdict. Every number is
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

const EMPTY_STRATS: StratRow[] = []

const VERDICT_COLOR: Record<Verdict, string> = {
  clear: SEMANTIC_COLORS.success,
  caution: SEMANTIC_COLORS.riskCaution,
  exposed: SEMANTIC_COLORS.danger,
}

const day = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 10) : '—')
const readingTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })

const VerdictChip: React.FC<{ verdict: Verdict }> = ({ verdict }) => (
  <Box
    as="span"
    display="inline-block"
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="12px"
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

const ReturnCell: React.FC<{ row: StratRow }> = ({ row }) => {
  const result = row.return_metrics
  if (result?.status !== 'complete' || result.pnl_usd == null || result.return_pct == null) {
    return (
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="12px"
        color={SEMANTIC_COLORS.textSecondary}
        title={result?.note}
      >
        {result?.status === 'incomplete' ? 'return unavailable' : 'building flow history'}
      </Text>
    )
  }
  const color = result.pnl_usd >= 0 ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.danger
  const stale = isTrackedReturnStale(result.end_at)
  return (
    <Box title={result.note}>
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={color}>
        {result.pnl_usd >= 0 ? '+' : '−'}
        {fmtUsd(Math.abs(result.pnl_usd))}
      </Text>
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.textSecondary}>
        {result.return_pct >= 0 ? '+' : ''}
        {result.return_pct.toFixed(2)}% · since {day(result.start_at)}
      </Text>
      {result.end_at && (
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="12px"
          color={SEMANTIC_COLORS.textSecondary}
        >
          {result.refresh_failed
            ? 'Refresh delayed · last valid as of '
            : stale
              ? 'Stale · as of '
              : 'As of '}
          {readingTime(result.end_at)}
        </Text>
      )}
    </Box>
  )
}

const VenueChip: React.FC<{ label: string; verdict: Verdict; href?: string }> = ({
  label,
  verdict,
  href,
}) => {
  const chip = (
    <Box
      as="span"
      display="inline-block"
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize="12px"
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
      _hover={
        href ? { color: SEMANTIC_COLORS.success, borderColor: SEMANTIC_COLORS.success } : undefined
      }
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

const StratRowView: React.FC<{
  s: StratRow
  onOpen: (address: string) => void
  last: boolean
  chain: string
}> = ({ s, onOpen, last, chain }) => (
  <Grid
    templateColumns={{ base: '1fr', md: '170px minmax(0, 1fr) 125px 110px 100px' }}
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
      if (e.currentTarget !== e.target) return
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
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="12px"
          color={SEMANTIC_COLORS.textTertiary}
          letterSpacing="0.08em"
        >
          {s.label}
        </Text>
      )}
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="13px"
        color={SEMANTIC_COLORS.textPrimary}
        mt="2px"
      >
        {fmtUsd(s.current_total_usd)}
      </Text>
    </Box>

    <Wrap spacing="6px">
      {s.held.length === 0 ? (
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.textTertiary}>
          nothing held now
        </Text>
      ) : (
        s.held.map((h) => (
          <WrapItem key={h.venue}>
            <VenueChip
              label={`${h.label} ${fmtUsd(h.usd)}`}
              verdict={h.verdict}
              href={`/${chain}/venue/${h.venue}`}
            />
          </WrapItem>
        ))
      )}
    </Wrap>

    <ReturnCell row={s} />

    <Box>
      <VerdictChip verdict={s.verdict} />
      {s.weakest_venue && (
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="12px"
          color={SEMANTIC_COLORS.textTertiary}
          mt="3px"
        >
          {s.weakest_venue}
        </Text>
      )}
    </Box>

    <Text
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize="12px"
      letterSpacing="0.12em"
      textTransform="uppercase"
      color={SEMANTIC_COLORS.textTertiary}
      textAlign={{ base: 'left', md: 'right' }}
    >
      {day(s.watched_since)}
    </Text>
  </Grid>
)

const HeaderCell: React.FC<{ children: React.ReactNode; alignRight?: boolean }> = ({
  children,
  alignRight,
}) => (
  <Text
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="12px"
    letterSpacing="0.16em"
    textTransform="uppercase"
    color={SEMANTIC_COLORS.textTertiary}
    textAlign={{ base: 'left', md: alignRight ? 'right' : 'left' }}
  >
    {children}
  </Text>
)

const VERDICT_OPTIONS: Array<{ value: '' | Verdict; label: string }> = [
  { value: '', label: 'All verdicts' },
  { value: 'clear', label: 'Clear' },
  { value: 'caution', label: 'Caution' },
  { value: 'exposed', label: 'Exposed' },
]

const VerdictFilter: React.FC<{ value: string; onChange: (value: string) => void }> = ({
  value,
  onChange,
}) => (
  <Menu matchWidth placement="bottom-end">
    <MenuButton
      as={Button}
      type="button"
      aria-label="Filter tracked strategies by verdict"
      rightIcon={
        <Text as="span" aria-hidden="true">
          ⌄
        </Text>
      }
      variant="outline"
      h="40px"
      w="100%"
      px={SPACING.md}
      borderRadius={0}
      borderWidth="1px"
      borderColor={SEMANTIC_COLORS.borderStrong}
      bg={SEMANTIC_COLORS.bgSecondary}
      boxShadow="none"
      color={value ? VERDICT_COLOR[value as Verdict] : SEMANTIC_COLORS.textPrimary}
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize="12px"
      fontWeight={500}
      textAlign="left"
      transition="background-color 0.15s ease, box-shadow 0.15s ease"
      _hover={{
        bg: SEMANTIC_COLORS.bgTertiary,
        borderColor: SEMANTIC_COLORS.borderStrong,
        boxShadow: '0 5px 12px color-mix(in srgb, var(--m-border-strong) 65%, transparent)',
      }}
      _active={{
        bg: SEMANTIC_COLORS.bgTertiary,
        borderWidth: '1px',
        borderColor: SEMANTIC_COLORS.borderStrong,
        boxShadow: '0 2px 5px color-mix(in srgb, var(--m-border-strong) 45%, transparent)',
      }}
      _focus={{
        outline: 'none',
        borderColor: SEMANTIC_COLORS.borderStrong,
      }}
      _focusVisible={{
        ...FOCUS_STYLES.ring,
        borderColor: SEMANTIC_COLORS.borderStrong,
      }}
    >
      {VERDICT_OPTIONS.find((option) => option.value === value)?.label ?? 'All verdicts'}
    </MenuButton>
    <Portal>
      <MenuList
        minW="180px"
        p={SPACING.xs}
        borderRadius={0}
        border="1px solid"
        borderColor={SEMANTIC_COLORS.borderStrong}
        bg={SEMANTIC_COLORS.bgSecondary}
        boxShadow="none"
        zIndex={20}
      >
        <MenuOptionGroup
          type="radio"
          value={value}
          onChange={(next) => onChange(Array.isArray(next) ? (next[0] ?? '') : next)}
        >
          {VERDICT_OPTIONS.map((option) => (
            <MenuItemOption
              key={option.value}
              value={option.value}
              bg={value === option.value ? SEMANTIC_COLORS.bgTertiary : SEMANTIC_COLORS.bgSecondary}
              color={option.value ? VERDICT_COLOR[option.value] : SEMANTIC_COLORS.textPrimary}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="12px"
              borderRadius={0}
              _hover={{ bg: SEMANTIC_COLORS.bgTertiary }}
              _focus={{ bg: SEMANTIC_COLORS.bgTertiary }}
            >
              <Box as="span" aria-hidden="true" mr={SPACING.sm}>
                {option.value ? '■' : '·'}
              </Box>
              {option.label}
            </MenuItemOption>
          ))}
        </MenuOptionGroup>
      </MenuList>
    </Portal>
  </Menu>
)

const VerdictHelp: React.FC = () => (
  <Popover placement="bottom-end" closeOnBlur>
    <PopoverTrigger>
      <Button
        type="button"
        aria-label="How risk verdicts are assigned"
        variant="unstyled"
        h="auto"
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="12px"
        color={SEMANTIC_COLORS.textSecondary}
        borderBottom="1px solid"
        borderColor={SEMANTIC_COLORS.borderStrong}
        borderRadius={0}
        _hover={{ color: SEMANTIC_COLORS.textPrimary }}
        _focusVisible={FOCUS_STYLES.ring}
      >
        How verdicts work ⓘ
      </Button>
    </PopoverTrigger>
    <Portal>
      <PopoverContent
        w={{ base: 'calc(100vw - 32px)', md: '400px' }}
        borderRadius={0}
        border="1px solid"
        borderColor={SEMANTIC_COLORS.borderStrong}
        bg={SEMANTIC_COLORS.bgSecondary}
        color={SEMANTIC_COLORS.textPrimary}
        boxShadow="none"
        _focus={FOCUS_STYLES.ring}
      >
        <PopoverCloseButton aria-label="Close verdict explanation" borderRadius={0} />
        <PopoverBody p={SPACING.base} display="grid" gap={SPACING.sm}>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" pr={SPACING.lg}>
            Each held venue gets its weakest applicable recorded inventory or cooldown check. A
            strategy gets its weakest held venue. Flow event rows do not establish exit capacity.
          </Text>
          {[
            {
              verdict: 'clear' as const,
              detail: 'No position is held, so there is no venue exit to assess.',
            },
            {
              verdict: 'caution' as const,
              detail:
                'Recorded instant inventory covers at least 1× the position, a recorded cooldown is up to 24 hours, or no applicable check is available. Inventory does not verify this holder can exit.',
            },
            {
              verdict: 'exposed' as const,
              detail:
                'Recorded instant inventory is below 1× the position or a recorded cooldown exceeds 24 hours.',
            },
          ].map(({ verdict, detail }) => (
            <Box
              key={verdict}
              borderLeft="2px solid"
              borderColor={VERDICT_COLOR[verdict]}
              pl={SPACING.sm}
            >
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="12px"
                fontWeight={700}
                textTransform="uppercase"
                color={VERDICT_COLOR[verdict]}
              >
                {verdict}
              </Text>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="12px"
                color={SEMANTIC_COLORS.textSecondary}
                lineHeight={1.5}
              >
                {detail}
              </Text>
            </Box>
          ))}
        </PopoverBody>
      </PopoverContent>
    </Portal>
  </Popover>
)

/** Holdings, not transactions: one tracked-capital source branching into current venues. */
const CapitalFlow: React.FC<{
  rows: StratRow[]
  selectedVenue: string
  selectedVerdict: string
  onSelectVenue: (venue: string) => void
}> = ({ rows, selectedVenue, selectedVerdict, onSelectVenue }) => {
  const flows = venueFlows(rows)
  const total = flows.reduce((sum, flow) => sum + flow.usd, 0)
  const flowColor = selectedVerdict
    ? VERDICT_COLOR[selectedVerdict as Verdict]
    : SEMANTIC_COLORS.success
  return (
    <Card
      variant="subtle"
      p={SPACING.base}
      mt={SPACING.lg}
      data-testid="strats-flow"
      data-risk-verdict={selectedVerdict || 'all'}
    >
      <Text
        fontFamily={TYPOGRAPHY.fontDisplay}
        fontSize={TYPOGRAPHY.h3}
        color={SEMANTIC_COLORS.textPrimary}
      >
        Where tracked capital sits
      </Text>
      <Box
        display="flex"
        alignItems="baseline"
        justifyContent="space-between"
        gap={SPACING.sm}
        flexWrap="wrap"
      >
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="12px"
          color={SEMANTIC_COLORS.textSecondary}
          mt={SPACING.xs}
        >
          {selectedVerdict
            ? `Holdings in ${selectedVerdict} books. Line color marks the book filter, not each venue's risk.`
            : 'Current holdings across venues, not transfers between them. Select a venue to filter the books below.'}
        </Text>
        <VerdictHelp />
      </Box>
      <Grid
        templateColumns={{ base: 'minmax(0, 1fr)', md: '220px minmax(0, 1fr)' }}
        gap={SPACING.lg}
        mt={SPACING.base}
        alignItems="center"
      >
        <Button
          data-testid="strats-all-venues"
          type="button"
          onClick={() => onSelectVenue('')}
          aria-pressed={!selectedVenue}
          variant="unstyled"
          h="auto"
          whiteSpace="normal"
          textAlign="left"
          border="1px solid"
          borderColor={SEMANTIC_COLORS.borderStrong}
          borderRadius={0}
          p={SPACING.base}
          boxShadow="none"
          transition="box-shadow 150ms ease"
          _hover={{ boxShadow: 'md' }}
          _active={{ boxShadow: 'sm' }}
          _focus={{ boxShadow: 'none' }}
          _focusVisible={{
            outline: '2px solid',
            outlineColor: SEMANTIC_COLORS.textPrimary,
            outlineOffset: '2px',
          }}
        >
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="12px"
            letterSpacing="0.16em"
            textTransform="uppercase"
            color={SEMANTIC_COLORS.textSecondary}
          >
            tracked books
          </Text>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="23px"
            color={SEMANTIC_COLORS.textPrimary}
          >
            {fmtUsd(total)}
          </Text>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="12px"
            color={SEMANTIC_COLORS.textSecondary}
          >
            {rows.length} books · show all venues
          </Text>
        </Button>
        <Box
          borderLeft={{ base: 'none', md: '1px solid' }}
          borderTop={{ base: '1px solid', md: 'none' }}
          borderColor={SEMANTIC_COLORS.borderStrong}
          pl={{ base: 0, md: SPACING.lg }}
          pt={{ base: SPACING.md, md: 0 }}
          display="grid"
          gap={SPACING.sm}
        >
          {flows.length === 0 && (
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="12px"
              color={SEMANTIC_COLORS.textSecondary}
            >
              No current venue holdings match these filters.
            </Text>
          )}
          {flows.map((flow) => (
            <Button
              key={flow.venue}
              data-testid="strats-venue-row"
              type="button"
              onClick={() => onSelectVenue(selectedVenue === flow.venue ? '' : flow.venue)}
              aria-pressed={selectedVenue === flow.venue}
              variant="unstyled"
              h="auto"
              minW={0}
              display="grid"
              gridTemplateColumns="20px minmax(0, 1fr)"
              alignItems="center"
              gap={SPACING.sm}
              textAlign="left"
              boxShadow="none"
              transition="box-shadow 150ms ease"
              _hover={{ boxShadow: 'md' }}
              _active={{ boxShadow: 'sm' }}
              _focus={{ boxShadow: 'none' }}
              _focusVisible={{
                outline: '2px solid',
                outlineColor: SEMANTIC_COLORS.textPrimary,
                outlineOffset: '2px',
              }}
            >
              <Text aria-hidden="true" fontFamily={TYPOGRAPHY.fontMono} color={flowColor}>
                →
              </Text>
              <Box minW={0}>
                <Box display="flex" justifyContent="space-between" gap={SPACING.sm} flexWrap="wrap">
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize="12px"
                    color={SEMANTIC_COLORS.textPrimary}
                  >
                    {flow.label}
                  </Text>
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize="12px"
                    color={SEMANTIC_COLORS.textPrimary}
                  >
                    {fmtUsd(flow.usd)} · {flow.books} {flow.books === 1 ? 'book' : 'books'}
                  </Text>
                </Box>
                <Box h="4px" mt={SPACING.xs} bg={SEMANTIC_COLORS.borderSubtle}>
                  <Box
                    data-testid="strats-flow-bar"
                    h="100%"
                    w={`${total > 0 ? Math.max(1, (flow.usd / total) * 100) : 0}%`}
                    bg={flowColor}
                  />
                </Box>
              </Box>
            </Button>
          ))}
        </Box>
      </Grid>
    </Card>
  )
}

export const StratsBoard: React.FC<{ embedded?: boolean }> = ({ embedded = false }) => {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [venue, setVenue] = useState('')
  const [verdict, setVerdict] = useState('')
  const chain =
    (Array.isArray(router.query.chain) ? router.query.chain[0] : router.query.chain) || 'ethereum'

  const { data, isFetching, error } = useQuery<StratsResponse>({
    queryKey: ['strats'],
    queryFn: async () => {
      const r = await fetch('/api/strats')
      if (!r.ok) throw new Error(`strats ${r.status}`)
      return r.json()
    },
    staleTime: 1000 * 60 * 5,
    refetchOnMount: true,
    refetchInterval: 1000 * 60 * 5,
  })

  const openRadar = (address: string) => {
    router.push(`/${chain}/radar?address=${address}`)
  }

  const strats = data?.strats ?? EMPTY_STRATS
  const filtered = useMemo(
    () => filterStrats(strats, query, venue, verdict),
    [strats, query, venue, verdict],
  )
  const venues = useMemo(() => venueFlows(strats), [strats])
  const stampDate = data?.freshest_scan
    ? day(data.freshest_scan)
    : new Date().toISOString().slice(0, 10)

  return (
    <Box
      maxW={embedded ? undefined : '1140px'}
      mx={embedded ? undefined : 'auto'}
      px={embedded ? 0 : SPACING.base}
      py={embedded ? SPACING.base : SPACING.lg}
      bg={SEMANTIC_COLORS.bgPrimary}
      color={SEMANTIC_COLORS.textPrimary}
    >
      <Text
        fontFamily={TYPOGRAPHY.fontDisplay}
        fontSize={TYPOGRAPHY.h1}
        color={SEMANTIC_COLORS.textPrimary}
        letterSpacing="-0.01em"
      >
        Carry Strats
      </Text>
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="12px"
        color={SEMANTIC_COLORS.textSecondary}
        mt={SPACING.sm}
        maxW="680px"
      >
        Real carry positions discovered on mainnet. Each strat is stressed against recorded
        inventory and cooldowns where available; flow events remain context.
      </Text>
      {!embedded && (
        <HStack spacing={SPACING.lg} flexWrap="wrap" mt={SPACING.md}>
          <NextLink href={`/${chain}/carry`} style={{ textDecoration: 'none' }}>
            <Text
              as="span"
              display="inline-block"
              pb={SPACING.xs}
              borderBottom="1px solid"
              borderColor={SEMANTIC_COLORS.borderStrong}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="12px"
              color={SEMANTIC_COLORS.textSecondary}
              _hover={{ color: SEMANTIC_COLORS.success, borderColor: SEMANTIC_COLORS.success }}
            >
              the board → /carry
            </Text>
          </NextLink>
        </HStack>
      )}

      {/* Header stat card — N strats · $ total · corpus provenance + freshness. */}
      <Card variant="subtle" p={SPACING.base} mt={SPACING.lg} data-testid="strats-summary">
        <Grid
          templateColumns={{ base: 'repeat(2, minmax(0, 1fr))', md: 'repeat(4, minmax(0, 1fr))' }}
          gap={SPACING.xl}
          alignItems="start"
        >
          <Stat label="Strats tracked" value={data ? String(data.count) : '—'} />
          <Stat label="Total tracked" value={data ? fmtUsd(data.total_usd) : '—'} />
          <Stat
            label="Recorded corpus"
            wideOnMobile
            value={
              data
                ? `${data.provenance.recorded.flow_rows.toLocaleString()} flows · ${data.provenance.recorded.snapshot_rows.toLocaleString()} snapshots`
                : '—'
            }
          />
          <Stat
            label="Positions as of"
            wideOnMobile
            value={data?.freshest_scan ? day(data.freshest_scan) : 'not yet scanned'}
          />
        </Grid>
        <Stamp>carry radar · recorded corpus · {stampDate}</Stamp>
      </Card>

      {isFetching && !data && (
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="12px"
          color={SEMANTIC_COLORS.textSecondary}
          mt={SPACING.lg}
        >
          reading corpus + cached positions…
        </Text>
      )}
      {error && (
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="12px"
          color={SEMANTIC_COLORS.danger}
          mt={SPACING.lg}
        >
          {(error as Error).message}
        </Text>
      )}

      {data && (
        <Box mt={SPACING.xl}>
          <CapitalFlow
            rows={filtered}
            selectedVenue={venue}
            selectedVerdict={verdict}
            onSelectVenue={setVenue}
          />
          <Grid
            templateColumns={{
              base: 'minmax(0, 1fr)',
              md: 'minmax(0, 2fr) repeat(2, minmax(0, 1fr))',
            }}
            gap={SPACING.sm}
            mt={SPACING.base}
          >
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Filter tracked strategies by address or label"
              placeholder="Find a strategy or address"
              borderRadius={0}
              borderColor={SEMANTIC_COLORS.borderStrong}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="12px"
            />
            <Select
              value={venue}
              onChange={(event) => setVenue(event.target.value)}
              aria-label="Filter tracked strategies by venue"
              borderRadius={0}
              borderColor={SEMANTIC_COLORS.borderStrong}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="12px"
            >
              <option value="">All venues</option>
              {venues.map((flow) => (
                <option key={flow.venue} value={flow.venue}>
                  {flow.label}
                </option>
              ))}
            </Select>
            <VerdictFilter value={verdict} onChange={setVerdict} />
          </Grid>
          <SectionHeading
            index="01 /"
            title={strats.length > 0 ? 'Tracked strats' : 'No strats tracked yet'}
            note={
              strats.length > 0
                ? `${filtered.length} of ${strats.length} books · largest first · select a row for radar`
                : undefined
            }
          />
          {strats.length === 0 ? (
            <Card variant="subtle" p={SPACING.base}>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="12px"
                color={SEMANTIC_COLORS.textSecondary}
              >
                The discovery scan has not watched any strats yet. Run{' '}
                <Text as="span" color={SEMANTIC_COLORS.textPrimary}>
                  npm run strats:discover
                </Text>{' '}
                then{' '}
                <Text as="span" color={SEMANTIC_COLORS.textPrimary}>
                  npm run strats:refresh
                </Text>
                .
              </Text>
            </Card>
          ) : (
            <Card variant="default" p={0}>
              <Box
                role="region"
                aria-label="Tracked strategies table"
                tabIndex={0}
                maxH={{ base: '440px', md: '520px' }}
                overflowY="auto"
                overscrollBehaviorY="contain"
                _focusVisible={FOCUS_STYLES.ring}
              >
                <Grid
                  templateColumns={{ base: '1fr', md: '170px minmax(0, 1fr) 125px 110px 100px' }}
                  gap={SPACING.base}
                  px={SPACING.base}
                  py={SPACING.sm}
                  borderBottom="1px solid"
                  borderColor={SEMANTIC_COLORS.borderSubtle}
                  display={{ base: 'none', md: 'grid' }}
                  position="sticky"
                  top={0}
                  zIndex={1}
                  bg={SEMANTIC_COLORS.bgSecondary}
                >
                  <HeaderCell>Strat · size</HeaderCell>
                  <HeaderCell>Venues held</HeaderCell>
                  <HeaderCell>Tracked return</HeaderCell>
                  <HeaderCell>Verdict</HeaderCell>
                  <HeaderCell alignRight>Watched since</HeaderCell>
                </Grid>
                {filtered.length === 0 && (
                  <Box p={SPACING.base}>
                    <Text
                      fontFamily={TYPOGRAPHY.fontMono}
                      fontSize="12px"
                      color={SEMANTIC_COLORS.textSecondary}
                    >
                      No tracked books match these filters.
                    </Text>
                  </Box>
                )}
                {filtered.map((s, i) => (
                  <StratRowView
                    key={s.address}
                    s={s}
                    onOpen={openRadar}
                    last={i === filtered.length - 1}
                    chain={chain}
                  />
                ))}
              </Box>
              <Box px={SPACING.base} pb={SPACING.sm}>
                <Stamp>
                  carry radar · recorded corpus · {stampDate} — positions are cached chain reads;
                  capacity snapshots and flow event rows are recorded observations. Flow rows do not
                  certify complete time windows or quiet periods and do not set the exit verdict.
                  Tracked return is cash-flow adjusted, nonannualized, and excludes borrowing costs;
                  it appears only when a full priced flow window exists.
                </Stamp>
              </Box>
            </Card>
          )}
        </Box>
      )}
    </Box>
  )
}

const Stat: React.FC<{ label: string; value: string; wideOnMobile?: boolean }> = ({
  label,
  value,
  wideOnMobile = false,
}) => (
  <Box minW={0} gridColumn={wideOnMobile ? { base: '1 / -1', md: 'auto' } : undefined}>
    <Text
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize="12px"
      letterSpacing="0.16em"
      textTransform="uppercase"
      color={SEMANTIC_COLORS.textTertiary}
      mb="2px"
    >
      {label}
    </Text>
    <Text
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize="16px"
      color={SEMANTIC_COLORS.textPrimary}
      overflowWrap="anywhere"
    >
      {value}
    </Text>
  </Box>
)

export default StratsBoard
