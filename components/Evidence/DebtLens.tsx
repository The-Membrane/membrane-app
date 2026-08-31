import { Box, Grid, HStack, SimpleGrid, Text, VStack } from '@chakra-ui/react'
import React from 'react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { Card } from '@/components/ui/Card'

import { CURE_LEGEND, CompareBar, Eyebrow, InfoTip, Stat, pct, usd } from './atoms'
import { AssetSummary, DebtSummary } from './types'

/**
 * How much of each borrower's debt gets closed.
 *
 * This is the path-independent lens, and the one worth leading with. Whether a
 * liquidation "saved" you equity depends on which way the market went next;
 * how much of your loan was closed out does not.
 */
export const DebtLens: React.FC<{
  debt: DebtSummary
  byAsset: Record<string, AssetSummary>
}> = ({ debt, byAsset }) => {
  const assets = Object.entries(byAsset).sort((a, b) => b[1].accounts - a[1].accounts)

  return (
    <VStack align="stretch" spacing={SPACING_PATTERNS.sectionGap}>
      <SimpleGrid columns={{ base: 2, md: 4 }} spacing={SPACING_PATTERNS.sectionGap}>
        <Stat label="Accounts" value={debt.accounts.toLocaleString()} sub="real, liquidated" />
        <Stat label="Aave closed" value={usd(debt.aaveClosedUsd)} tone="bad" sub="entire episode" />
        <Stat
          label="Membrane would close"
          value={usd(debt.membraneClosedUsd)}
          tone="good"
          sub="one repay to cap"
        />
        <Stat
          label="Difference"
          value={`${usd(debt.differenceUsd)}`}
          tone="good"
          sub={`${debt.differencePct}% less debt closed`}
        />
      </SimpleGrid>

      <Card variant="default">
        <VStack align="stretch" spacing={SPACING_PATTERNS.stackSpacing}>
          <Eyebrow>Median share of the account&rsquo;s debt closed</Eyebrow>
          <CompareBar
            aLabel="Aave — whole multi-hit episode"
            aValue={debt.aaveMedianFrac}
            bLabel="Membrane — a single repay to cap"
            bValue={debt.membraneMedianFrac}
            format={(v) => pct(v)}
          />
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textTertiary}
            lineHeight="1.7"
          >
            The comparison is tilted toward Aave on purpose: its entire episode, including
            every repeat liquidation, against one Membrane repay.
          </Text>
        </VStack>
      </Card>

      <SimpleGrid columns={{ base: 1, md: 2 }} spacing={SPACING_PATTERNS.sectionGap}>
        <Card variant="subtle">
          <VStack align="flex-start" spacing={SPACING.sm}>
            <Eyebrow color={SEMANTIC_COLORS.success}>Membrane closes less</Eyebrow>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.h1}
              color={SEMANTIC_COLORS.success}
            >
              {debt.membraneClosesLess.toLocaleString()}
            </Text>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textSecondary}
            >
              {pct(debt.membraneClosesLess / debt.accounts)} of accounts — the borrower keeps
              more of the position
            </Text>
          </VStack>
        </Card>

        <Card variant="subtle">
          <VStack align="flex-start" spacing={SPACING.sm}>
            <Eyebrow color={SEMANTIC_COLORS.danger}>Membrane closes more</Eyebrow>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.h1}
              color={SEMANTIC_COLORS.danger}
            >
              {debt.membraneClosesMore.toLocaleString()}
            </Text>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textSecondary}
            >
              {pct(debt.membraneClosesMore / debt.accounts)} of accounts — Aave declined to
              fully close these; Membrane&rsquo;s formula would have. Filter the cohort by
              &ldquo;Membrane worse&rdquo; to read them.
            </Text>
          </VStack>
        </Card>
      </SimpleGrid>

      <VStack align="stretch" spacing={SPACING_PATTERNS.stackSpacing}>
        <Eyebrow>By collateral asset</Eyebrow>
        <Box overflowX="auto">
          <Box minW="560px">
            <Grid
              templateColumns="1fr 80px 1fr 1fr 90px"
              gap={SPACING.md}
              pb={SPACING.sm}
              borderBottom="1px solid"
              borderColor={SEMANTIC_COLORS.borderMedium}
            >
              {['Asset', 'Accounts', 'Aave median', 'Membrane median', 'Cured'].map((h) => (
                <HStack key={h} spacing={SPACING.none} align="center">
                  <Eyebrow>{h}</Eyebrow>
                  {h === 'Cured' ? (
                    <InfoTip term="Cured" label={CURE_LEGEND} />
                  ) : null}
                </HStack>
              ))}
            </Grid>
            {assets.map(([sym, a]) => (
              <Grid
                key={sym}
                templateColumns="1fr 80px 1fr 1fr 90px"
                gap={SPACING.md}
                py={SPACING.md}
                borderBottom="1px solid"
                borderColor={SEMANTIC_COLORS.borderSubtle}
                alignItems="center"
              >
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.small}
                  color={SEMANTIC_COLORS.textPrimary}
                >
                  {sym}
                </Text>
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.small}
                  color={SEMANTIC_COLORS.textSecondary}
                >
                  {a.accounts}
                </Text>
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.small}
                  color={SEMANTIC_COLORS.danger}
                >
                  {pct(a.aaveMedianFrac)}
                </Text>
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.small}
                  color={SEMANTIC_COLORS.success}
                >
                  {pct(a.membraneMedianFrac)}
                </Text>
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.small}
                  color={
                    a.curedPct == null ? SEMANTIC_COLORS.textTertiary : SEMANTIC_COLORS.textPrimary
                  }
                >
                  {a.curedPct == null ? 'n/a' : `${a.curedPct}%`}
                </Text>
              </Grid>
            ))}
          </Box>
        </Box>
        <HStack>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textTertiary}
          >
            Assets with fewer than 20 accounts are omitted. &ldquo;Cured&rdquo; is blank where
            the Oct 10 oracle series cannot price that collateral.
          </Text>
        </HStack>
      </VStack>
    </VStack>
  )
}
