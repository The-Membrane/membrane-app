import { Box, HStack, SimpleGrid, Text, VStack } from '@chakra-ui/react'
import React from 'react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { Card } from '@/components/ui/Card'

import { Eyebrow, Stat } from './atoms'
import { GRID_END_MARK, PROTOCOL_NAME, pct } from './format'
import { EvidenceMeta, ProtocolKey, Sensitivity, TimeSummary } from './types'

/** One step of the funnel, drawn as a proportional bar. */
const Step: React.FC<{
  label: string
  n: number
  of: number
  color: string
  note: string
}> = ({ label, n, of, color, note }) => (
  <VStack align="stretch" spacing={SPACING.xs}>
    <HStack justify="space-between" align="flex-start">
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.small}
        color={SEMANTIC_COLORS.textPrimary}
      >
        {label}
      </Text>
      <HStack spacing={SPACING.sm} flexShrink={0}>
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small} color={color}>
          {n.toLocaleString('en-US')}
        </Text>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
          color={SEMANTIC_COLORS.textTertiary}
        >
          {pct(n / of)}
        </Text>
      </HStack>
    </HStack>
    <Box h="8px" w="100%" bg={SEMANTIC_COLORS.bgTertiary}>
      <Box h="100%" w={`${(n / of) * 100}%`} bg={color} />
    </Box>
    <Text
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize={TYPOGRAPHY.xs}
      color={SEMANTIC_COLORS.textTertiary}
    >
      {note}
    </Text>
  </VStack>
)

/**
 * What the 8-hour window did to the census, MODELLED (†), not diagnosed.
 *
 * The walk (lib/wavefront/kernel.ts, the incremental form of lib/position-sim/curePath.ts)
 * follows LiquidationEngine.sol: a breach inside the band starts the delay; a return under
 * the line clears it and a later breach starts a fresh one; a move past line x (1 + band)
 * sells at that minute; still over the line at expiry sells at that minute. The census
 * figure is the SUM of those sales. This lens shows how every position resolved and what
 * the delay was worth against one immediate repay to cap.
 *
 * Path-dependent, and says so: 10 Oct was a sharp wick with a partial recovery.
 */
/**
 * The outcome of a position is its own, or, for a position split by delay class, its LARGER
 * half's. So the two "not sold" rows describe that half only: the other half of a split
 * position can have been sold. Each row's note says how many of its positions had a sale on
 * any half (time.outcomeWithSale), and the "Never sold" tile counts sales === 0 only.
 */
const OUTCOME_ROWS: {
  key: string
  label: string
  note: (n: number, withSale: number) => string
  tone: 'good' | 'bad' | 'gate' | 'dim'
}[] = [
  {
    key: 'cured-then-held',
    label: 'Back under the line inside the window; that position (or larger half) not sold',
    note: (n, s) =>
      s > 0
        ? `${(n - s).toLocaleString('en-US')} never sold at all; on ${s.toLocaleString('en-US')} split positions the other half was sold`
        : 'the delay held and the window ended with the position intact',
    tone: 'good',
  },
  {
    key: 'held',
    label: 'Larger half opened under its own line and never crossed it',
    note: (n, s) =>
      s > 0
        ? `the other half was sold on ${s.toLocaleString('en-US')} of these ${n.toLocaleString('en-US')}`
        : 'no window was needed and nothing was sold',
    tone: 'good',
  },
  {
    key: 'sold-at-expiry',
    label: 'Still over the line at 8h; sold then',
    note: () => 'repay to cap at that minute’s price',
    tone: 'bad',
  },
  {
    key: 'sold-at-band',
    label: 'Broke the band during the delay; sold at that minute',
    note: () => 'LTV passed line × 1.04 while the timer ran',
    tone: 'bad',
  },
  // A window still open at 23:59 UTC 11 Oct is NOT a completed sale (the wavefront page
  // draws it apart). The census books it at the last price, conservatively; it is gold here
  // and marked in the table, never coloured as a sale the walk decided.
  {
    key: 'sold-at-grid-end',
    label: `${GRID_END_MARK} Window still open when the data ends; booked as sold at the last price†`,
    note: () => 'not a completed sale: the conservative assumption at 23:59 UTC 11 Oct',
    tone: 'gate',
  },
  // Immediate at t0 (LiquidationEngine.sol:1694-1703 at 16e12329), then the position walks on
  // like after any sale (a sale leaves no timer, :1724-1727).
  {
    key: 'sold-at-t0',
    label: 'Already past the band at the first liquidation; no delay exists',
    note: () => 'repaid to cap at once, then walked on like any sold position',
    tone: 'bad',
  },
  // The no-delay class (stable collateral, or a line above 90%): instant mode,
  // LiquidationEngine.sol:1572-1576 — sold the minute it is over its line, every time.
  {
    key: 'sold-no-delay',
    label: 'Stablecoin collateral (or a line above 90%): no 8-hour window†, sold at the line',
    note: () => 'Membrane gives this collateral no window†',
    tone: 'bad',
  },
]

