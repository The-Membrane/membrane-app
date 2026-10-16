import { Box, Grid, HStack, SimpleGrid, Text, VStack } from '@chakra-ui/react'
import React from 'react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { Card } from '@/components/ui/Card'

import { CompareBar, Eyebrow, InfoTip, Stat } from './atoms'
import { CURE_LEGEND, GRID_END_MARK, PROTOCOL_NAME, gapWord, pct, usd } from './format'
import { AssetSummary, DebtSet, DebtSummary, EvidenceMeta, ProtocolKey } from './types'

const PROTOCOLS: ProtocolKey[] = ['aave-v3', 'morpho-blue']
const SPLIT_COLS = '1.6fr 0.8fr 1fr 1fr 1.2fr'

const Cell: React.FC<{ children: React.ReactNode; color?: string; size?: string }> = ({
  children,
  color = SEMANTIC_COLORS.textPrimary,
  size = TYPOGRAPHY.small,
}) => (
  <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={size} color={color}>
    {children}
  </Text>
)

/**
 * One row of the split table: positions, both sides, the gap with its direction. From md up
 * it is a five-column grid; on a phone the same figures stack in two lines, so the Membrane
 * side and the difference are never behind a horizontal scroll.
 */
const SplitRow: React.FC<{
  label: string
  s: Pick<DebtSet, 'positions' | 'realRepaidUsd' | 'memRepaidUsd' | 'gapUsd' | 'gapPct'>
  minor?: boolean
}> = ({ label, s, minor }) => {
  const size = minor ? TYPOGRAPHY.xs : TYPOGRAPHY.small
  const dim = minor ? SEMANTIC_COLORS.textSecondary : SEMANTIC_COLORS.textPrimary
  const gapColor = s.gapUsd >= 0 ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.danger
  return (
    <Box
      py={minor ? SPACING.xs : SPACING.md}
      pl={minor ? SPACING.base : SPACING.none}
      borderBottom="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
    >
      <Grid
        display={{ base: 'none', md: 'grid' }}
        templateColumns={SPLIT_COLS}
        gap={SPACING.md}
        alignItems="center"
      >
        <Cell color={dim} size={size}>
          {label}
        </Cell>
        <Cell color={SEMANTIC_COLORS.textSecondary} size={size}>
          {s.positions.toLocaleString('en-US')}
        </Cell>
        <Cell color={dim} size={size}>
          {usd(s.realRepaidUsd)}
        </Cell>
        <Cell color={dim} size={size}>
          {usd(s.memRepaidUsd)}†
        </Cell>
        <Cell color={gapColor} size={size}>
          {usd(Math.abs(s.gapUsd))} · {gapWord(s.gapPct)}
        </Cell>
      </Grid>
      <VStack display={{ base: 'flex', md: 'none' }} align="stretch" spacing={SPACING.none}>
        <HStack justify="space-between" align="baseline">
          <Cell color={dim} size={size}>
            {label}
          </Cell>
          <Cell color={SEMANTIC_COLORS.textSecondary} size={TYPOGRAPHY.xs}>
            {s.positions.toLocaleString('en-US')} positions
          </Cell>
        </HStack>
        <Cell color={SEMANTIC_COLORS.textSecondary} size={TYPOGRAPHY.xs}>
          {usd(s.realRepaidUsd)} → {usd(s.memRepaidUsd)}†{' '}
          <Text as="span" color={gapColor}>
            {usd(Math.abs(s.gapUsd))} · {gapWord(s.gapPct)}
          </Text>
        </Cell>
      </VStack>
    </Box>
  )
}

/**
 * How much of each position's debt gets closed — the path-independent lens, and the one to
 * lead with. Whether a liquidation "saved" equity depends on where the market went next; how
 * much of the loan was closed out does not.
 *
 * THE SPLIT IS ALWAYS ON SCREEN. The whole-census figure leads, and the Aave / Morpho split
 * (and each venue on each chain under it) sits directly beneath it: the two protocols tell
 * different stories (Morpho's liquidators close most loans whole), and a blended number
 * must never stand without them.
 */
