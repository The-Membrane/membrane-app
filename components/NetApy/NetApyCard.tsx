// NET AT YOUR SIZE — one compact card: what a deposit (or borrow) of THIS size nets on
// this venue, read from the venue's own rate curve at one block.
//
// DeFi Dojo research (docs F4): net APY at the user's size is the #3 data need — gross
// headlines, loops that net a fraction of the sticker, incentives that end without
// warning. So the card leads with ONE number, the net, and every row under it says what
// kind of claim it is (lib/netApy/types.ts LabelClass).
//
// HONESTY RULES, non-negotiable:
//  - Membrane charges THROUGH the venue: a curator-set share of yield, not fixed
//    pre-launch. With no share supplied the rows say "curator-set" and the net is shown
//    as a ceiling (≤). Never 0%, $0 or "free".
//  - A projection is labelled one. Nothing here promises positive carry.
//  - Incentives carry their end date; a conditional campaign (loop-only) is listed but
//    kept out of the net. Missing Merkl data reads "unavailable", never "none".
//  - EMPTY WHILE LOADING: a pulsing baseline, never a placeholder number.

import React, { useState } from 'react'
import { keyframes } from '@emotion/react'
import { Box, Text } from '@chakra-ui/react'
import { useQuery } from '@tanstack/react-query'

import { Eyebrow, Stamp } from '@/components/Carry/atoms'
import { Card } from '@/components/ui/Card'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import type { LabelClass } from '@/lib/netApy/types'
import type { NetApyVenueResponse, Serialized } from '@/lib/netApy/service'
import { venueByKey } from '@/lib/netApy/venues'

type Resp = Serialized<NetApyVenueResponse>

const SIZES = [10_000, 100_000, 1_000_000, 10_000_000] as const
const sizeLabel = (n: number): string => (n >= 1e6 ? `$${n / 1e6}M` : `$${n / 1e3}K`)

const CLASS_COLOR: Record<LabelClass, string> = {
  measured: SEMANTIC_COLORS.info,
  derived: SEMANTIC_COLORS.textSecondary,
  projected: SEMANTIC_COLORS.warning,
  reported: SEMANTIC_COLORS.textSecondary,
  'curator-set': SEMANTIC_COLORS.textSecondary,
}

const pulse = keyframes`
  0% { opacity: 0.18; }
  50% { opacity: 0.55; }
  100% { opacity: 0.18; }
`

/** Fraction → "4.37%", real minus sign. */
const pct = (v: number | null | undefined, dp = 2): string => {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  const s = `${(Math.abs(v) * 100).toFixed(dp)}%`
  return v < 0 ? `−${s}` : s
}
const day = (ts: number): string => new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const daysLeft = (ts: number, nowTs: number): number => Math.max(0, Math.floor((ts - nowTs) / 86_400))

/** How the campaign responds to size, in words (lib/netApy/incentives.ts Dilution). */
const DILUTION_WORDS: Record<string, string> = {
  'fixed-budget': 'shrinks with size',
  'rate-fixed': 'fixed rate, budget may run out',
  'rate-capped': 'capped rate',
  'rate-targeted': 'targeted rate',
}

const Mono: React.FC<{ children: React.ReactNode; color?: string; size?: string; as?: 'span' | 'p' }> = ({
  children,
  color,
  size = '11px',
  as = 'p',
}) => (
  <Text as={as} fontFamily={TYPOGRAPHY.fontMono} fontSize={size} color={color ?? SEMANTIC_COLORS.textSecondary} sx={{ fontVariantNumeric: 'tabular-nums' }}>
    {children}
  </Text>
)

