import React, { useEffect, useState } from 'react'
import { Box, Button, Grid, HStack, Input, SimpleGrid, Text } from '@chakra-ui/react'
import { useQuery } from '@tanstack/react-query'

import { Card } from '@/components/ui/Card'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { SectionHeading, Stamp } from '@/components/Carry/atoms'

import { fmtDuration, fmtMultiple, fmtPct, fmtUsd, type Verdict } from './radarLogic'

// Carry Radar — paste any mainnet address, see its positions across our four
// instrumented venues, stressed against our RECORDED capacity + flow corpus.
// No wallet connect: a standalone decision tool. Every number is a live chain
// read or a recorded DB row; nothing is modelled (see /api/radar/[address]).

const LS_KEY = 'carry-radar:last-address'

type Prong = { level: Verdict; coverage: number | null }
type InstantProng = Prong & { instantUsd: number }
type CooldownProng = Prong & { seconds: number }
type FlowProng = Prong & { worst1dUsd: number; worst7dUsd: number; coverage7d: number | null }
type Stress = { instant: InstantProng | null; cooldown: CooldownProng | null; flow: FlowProng | null }

type Position = {
  venue: string
  label: string
  kind: string
  usd: number
  tvl_usd: number | null
  share_of_tvl: number | null
  stress: Stress
  verdict: Verdict
  reason: string
}
type Comparator = {
  venue: string
  label: string
  kind: string
  at_usd: number
  stress: Stress
  verdict: Verdict
  reason: string
}
type PerVenueProv = {
  venue: string
  flow_rows: number
  flow_span: { start: string; end: string } | null
  snapshot_rows: number
  snapshot_observed: number
  snapshot_backfilled: number
  snapshot_span: { start: string; end: string } | null
  snapshot_at: string | null
}
type RadarResponse = {
  address: string
  total_usd: number
  held_count: number
  positions: Position[]
  comparator: Comparator[]
  share_line: string
  provenance: {
    chain_reads: { at: string; method: string; price_assumption: string }
    recorded: { window: string; note: string; per_venue: PerVenueProv[] }
    modelled: null
  }
}

const VERDICT_COLOR: Record<Verdict, string> = {
  clear: SEMANTIC_COLORS.success,
  caution: SEMANTIC_COLORS.warning,
  exposed: SEMANTIC_COLORS.danger,
}

const isAddressish = (s: string) => /^0x[a-fA-F0-9]{40}$/.test(s.trim())

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

const Fact: React.FC<{ label: string; value: React.ReactNode; muted?: boolean }> = ({ label, value, muted }) => (
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
    <Text
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize="13px"
      color={muted ? SEMANTIC_COLORS.textTertiary : SEMANTIC_COLORS.textPrimary}
    >
      {value}
    </Text>
  </Box>
)

/** The three stress facts, rendered honestly (null → an explicit "not derivable"). */
const StressFacts: React.FC<{ stress: Stress }> = ({ stress }) => {
  const instant = stress.instant
    ? `${fmtUsd(stress.instant.instantUsd)} instant · ${fmtMultiple(stress.instant.coverage ?? 0)} your size`
    : 'no instant liquidity — cooldown vault (not derivable)'
  const cooldown = stress.cooldown
    ? `${fmtDuration(stress.cooldown.seconds)} gate — 100% of exit delayed`
    : 'no cooldown gate recorded'
  const flow = stress.flow
    ? `${fmtUsd(stress.flow.worst1dUsd)} worst day · ${fmtMultiple(stress.flow.coverage ?? 0)} your size`
    : 'no recorded outflow'
  const flow7 =
    stress.flow && stress.flow.coverage7d != null
      ? `${fmtUsd(stress.flow.worst7dUsd)} worst 7d · ${fmtMultiple(stress.flow.coverage7d)} your size`
      : null
  return (
    <SimpleGrid columns={{ base: 1, sm: 2 }} spacing={SPACING.md} mt={SPACING.md}>
      <Fact label="Instant capacity" value={instant} muted={!stress.instant} />
      <Fact label="Cooldown" value={cooldown} muted={!stress.cooldown} />
      <Fact label="Worst 1-day outflow" value={flow} muted={!stress.flow} />
      {flow7 && <Fact label="Worst 7-day outflow" value={flow7} />}
    </SimpleGrid>
  )
}