export const DebtLens: React.FC<{
  debt: DebtSummary
  byAsset: AssetSummary[]
  meta: EvidenceMeta
}> = ({ debt, byAsset, meta }) => {
  const all = debt.all
  const moreDebt = all.gapUsd < 0
  const floor = all.medians.floorUsd
  const big = all.medians.atLeastFloor

  return (
    <VStack align="stretch" spacing={SPACING_PATTERNS.sectionGap}>
      <SimpleGrid columns={{ base: 2, md: 4 }} spacing={SPACING_PATTERNS.sectionGap}>
        <Stat
          label="Positions"
          value={all.positions.toLocaleString('en-US')}
          sub="every liquidation · Aave + Morpho · four chains"
        />
        <Stat
          label="Protocols closed"
          value={usd(all.realRepaidUsd)}
          tone="bad"
          sub="every liquidation, both days"
        />
        <Stat
          label="Membrane would close"
          value={`${usd(all.memRepaidUsd)}†`}
          tone={moreDebt ? 'bad' : 'good'}
          sub="8h window, walked minute by minute"
        />
        <Stat
          label="Difference"
          value={usd(Math.abs(all.gapUsd))}
          tone={moreDebt ? 'bad' : 'good'}
          sub={`${gapWord(all.gapPct)} debt closed†`}
        />
      </SimpleGrid>

      <Card variant="default">
        <VStack align="stretch" spacing={SPACING.sm}>
          <Eyebrow>The same numbers, by protocol and chain</Eyebrow>
          <Box>
            <Box>
              <Grid
                display={{ base: 'none', md: 'grid' }}
                templateColumns={SPLIT_COLS}
                gap={SPACING.md}
                pb={SPACING.sm}
                borderBottom="1px solid"
                borderColor={SEMANTIC_COLORS.borderMedium}
              >
                {['Venue', 'Positions', 'Protocol closed', 'Membrane', 'Difference'].map((h) => (
                  <Eyebrow key={h}>{h}</Eyebrow>
                ))}
              </Grid>
              {PROTOCOLS.map((k) => (
                <React.Fragment key={k}>
                  <SplitRow label={PROTOCOL_NAME[k]} s={debt.byProtocol[k]} />
                  {debt.byVenueChain
                    .filter((v) => v.protocol === k)
                    .map((v) => (
                      <SplitRow key={v.key} label={v.label} s={v} minor />
                    ))}
                </React.Fragment>
              ))}
              <SplitRow label="All" s={all} />
            </Box>
          </Box>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textTertiary}
            lineHeight="1.7"
          >
            Membrane&rsquo;s totals include {usd(meta.gridEnd.memRepaidUsd)}† booked for the{' '}
            {meta.gridEnd.positions.toLocaleString('en-US')} positions whose 8-hour window was still
            open when the data ends (23:59 UTC 11 Oct): a window still open is not a completed sale,
            so the census books it at the last price and the table marks it {GRID_END_MARK}.{' '}
            {meta.unpriced.positions.toLocaleString('en-US')} Morpho positions borrow a token with
            no USD price that day ({meta.unpriced.loanSymbols.join(', ')}): they are in every count
            and in no dollar figure. Morpho&rsquo;s{' '}
            {usd(debt.byProtocol['morpho-blue'].realBadDebtUsd)} of realised bad debt is not counted
            as repaid.
          </Text>
        </VStack>
      </Card>

      <Card variant="default">
        <VStack align="stretch" spacing={SPACING_PATTERNS.stackSpacing}>
          <Eyebrow>
            Median share of the position&rsquo;s debt closed · debt of $
            {floor.toLocaleString('en-US')} or more
          </Eyebrow>
          <CompareBar
            aLabel="Protocols — every liquidation of the position"
            aValue={big.realMedianFrac}
            bLabel="Membrane† — the 8h window, walked"
            bValue={big.memMedianFrac}
            format={(v) => pct(v)}
          />
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textSecondary}
            lineHeight="1.7"
          >
            {PROTOCOLS.map((k) => {
              const b = debt.byProtocol[k].medians.atLeastFloor
              return `${PROTOCOL_NAME[k]}: ${pct(b.realMedianFrac)} vs ${pct(b.memMedianFrac)}† over ${b.positions.toLocaleString('en-US')} positions`
            }).join(' · ')}
          </Text>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textTertiary}
            lineHeight="1.7"
          >
            Over every priced position, the {all.medians.all.positions.toLocaleString('en-US')}{' '}
            including those under ${floor.toLocaleString('en-US')} that both sides close whole, the
            medians are {pct(all.medians.all.realMedianFrac)} and{' '}
            {pct(all.medians.all.memMedianFrac)}† (
            {PROTOCOLS.map(
              (k) =>
                `${PROTOCOL_NAME[k]} ${pct(debt.byProtocol[k].medians.all.realMedianFrac)} vs ${pct(debt.byProtocol[k].medians.all.memMedianFrac)}†`,
            ).join(', ')}
            ). The protocols&rsquo; side is every liquidation the position took across both days;
            Membrane&rsquo;s is the debt its walk closes, as a share of the debt at the first
            liquidation.
          </Text>
        </VStack>
      </Card>

      <SimpleGrid columns={{ base: 1, md: 2 }} spacing={SPACING_PATTERNS.sectionGap}>
        <Card variant="subtle">
          <VStack align="flex-start" spacing={SPACING.sm}>
            <Eyebrow color={SEMANTIC_COLORS.success}>Membrane closes less†</Eyebrow>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.h1}
              color={SEMANTIC_COLORS.success}
            >
              {all.less.toLocaleString('en-US')}
            </Text>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textSecondary}
            >
              {pct(all.less / all.pricedPositions)} of the{' '}
              {all.pricedPositions.toLocaleString('en-US')} priced positions — the borrower keeps
              more of the position. Aave {debt.byProtocol['aave-v3'].less.toLocaleString('en-US')} ·
              Morpho {debt.byProtocol['morpho-blue'].less.toLocaleString('en-US')}.
            </Text>
          </VStack>
        </Card>

        <Card variant="subtle">
          <VStack align="flex-start" spacing={SPACING.sm}>
            <Eyebrow color={SEMANTIC_COLORS.danger}>Membrane closes more†</Eyebrow>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.h1}
              color={SEMANTIC_COLORS.danger}
            >
              {all.more.toLocaleString('en-US')}
            </Text>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textSecondary}
            >
              {pct(all.more / all.pricedPositions)} of them — Aave{' '}
              {debt.byProtocol['aave-v3'].more.toLocaleString('en-US')} · Morpho{' '}
              {debt.byProtocol['morpho-blue'].more.toLocaleString('en-US')}. The protocols declined
              to close these as far; Membrane&rsquo;s formula would have.{' '}
              {all.equal.toLocaleString('en-US')} come out equal to the cent. Filter the table by
              &ldquo;Membrane worse&rdquo; to read them.
            </Text>
          </VStack>
        </Card>
      </SimpleGrid>

      <VStack align="stretch" spacing={SPACING_PATTERNS.stackSpacing}>
        <Eyebrow>By collateral asset (the largest leg at the first liquidation)</Eyebrow>
        <Box overflowX="auto">
          <Box minW="600px">
            <Grid
              templateColumns="1fr 1.1fr 1fr 1fr 80px"
              gap={SPACING.md}
              pb={SPACING.sm}
              borderBottom="1px solid"
              borderColor={SEMANTIC_COLORS.borderMedium}
            >
              {[
                'Asset',
                'Positions (Aave / Morpho)',
                'Protocol median',
                'Membrane median',
                'Cured',
              ].map((h) => (
                <HStack key={h} spacing={SPACING.none} align="center">
                  <Eyebrow>{h}</Eyebrow>
                  {h === 'Cured' ? <InfoTip term="Cured" label={CURE_LEGEND} /> : null}
                </HStack>
              ))}
            </Grid>
            {byAsset.map((a) => (
              <Grid
                key={a.symbol}
                templateColumns="1fr 1.1fr 1fr 1fr 80px"
                gap={SPACING.md}
                py={SPACING.md}
                borderBottom="1px solid"
                borderColor={SEMANTIC_COLORS.borderSubtle}
                alignItems="center"
              >
                <Cell>{a.symbol}</Cell>
                <Cell color={SEMANTIC_COLORS.textSecondary}>
                  {a.positions.toLocaleString('en-US')} ({a.aave} / {a.morpho})
                </Cell>
                <Cell color={SEMANTIC_COLORS.danger}>{pct(a.realMedianFrac)}</Cell>
                <Cell
                  color={
                    Math.round(a.memMedianFrac * 1000) <= Math.round(a.realMedianFrac * 1000)
                      ? SEMANTIC_COLORS.success
                      : SEMANTIC_COLORS.danger
                  }
                >
                  {pct(a.memMedianFrac)}†
                </Cell>
                <Cell
                  color={
                    a.curedPct == null ? SEMANTIC_COLORS.textTertiary : SEMANTIC_COLORS.textPrimary
                  }
                >
                  {a.curedPct == null ? 'n/a' : `${a.curedPct}%`}
                </Cell>
              </Grid>
            ))}
          </Box>
        </Box>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
          color={SEMANTIC_COLORS.textTertiary}
        >
          Assets that are the largest leg of fewer than 20 positions are omitted.
          &ldquo;Cured&rdquo; counts a position with no window (stablecoin collateral) as not cured,
          as the time lens does.
        </Text>
      </VStack>
    </VStack>
  )
}
