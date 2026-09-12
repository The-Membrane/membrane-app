// CAN THE VENUE PAY YOU BACK TODAY — the carrier's own deployments, stressed against
// the recorder's latest observation.
//
// Owner ruling 2026-09-12: "Show our venue visualizer for the carrier's deployments."
// The carry page claims the venue capital is what answers a margin call. That claim is
// worth nothing unless the reader can see whether the venue could actually return the
// money, at THEIR size, on the day they are reading. One row per detected venue: what
// they hold, what the recorder last observed, and the one-word verdict.
//
// HONESTY RULES on this surface, inherited from the Radar (components/Radar/radarLogic
// header) and non-negotiable:
//
//  - THE VERDICT IS NOT COMPUTED HERE. computeVenueVerdict is imported and fed the same
//    four inputs the Radar feeds it (tvl / instant / cooldown / flow, from
//    /api/sim/venue-capacity → readCorpus). A venue must never read 'caution' on the
//    Radar and 'clear' here. Weakest prong wins; nothing is averaged.
//  - THE BANDS ARE DERIVED, AND SAY SO. venue_snapshots.cooling_usd and .stranded_usd
//    are NULL on every row ever recorded (0 of 993, measured 2026-09-12) because the
//    reader refuses to fabricate the split. The route derives the three bands from
//    recorded fields alone and ships the rule with them; it is rendered in the stamp's
//    title so the bar is auditable rather than decorative.
//  - A VENUE THE RECORDER DOES NOT COVER GETS NO BAR. It says so instead. The sim's
//    KNOWN_VENUES (sDAI, the aTokens, sfrxUSD) are wider than the recorder's four.
//  - EMPTY WHILE LOADING. A pulsing baseline, never a stale or placeholder number.

import React from 'react'
import { keyframes } from '@emotion/react'
import { Box, Text } from '@chakra-ui/react'
import { useQuery } from '@tanstack/react-query'

import {
  computeVenueVerdict,
  fmtUsd,
  type VenueKind,
  type Verdict,
} from '@/components/Radar/radarLogic'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import type { SimVenueCapacityResponse } from '@/pages/api/sim/venue-capacity'
import type { VenueDetection } from '@/lib/position-sim/venues'

/** Living Typeface: phosphor = it leaves now, gold = it is gated, blood = it is stuck. */
const BAND_COLOR = {
  instant: SEMANTIC_COLORS.success,
  cooling: SEMANTIC_COLORS.warning,
  stranded: SEMANTIC_COLORS.danger,
} as const

const VERDICT_COLOR: Record<Verdict, string> = {
  clear: SEMANTIC_COLORS.success,
  caution: SEMANTIC_COLORS.warning,
  exposed: SEMANTIC_COLORS.danger,
}

const pulse = keyframes`
  0% { opacity: 0.18; }
  50% { opacity: 0.55; }
  100% { opacity: 0.18; }
`

/** Sub-dollar dust is a real read, but "$8e-7" is not a number a reader can use. */
const money = (n: number): string => (n > 0 && n < 1 ? '<$1' : fmtUsd(n))

/** A band that was never recorded prints an em dash, never a zero. */
const band = (n: number | null | undefined): string => (n == null ? '—' : money(n))

const useVenueCapacity = () =>
  useQuery<SimVenueCapacityResponse>({
    queryKey: ['sim_venue_capacity'],
    queryFn: async () => {
      const r = await fetch('/api/sim/venue-capacity')
      if (!r.ok) throw new Error(`venue capacity ${r.status}`)
      return r.json()
    },
    staleTime: 1000 * 60 * 5,
    // Same override as CarrySection's tiles: an empty or errored first fetch must not
    // stick for the whole session behind the app-wide refetchOnMount:false.
    refetchOnMount: true,
  })

const Line: React.FC<{ children: React.ReactNode; color?: string; size?: string }> = ({
  children,
  color,
  size = '10px',
}) => (
  <Text
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize={size}
    letterSpacing="0.12em"
    color={color ?? SEMANTIC_COLORS.textSecondary}
    sx={{ fontVariantNumeric: 'tabular-nums' }}
  >
    {children}
  </Text>
)

/**
 * The three-band bar, proportional to the venue's whole recorded book, with the
 * wallet's own balance drawn on it as a marker.
 *
 * The marker is placed at its TRUE fraction and never nudged into view. A $59k holding
 * against a $4.6B book is a hairline at the left edge, and that is the honest picture —
 * moving it to a "visible" position would invent a share of the venue the reader
 * does not have.
 */