const Preset: React.FC<{ active: boolean; onClick: () => void; children: React.ReactNode }> = ({ active, onClick, children }) => (
  <Box
    as="button"
    type="button"
    onClick={onClick}
    aria-pressed={active}
    px={SPACING.sm}
    py="2px"
    border="1px solid"
    borderRadius={0}
    borderColor={active ? SEMANTIC_COLORS.primary : SEMANTIC_COLORS.borderSubtle}
    color={active ? SEMANTIC_COLORS.primary : SEMANTIC_COLORS.textSecondary}
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="10px"
    letterSpacing="0.12em"
    textTransform="uppercase"
    _hover={{ borderColor: SEMANTIC_COLORS.borderStrong }}
  >
    {children}
  </Box>
)

const ClassTag: React.FC<{ c: LabelClass }> = ({ c }) => (
  <Text as="span" fontFamily={TYPOGRAPHY.fontMono} fontSize="8.5px" letterSpacing="0.14em" textTransform="uppercase" color={CLASS_COLOR[c]}>
    {c}
  </Text>
)

export const useNetApy = (venue: string, sizeUsd: number, side: 'supply' | 'borrow', enabled = true) =>
  useQuery<Resp>({
    queryKey: ['net_apy', venue, sizeUsd, side],
    enabled,
    queryFn: async () => {
      const r = await fetch(`/api/net-apy?venue=${encodeURIComponent(venue)}&size=${sizeUsd}&side=${side}`)
      const body = await r.json()
      if (!r.ok) throw new Error(body?.error ?? `net-apy ${r.status}`)
      return body as Resp
    },
    staleTime: 1000 * 60,
    refetchOnMount: true,
  })

export interface NetApyCardProps {
  /** venue-key (lib/netApy/venues.ts). A venue the registry does not cover renders nothing. */
  venue: string
  defaultSizeUsd?: (typeof SIZES)[number]
}