const VenueCard: React.FC<{ p: Position }> = ({ p }) => (
  <Card variant="default" mb={SPACING.base}>
    <HStack justify="space-between" align="baseline" flexWrap="wrap" gap={SPACING.sm}>
      <HStack align="baseline" spacing={SPACING.md}>
        <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize={TYPOGRAPHY.h3} color={SEMANTIC_COLORS.textPrimary}>
          {p.label}
        </Text>
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="20px" color={SEMANTIC_COLORS.textPrimary}>
          {fmtUsd(p.usd)}
        </Text>
        {p.share_of_tvl != null && (
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11px" color={SEMANTIC_COLORS.textTertiary}>
            {fmtPct(p.share_of_tvl)} of TVL
          </Text>
        )}
      </HStack>
      <VerdictChip verdict={p.verdict} />
    </HStack>
    <StressFacts stress={p.stress} />
    <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={VERDICT_COLOR[p.verdict]} mt={SPACING.md}>
      {p.reason}
    </Text>
  </Card>
)

export const Radar: React.FC = () => {
  const [input, setInput] = useState('')
  const [address, setAddress] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // Remember the last-looked-up address (paste-first UX).
  useEffect(() => {
    if (typeof window === 'undefined') return
    const last = window.localStorage.getItem(LS_KEY)
    if (last) setInput(last)
  }, [])

  const { data, isFetching, error } = useQuery<RadarResponse>({
    queryKey: ['radar', address],
    enabled: !!address,
    queryFn: async () => {
      const r = await fetch(`/api/radar/${address}`)
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        throw new Error(body.error || `radar ${r.status}`)
      }
      return r.json()
    },
    staleTime: 1000 * 60 * 5,
    // App default is refetchOnMount:false with a 24h gcTime — override so a
    // fresh lookup is not served a stale empty result for the whole session.
    refetchOnMount: true,
  })

  const submit = () => {
    const v = input.trim()
    if (!isAddressish(v)) return
    if (typeof window !== 'undefined') window.localStorage.setItem(LS_KEY, v)
    setAddress(v)
  }

  const copyShare = async () => {
    if (!data?.share_line || typeof navigator === 'undefined') return
    await navigator.clipboard.writeText(data.share_line)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const valid = isAddressish(input)

  return (
    <Box maxW="1140px" mx="auto" px={SPACING.base} py={SPACING.lg} bg={SEMANTIC_COLORS.bgPrimary} color={SEMANTIC_COLORS.textPrimary}>
      <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize={TYPOGRAPHY.h1} color={SEMANTIC_COLORS.textPrimary} letterSpacing="-0.01em">
        Carry Radar
      </Text>
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.textSecondary} mt={SPACING.sm} maxW="640px">
        Paste any mainnet address. See its positions across our four instrumented
        venues, stressed against the capacity and flow we have actually recorded.
        No wallet connect — this reads public chain state.
      </Text>

      {/* Address input — mono, paste-first. */}
      <HStack mt={SPACING.lg} spacing={SPACING.sm} maxW="720px" flexWrap="wrap">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
          placeholder="0x…"
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="14px"
          color={SEMANTIC_COLORS.textPrimary}
          bg={SEMANTIC_COLORS.bgSecondary}
          border="1px solid"
          borderColor={SEMANTIC_COLORS.borderMedium}
          borderRadius={0}
          _hover={{ borderColor: SEMANTIC_COLORS.borderStrong }}
          _focusVisible={FOCUS_STYLES.ring}
          flex="1 1 420px"
          spellCheck={false}
          autoComplete="off"
          aria-label="Mainnet address"
        />
        <Button
          onClick={submit}
          isDisabled={!valid}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="13px"
          borderRadius={0}
          bg={SEMANTIC_COLORS.bgTertiary}
          color={SEMANTIC_COLORS.textPrimary}
          border="1px solid"
          borderColor={SEMANTIC_COLORS.borderStrong}
          transition={TRANSITIONS.colors}
          _hover={{ color: SEMANTIC_COLORS.success, borderColor: SEMANTIC_COLORS.success }}
          _focusVisible={FOCUS_STYLES.ring}
        >
          Scan
        </Button>
      </HStack>
      {input.length > 0 && !valid && (
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11px" color={SEMANTIC_COLORS.warning} mt={SPACING.sm}>
          not a valid 0x address
        </Text>
      )}

      {isFetching && (
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.textSecondary} mt={SPACING.lg}>
          reading chain + corpus…
        </Text>
      )}
      {error && (
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.danger} mt={SPACING.lg}>
          {(error as Error).message}
        </Text>
      )}

      {data && (
        <Box mt={SPACING.xl}>
          {/* Held venues, each stressed at its own size. */}
          <SectionHeading
            index="01 /"
            title={data.held_count > 0 ? 'Your positions' : 'No positions held'}
            note={`${fmtUsd(data.total_usd)} total across ${data.held_count} venue${data.held_count === 1 ? '' : 's'}`}
          />
          {data.held_count === 0 ? (
            <Card variant="subtle" p={SPACING.base}>
              <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.textSecondary}>
                This address holds nothing in sUSDe, sUSDS, scrvUSD, or Aave USDe.
                The comparator below still shows how each venue would clear a
                position, at any size.
              </Text>
            </Card>
          ) : (
            data.positions.map((p) => <VenueCard key={p.venue} p={p} />)
          )}

          {/* Comparator: same framework, all four venues at the user's TOTAL size. */}
          <SectionHeading
            index="02 /"
            title="If this whole stack sat in one venue"
            note={`every venue stressed at ${fmtUsd(data.total_usd)} — venue choice, comparable at a glance`}
          />
          <Card variant="default" p={0}>
            <Grid
              templateColumns={{ base: '1fr', md: '120px 1fr 110px' }}
              gap={SPACING.base}
              px={SPACING.base}
              py={SPACING.sm}
              borderBottom="1px solid"
              borderColor={SEMANTIC_COLORS.borderSubtle}
            >
              <HeaderCell>Venue</HeaderCell>
              <HeaderCell>Reason at your total size</HeaderCell>
              <HeaderCell alignRight>Verdict</HeaderCell>
            </Grid>
            {data.comparator.map((c, i) => (
              <Grid
                key={c.venue}
                templateColumns={{ base: '1fr', md: '120px 1fr 110px' }}
                gap={SPACING.base}
                px={SPACING.base}
                py={SPACING.md}
                alignItems="baseline"
                borderBottom={i === data.comparator.length - 1 ? 'none' : '1px solid'}
                borderColor={SEMANTIC_COLORS.borderSubtle}
              >
                <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="13px" color={SEMANTIC_COLORS.textPrimary}>
                  {c.label}
                </Text>
                <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.textSecondary}>
                  {c.reason}
                </Text>
                <Box textAlign={{ base: 'left', md: 'right' }}>
                  <VerdictChip verdict={c.verdict} />
                </Box>
              </Grid>
            ))}
          </Card>

          {/* Share line — the user's own result, copyable, never a plug. */}
          <SectionHeading index="03 /" title="Share your read" />
          <Card variant="subtle" p={SPACING.base}>
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.textPrimary} lineHeight={1.7}>
              {data.share_line}
            </Text>
            <Button
              onClick={copyShare}
              mt={SPACING.md}
              size="sm"
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="11px"
              borderRadius={0}
              bg="transparent"
              color={SEMANTIC_COLORS.textSecondary}
              border="1px solid"
              borderColor={SEMANTIC_COLORS.borderStrong}
              _hover={{ color: SEMANTIC_COLORS.success, borderColor: SEMANTIC_COLORS.success }}
              _focusVisible={FOCUS_STYLES.ring}
            >
              {copied ? 'copied' : 'copy'}
            </Button>
          </Card>

          {/* Provenance — one stamp per data class. */}
          <Provenance prov={data.provenance} />
        </Box>
      )}
    </Box>
  )
}

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