const usdM = (v: number) => `$${(v / 1e6).toFixed(1)}M`
const PROTOCOLS: ProtocolKey[] = ['aave-v3', 'morpho-blue']

const SENS_ROWS: { key: keyof TimeSummary['sensitivity']; label: string }[] = [
  { key: 'noEarlyClear', label: 'nobody clears the timer early' },
  { key: 'noDebtFloor', label: 'no $2,000 floor' },
  { key: 'singleSale', label: 'one sale per position' },
  { key: 'noWalkOnAfterT0BandSale', label: 'stop after a sale at t0' },
  { key: 't0PriceBasis', label: 't0 at block N−1 prices' },
]

export const TimeLens: React.FC<{ time: TimeSummary; meta: EvidenceMeta }> = ({ time, meta }) => {
  const total = Object.values(time.outcomes).reduce((a, b) => a + b, 0)
  const rows = OUTCOME_ROWS.filter((r) => (time.outcomes[r.key] ?? 0) > 0)
  const colorOf = (t: 'good' | 'bad' | 'gate' | 'dim') =>
    t === 'good'
      ? SEMANTIC_COLORS.success
      : t === 'bad'
        ? SEMANTIC_COLORS.danger
        : t === 'gate'
          ? SEMANTIC_COLORS.warning
          : SEMANTIC_COLORS.textTertiary
  const one = time.oneRepay
  const cure = time.cure
  const headline = time.bandSensitivity.find((b) => b.band === meta.params.band)
  const split = (s: Sensitivity) =>
    s.byProtocol
      ? ` · ${PROTOCOLS.map((k) => `${PROTOCOL_NAME[k].split(' ')[0]} ${usdM(s.byProtocol![k])}`).join(' · ')}`
      : ''

  return (
    <VStack align="stretch" spacing={SPACING_PATTERNS.sectionGap}>
      <SimpleGrid columns={{ base: 2, md: 4 }} spacing={SPACING_PATTERNS.sectionGap}>
        <Stat
          label="Time the protocols grant"
          value={`${time.protocolSecondsGranted}s`}
          tone="bad"
          sub="liquidation is atomic, same block"
        />
        <Stat
          label="Time Membrane grants"
          value={`${time.membraneSecondsGranted / 3600}h`}
          tone="good"
          sub={`within ${(meta.params.band * 100).toFixed(0)}% of the line · none for stablecoins†`}
        />
        <Stat
          label="Worth, against one repay"
          value={`${usdM(one.delayCreditUsd)}†`}
          tone={one.delayCreditUsd >= 0 ? 'good' : 'bad'}
          sub={`${usdM(one.memOneRepayUsd)} one repay → ${usdM(one.memWalkUnlimitedUsd)} with the delay · both without the liquidity cap`}
        />
        <Stat
          label="Never sold"
          value={time.neverSold.positions.toLocaleString('en-US')}
          tone="good"
          sub={`of ${total.toLocaleString('en-US')} positions; no sale on any half†`}
        />
      </SimpleGrid>

      <Card variant="default">
        <VStack align="stretch" spacing={SPACING_PATTERNS.stackSpacing}>
          <Eyebrow>How every position resolved† · a split position by its larger half</Eyebrow>
          {rows.map((r) => (
            <Step
              key={r.key}
              label={r.label}
              n={time.outcomes[r.key] ?? 0}
              of={total}
              color={colorOf(r.tone)}
              note={r.note(time.outcomes[r.key] ?? 0, time.outcomeWithSale[r.key] ?? 0)}
            />
          ))}
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textTertiary}
            lineHeight="1.7"
          >
            {`${time.windowPositions.toLocaleString('en-US')} positions hold collateral that gets the window (${time.classes.mixed.toLocaleString('en-US')} of them split, because they also hold stablecoins); the other ${time.classes['no-delay'].toLocaleString('en-US')} have none (stablecoin collateral, or a line above 90%) and are sold at the line. A split position is walked as the two positions Membrane would hold and is listed here by its larger half. Back under the line, larger half not sold, by protocol: ${PROTOCOLS.map(
              (k) =>
                `${PROTOCOL_NAME[k]} ${(time.outcomesByProtocol[k]['cured-then-held'] ?? 0).toLocaleString('en-US')}`,
            ).join(', ')}.`}
          </Text>
        </VStack>
      </Card>

      <Card variant="default">
        <VStack align="stretch" spacing={SPACING_PATTERNS.stackSpacing}>
          <Eyebrow>Where the credit comes from, and what the band does</Eyebrow>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.small}
            color={SEMANTIC_COLORS.textPrimary}
            lineHeight="1.7"
          >
            {`Without the liquidity cap on either side (one repay is not a walk the cap can be applied to): one repay to cap at the first liquidation, with no window, would close ${usdM(one.memOneRepayUsd)}† (${PROTOCOLS.map((k) => `${PROTOCOL_NAME[k]} ${usdM(one.byProtocol[k].memOneRepayUsd)}`).join(', ')}). ${usdM(one.cureCreditUsd)}† of it is on positions that came back under their line: ${one.cureCreditShareWithin2min.toFixed(0)}% of that within two minutes of the breach, ${one.cureCreditShareWithin1h.toFixed(0)}% within the hour, ${one.cureCreditShareWithin8h.toFixed(0)}% inside the eight. Against it, on ${one.counterCreditPositions.toLocaleString('en-US')} positions the walk ends up selling ${usdM(one.counterCreditUsd)}† more than one repay would have. Prices are each oracle’s price in force at each minute’s start; a cure needs a fresh price, and the ${time.freshPrints.chain === 'mainnet' ? 'Ethereum' : time.freshPrints.chain} ${time.freshPrints.symbol} AaveOracle price changed in ${time.freshPrints.minutes.toLocaleString('en-US')} of ${time.freshPrints.gridMinutes.toLocaleString('en-US')} minutes.`}
          </Text>
          <HStack spacing={SPACING_PATTERNS.sectionGap} flexWrap="wrap" align="flex-start">
            {time.bandSensitivity.map((b) => (
              <Stat
                key={b.band}
                label={`band ${(b.band * 100).toFixed(0)}%`}
                value={`${usdM(b.memRepaidUsd)}†`}
                tone={b.band === meta.params.band ? 'good' : 'muted'}
                sub={`${b.band === meta.params.band ? 'launch parameter, owner-set (Collateral.sol:223,232)' : 'sensitivity'} · ${PROTOCOLS.map((k) => `${PROTOCOL_NAME[k].split(' ')[0]} ${usdM(b.byProtocol[k])}`).join(' · ')}`}
              />
            ))}
          </HStack>
          <VStack align="stretch" spacing={SPACING.xs}>
            <Eyebrow>Other corners, same walk, one rule changed</Eyebrow>
            {SENS_ROWS.map(({ key, label }) => {
              const s = time.sensitivity[key]
              return (
                <Text
                  key={key}
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.xs}
                  color={SEMANTIC_COLORS.textSecondary}
                  lineHeight="1.7"
                  title={s.rule}
                >
                  {`${label}: ${usdM(s.memRepaidUsd)}†${split(s)} (headline ${usdM(headline?.memRepaidUsd ?? 0)}; its own ${s.set ? s.set.positions.toLocaleString('en-US') : ''} positions, protocols ${s.set ? usdM(s.set.realRepaidUsd) : ''})`}
                </Text>
              )
            })}
          </VStack>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textTertiary}
            lineHeight="1.7"
          >
            {`Diagnostic, older and looser: ${cure.curedPct}% of the ${cure.accountsAnalysed.toLocaleString('en-US')} positions dipped back under their line at some point in the eight hours on price alone (the lowest point came a median ${cure.medianMinutesToCure} min after the first liquidation), and ${cure.healthyAt8hPct}% were under it at the 8h mark. ${PROTOCOLS.map((k) => `${PROTOCOL_NAME[k]} ${cure.byProtocol[k].curedPct}%`).join(', ')}.${cure.noDelay.accounts ? ` The ${cure.noDelay.accounts.toLocaleString('en-US')} positions with no 8-hour window count as not cured; ${cure.noDelay.wouldHaveCuredWithWindow.toLocaleString('en-US')} would have dipped back on price alone.` : ''} The model above is stricter: it sells on a band break and at expiry.`}
          </Text>
        </VStack>
      </Card>
    </VStack>
  )
}