export const NetApyCard: React.FC<NetApyCardProps> = ({ venue, defaultSizeUsd = 100_000 }) => {
  const [sizeUsd, setSizeUsd] = useState<number>(defaultSizeUsd)
  const [side, setSide] = useState<'supply' | 'borrow'>('supply')
  const covered = venueByKey(venue) !== null
  const q = useNetApy(venue, sizeUsd, side, covered)
  if (!covered) return null

  const b = q.data?.breakdown
  const nowTs = b ? Number(b.anchor.blockTimestamp) : 0
  const headline = b?.net
  const ceiling = headline?.bound === 'upper'

  return (
    <Card variant="default" p={SPACING.base}>
      <Box display="flex" justifyContent="space-between" alignItems="baseline" gap={SPACING.sm} flexWrap="wrap">
        <Eyebrow>Net at your size</Eyebrow>
        <Box display="flex" gap={SPACING.xs} flexWrap="wrap">
          {(['supply', 'borrow'] as const).map((s) => (
            <Preset key={s} active={side === s} onClick={() => setSide(s)}>
              {s}
            </Preset>
          ))}
          <Box w={SPACING.sm} />
          {SIZES.map((n) => (
            <Preset key={n} active={sizeUsd === n} onClick={() => setSizeUsd(n)}>
              {sizeLabel(n)}
            </Preset>
          ))}
        </Box>
      </Box>

      {q.isError ? (
        <Mono color={SEMANTIC_COLORS.danger} size="11.5px">
          {(q.error as Error).message}
        </Mono>
      ) : !b ? (
        <Box mt={SPACING.md} h="56px" bg={SEMANTIC_COLORS.borderSubtle} animation={`${pulse} 1.6s ease-in-out infinite`} />
      ) : (
        <>
          {/* The one number. APY = the net APR compounded per second. */}
          <Box mt={SPACING.sm} display="flex" alignItems="baseline" gap={SPACING.sm} flexWrap="wrap">
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="32px" lineHeight={1.1} color={SEMANTIC_COLORS.textPrimary} sx={{ fontVariantNumeric: 'tabular-nums' }}>
              {ceiling ? '≤ ' : ''}
              {pct(headline?.apy)}
            </Text>
            <Mono>
              {side === 'supply' ? 'net APY' : 'net borrow cost'} · {b.label} · {sizeLabel(sizeUsd)}
              {headline?.withIncentives ? ' · incl. incentives' : ''}
            </Mono>
          </Box>
          {b.checks.reverts ? (
            <Mono color={SEMANTIC_COLORS.danger}>This size reverts on-chain: {b.checks.reverts}.</Mono>
          ) : null}

          {/* The breakdown. Each row: op · label · value · claim class. */}
          <Box as="dl" mt={SPACING.sm} display="grid" gridTemplateColumns="14px 1fr auto auto" columnGap={SPACING.sm} rowGap="2px" alignItems="baseline">
            {/* Rows are APR (additive); the headline is that net compounded to APY. */}
            <Box as="span" />
            <Box as="span" />
            <Text as="span" fontFamily={TYPOGRAPHY.fontMono} fontSize="8.5px" letterSpacing="0.14em" textAlign="right" color={SEMANTIC_COLORS.textTertiary}>
              APR
            </Text>
            <Box as="span" />
            {b.rows.map((r) => (
              <React.Fragment key={r.key}>
                <Mono as="span" color={SEMANTIC_COLORS.textTertiary}>
                  {r.op}
                </Mono>
                <Text as="dt" fontFamily={TYPOGRAPHY.fontMono} fontSize="11px" color={r.op === '=' ? SEMANTIC_COLORS.textPrimary : SEMANTIC_COLORS.textSecondary} title={r.note}>
                  {r.label}
                </Text>
                <Text as="dd" fontFamily={TYPOGRAPHY.fontMono} fontSize="11px" textAlign="right" color={r.op === '=' ? SEMANTIC_COLORS.textPrimary : SEMANTIC_COLORS.textSecondary} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                  {r.apr === null ? 'curator-set' : `${r.bound === 'upper' ? '≤ ' : ''}${pct(r.apr)}`}
                </Text>
                <ClassTag c={r.labelClass as LabelClass} />
              </React.Fragment>
            ))}
          </Box>

          {/* Incentive expiry — the end date is half the number. */}
          {b.incentives.eligible.map((c) => {
            const left = daysLeft(c.endTs, nowTs)
            return (
              <Mono key={c.campaignId} color={left < 7 ? SEMANTIC_COLORS.warning : SEMANTIC_COLORS.textSecondary}>
                + {pct(c.aprAtSize)} {c.rewardSymbol ?? 'rewards'} · ends {day(c.endTs)} ({left}d) · {DILUTION_WORDS[c.dilution] ?? c.dilution}
              </Mono>
            )
          })}
          {b.incentives.conditional.map((c) => (
            <Mono key={c.campaignId} color={SEMANTIC_COLORS.textTertiary}>
              not in net: {pct(c.aprReported)} {c.rewardSymbol ?? ''} · {c.conditions.join(', ')} · ends {day(c.endTs)}
            </Mono>
          ))}
          {!q.data?.incentivesStatus.ok ? <Mono color={SEMANTIC_COLORS.textTertiary}>incentives: unavailable at fetch time</Mono> : null}

          {/* Rate-spike line: one line, next to the numbers it qualifies (V10). */}
          <Mono color={SEMANTIC_COLORS.textSecondary}>
            borrow if utilization → kink {pct(b.worstCase.kinkUtilization, 0)}: {pct(b.worstCase.borrowAprAtKink)} · → 100%: {pct(b.worstCase.borrowAprAtFull)}
            {b.worstCase.borrowAprAtFullAfter7d !== null ? ` · 7d at 100%: ${pct(b.worstCase.borrowAprAtFullAfter7d)}` : ''}
          </Mono>

          <Stamp>
            PROJECTION · ON-CHAIN IRM AT BLOCK {b.anchor.blockNumber} · {q.data?.rpc} · MERKL {q.data?.incentivesStatus.ok ? 'REPORTED' : 'UNAVAILABLE'} ·
            $1.00/STABLE · NOT A FORECAST
          </Stamp>
        </>
      )}
    </Card>
  )
}

export default NetApyCard