const Provenance: React.FC<{ prov: RadarResponse['provenance'] }> = ({ prov }) => {
  const totalFlowRows = prov.recorded.per_venue.reduce((s, v) => s + v.flow_rows, 0)
  const totalSnapRows = prov.recorded.per_venue.reduce((s, v) => s + v.snapshot_rows, 0)
  const spans = prov.recorded.per_venue.map((v) => v.flow_span).filter(Boolean) as { start: string; end: string }[]
  const spanStart = spans.length ? spans.reduce((m, s) => (s.start < m ? s.start : m), spans[0].start) : null
  const spanEnd = spans.length ? spans.reduce((m, s) => (s.end > m ? s.end : m), spans[0].end) : null
  return (
    <Box mt={SPACING.xl}>
      <SectionHeading index="04 /" title="Where these numbers come from" />
      <Card variant="subtle" p={SPACING.base}>
        <Stamp>
          chain-read · positions read live at request time ({new Date(prov.chain_reads.at).toISOString().slice(0, 16).replace('T', ' ')}Z)
          via {prov.chain_reads.method}. {prov.chain_reads.price_assumption}.
        </Stamp>
        <Stamp>
          recorded · capacity + flow from the recorder corpus (not re-queried live):{' '}
          {totalFlowRows.toLocaleString()} flow rows and {totalSnapRows.toLocaleString()} snapshot rows
          {spanStart && spanEnd ? ` spanning ${spanStart.slice(0, 10)} → ${spanEnd.slice(0, 10)}` : ''};
          stress uses the trailing {prov.recorded.window} of outflow.
        </Stamp>
        <Stamp>modelled · none. Every figure above is a chain read or a recorded row.</Stamp>
      </Card>
    </Box>
  )
}

export default Radar