const BandBar: React.FC<{
  instantUsd: number | null
  coolingUsd: number | null
  strandedUsd: number | null
  bookUsd: number | null
  youUsd: number
}> = ({ instantUsd, coolingUsd, strandedUsd, bookUsd, youUsd }) => {
  const total = bookUsd ?? (instantUsd ?? 0) + (coolingUsd ?? 0) + (strandedUsd ?? 0)
  if (!(total > 0)) return null
  const pct = (n: number | null) => (n == null ? 0 : Math.max(0, Math.min(100, (n / total) * 100)))
  const markerPct = Math.max(0, Math.min(100, (youUsd / total) * 100))
  return (
    <Box position="relative" h="8px" w="100%" bg={SEMANTIC_COLORS.bgPrimary} display="flex">
      <Box h="100%" w={`${pct(instantUsd)}%`} bg={BAND_COLOR.instant} />
      <Box h="100%" w={`${pct(coolingUsd)}%`} bg={BAND_COLOR.cooling} opacity={0.8} />
      <Box h="100%" w={`${pct(strandedUsd)}%`} bg={BAND_COLOR.stranded} opacity={0.7} />
      <Box
        aria-hidden
        position="absolute"
        top="-3px"
        bottom="-3px"
        left={`${markerPct}%`}
        w="2px"
        ml="-1px"
        bg={SEMANTIC_COLORS.textPrimary}
      />
    </Box>
  )
}

export interface VenueCapacityProps {
  /** The detection on screen — the demo's, or the one a pasted address produced. */
  detection: VenueDetection
}

/**
 * One row per venue the wallet is actually deployed in.
 *
 * `detection` is expected POST-excludeOwnCollateral (Simulator.tsx filters on the way
 * in): a borrower's own aToken collateral is not a deployment and must not appear here
 * claiming the venue owes them anything.
 */
export const VenueCapacity: React.FC<VenueCapacityProps> = ({ detection }) => {
  const { data } = useVenueCapacity()

  const held =
    detection.status === 'detected'
      ? // Dust (< $10) is not a deployment; it would only add a noise row.
        detection.detected.filter((d) => d.valueUsd >= 10).sort((a, b) => b.valueUsd - a.valueUsd)
      : []

  const byName = new Map((data?.venues ?? []).map((v) => [v.venue.toLowerCase(), v]))
  const observedAt = data?.venues.find((v) => v.observedAt)?.observedAt
  const stamp = `observed · hourly recorder · ${observedAt ? observedAt.slice(0, 10) : '—'}`
  const rule = data?.venues[0]?.bands.rule

  return (
    <Box
      data-testid="sim-venue-capacity"
      display="grid"
      gap={SPACING.sm}
      border="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
      bg={SEMANTIC_COLORS.bgPrimary}
      borderRadius={0}
      p={SPACING.base}
    >
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="10px"
        letterSpacing="0.18em"
        textTransform="uppercase"
        color={SEMANTIC_COLORS.textSecondary}
      >
        can the venue pay you back today
      </Text>

      {held.length === 0 ? (
        <Line>no venue deployment detected for this wallet</Line>
      ) : !data ? (
        <Box
          data-testid="sim-venue-capacity-pending"
          h="2px"
          w="56px"
          bg={SEMANTIC_COLORS.textTertiary}
          animation={`${pulse} 1.6s ease-in-out infinite`}
        />
      ) : (
        held.map((d) => {
          const rec = byName.get(d.venue.symbol.toLowerCase())
          if (!rec) {
            return (
              <Box key={d.venue.symbol} display="grid" gap="4px">
                <Line color={SEMANTIC_COLORS.textPrimary} size="11px">
                  {d.venue.symbol} · you {money(d.valueUsd)}
                </Line>
                <Line>not covered by the hourly venue recorder</Line>
              </Box>
            )
          }
          // The SAME engine the Radar runs, on the SAME recorded inputs.
          const v = computeVenueVerdict({
            venue: rec.venue,
            label: rec.label,
            kind: rec.kind as VenueKind,
            usd: d.valueUsd,
            tvlUsd: rec.stress.tvlUsd,
            instantUsd: rec.stress.instantUsd,
            cooldownSeconds: rec.stress.cooldownSeconds,
            flow: rec.stress.flow,
          })
          return (
            <Box key={d.venue.symbol} display="grid" gap="4px">
              <Box display="flex" justifyContent="space-between" gap={SPACING.sm}>
                <Line color={SEMANTIC_COLORS.textPrimary} size="11px">
                  {rec.label} · you {money(d.valueUsd)}
                </Line>
                <Line color={VERDICT_COLOR[v.verdict]} size="11px">
                  {v.verdict}
                </Line>
              </Box>
              <BandBar
                instantUsd={rec.bands.instantUsd}
                coolingUsd={rec.bands.coolingUsd}
                strandedUsd={rec.bands.strandedUsd}
                bookUsd={rec.bands.bookUsd}
                youUsd={d.valueUsd}
              />
              <Line>
                instant {band(rec.bands.instantUsd)} · cooling {band(rec.bands.coolingUsd)} ·
                stranded {band(rec.bands.strandedUsd)}
              </Line>
            </Box>
          )
        })
      )}

      {/* The derivation lives in the title attribute rather than the layout: the bands
          are derived (the recorder stores no cooling/stranded split) and a reader who
          wants to audit the bar can read exactly how, without a paragraph on screen. */}
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="9px"
        letterSpacing="0.12em"
        color={SEMANTIC_COLORS.textTertiary}
        title={rule}
      >
        {stamp}
      </Text>
    </Box>
  )
}

export default VenueCapacity
