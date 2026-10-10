import React from 'react'
import { Box, Grid, HStack, Text } from '@chakra-ui/react'

import { Card } from '@/components/ui/Card'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import {
  inventoryShareLabel,
  newsFetchedAtLabel,
  observedInventoryShare,
  routeHeadroomAfterFlow,
  type NewsStorage,
  type ObservedCapacitySignal,
  type ValidatedRouteFlowOutlook,
} from '@/components/Venue/flowImpactCardLogic'
import {
  historicalScenarioMatchesCapacity,
  historicalResidualAfterAmount,
  type HistoricalInventoryCoverage,
  type HistoricalInventoryScenario,
} from '@/components/Venue/historicalInventoryScenarioLogic'

export type { ObservedCapacitySignal } from '@/components/Venue/flowImpactCardLogic'

export type FlowImpactNews = {
  title: string
  source: string
  url: string
  publishedAt: string | null
  fetchedAt: string
  storage?: NewsStorage
}

type Props = {
  venue: string
  venueKey: string
  capacityMetric: 'instantUsd' | 'depthUsd' | null
  amountUsd: number | null
  horizonHours: number | null
  capacity: ObservedCapacitySignal | null | undefined
  news: FlowImpactNews | null | undefined
  event: { label: string; at: string } | null
  outlook?: ValidatedRouteFlowOutlook | null
  historicalScenario?: HistoricalInventoryScenario | null
  historicalCoverage?: HistoricalInventoryCoverage | null
}

const money = (value: number): string => {
  const magnitude = Math.abs(value)
  const prefix = value < 0 ? '−' : ''
  if (magnitude >= 1e9) return `${prefix}$${(magnitude / 1e9).toFixed(2)}B`
  if (magnitude >= 1e6) return `${prefix}$${(magnitude / 1e6).toFixed(2)}M`
  if (magnitude >= 1e3) return `${prefix}$${(magnitude / 1e3).toFixed(1)}k`
  return `${prefix}$${magnitude.toFixed(0)}`
}

const time = (iso: string | null | undefined): string => {
  if (!iso || !Number.isFinite(Date.parse(iso))) return 'time unavailable'
  return `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

export const FlowImpactCard: React.FC<Props> = ({
  venue,
  venueKey,
  capacityMetric,
  amountUsd,
  horizonHours,
  capacity,
  news,
  event,
  outlook,
  historicalScenario,
  historicalCoverage,
}) => {
  const changeAvailable =
    capacity != null &&
    capacity.status !== 'unavailable' &&
    capacity?.before != null &&
    capacity?.after != null &&
    Number.isFinite(capacity.before.usd) &&
    Number.isFinite(capacity.after.usd) &&
    capacity.before.usd >= 0 &&
    capacity.after.usd >= 0 &&
    Number.isFinite(Date.parse(capacity.before.blockTime)) &&
    Number.isFinite(Date.parse(capacity.after.blockTime))
  const deltaUsd = changeAvailable ? capacity!.after!.usd - capacity!.before!.usd : null
  const headroom = routeHeadroomAfterFlow(outlook, amountUsd, horizonHours)
  const historicalRouteMatches = historicalScenarioMatchesCapacity(
    historicalScenario,
    venueKey,
    capacityMetric,
  )
  const historicalBand =
    !headroom && changeAvailable && historicalRouteMatches
      ? historicalResidualAfterAmount(
          historicalScenario,
          capacity!.after!.usd,
          amountUsd,
          horizonHours,
        )
      : null
  const pendingHistoricalWindows =
    !historicalBand &&
    !headroom &&
    historicalCoverage?.venue === venueKey &&
    historicalCoverage.metric === capacityMetric &&
    historicalCoverage.horizonHours === horizonHours
      ? historicalCoverage
      : null
  const share = observedInventoryShare(
    amountUsd,
    changeAvailable ? capacity!.before!.usd : null,
    changeAvailable ? capacity!.after!.usd : null,
  )

  return (
    <Card variant="default" p={SPACING.base} mt={SPACING.base} data-testid="flow-impact-card">
      <HStack align="baseline" justify="space-between" flexWrap="wrap" gap={SPACING.sm}>
        <Text
          fontFamily={TYPOGRAPHY.fontDisplay}
          fontSize={TYPOGRAPHY.h4}
          color={SEMANTIC_COLORS.textPrimary}
        >
          Exit pressure
        </Text>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.label}
          color={SEMANTIC_COLORS.textTertiary}
        >
          {venue} · observed route inventory
        </Text>
      </HStack>

      <Grid templateColumns={{ base: '1fr', md: '1fr 1fr' }} gap={SPACING.lg} mt={SPACING.md}>
        <Box>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.label}
            color={SEMANTIC_COLORS.textSecondary}
            textTransform="uppercase"
            letterSpacing="0.28em"
          >
            Observed capacity
          </Text>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.h3}
            color={
              capacity?.status === 'observed_shrinking'
                ? SEMANTIC_COLORS.warning
                : SEMANTIC_COLORS.textPrimary
            }
            mt={SPACING.xs}
          >
            {changeAvailable
              ? `${money(capacity!.before!.usd)} → ${money(capacity!.after!.usd)}`
              : 'Unavailable'}
          </Text>
          {changeAvailable && (
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textSecondary}
              mt={SPACING.xs}
            >
              {time(capacity!.before!.blockTime)} → {time(capacity!.after!.blockTime)}
            </Text>
          )}
          {deltaUsd != null && (
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.small}
              color={SEMANTIC_COLORS.textSecondary}
              mt={SPACING.xs}
            >
              Change · {deltaUsd < 0 ? '↓' : deltaUsd > 0 ? '↑' : '→'} {money(Math.abs(deltaUsd))}
            </Text>
          )}
        </Box>

        <Box>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.label}
            color={SEMANTIC_COLORS.textSecondary}
            textTransform="uppercase"
            letterSpacing="0.28em"
          >
            {amountUsd == null
              ? 'Your exit · observed share'
              : `Your ${money(amountUsd)} exit · observed share`}
          </Text>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.h3}
            color={SEMANTIC_COLORS.textPrimary}
            mt={SPACING.xs}
          >
            {share
              ? `${inventoryShareLabel(share.beforePercent)} → ${inventoryShareLabel(share.afterPercent)}`
              : 'Unavailable'}
          </Text>
          {share && (
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textSecondary}
              mt={SPACING.xs}
            >
              Aggregate route inventory · not a withdrawal quote
            </Text>
          )}
        </Box>
      </Grid>

      <Box
        borderTop="1px solid"
        borderColor={SEMANTIC_COLORS.hairline}
        mt={SPACING.md}
        pt={SPACING.md}
      >
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
          color={SEMANTIC_COLORS.textSecondary}
        >
          Future headroom ·{' '}
          {headroom
            ? `${money(headroom.lowUsd)} to ${money(headroom.highUsd)} (route proxy)`
            : amountUsd == null || horizonHours == null
              ? 'enter size and horizon'
              : 'no validated capacity + competing-flow band'}
          {headroom &&
            ` · competing flow ${money(outlook!.expectedCompetingOutflowUsd.low)} to ${money(outlook!.expectedCompetingOutflowUsd.high)}`}
        </Text>
        {historicalBand && (
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textSecondary}
            mt={SPACING.xs}
          >
            Historical ~24h inventory range after amount · {money(historicalBand.lowUsd)} to{' '}
            {money(historicalBand.highUsd)} · {historicalScenario!.sampleCount} windows
          </Text>
        )}
        {pendingHistoricalWindows && (
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textSecondary}
            mt={SPACING.xs}
          >
            Historical range pending · {pendingHistoricalWindows.sampleCount}/
            {pendingHistoricalWindows.requiredSampleCount} windows
          </Text>
        )}
      </Box>

      {(event || news) && (
        <Box
          borderTop="1px solid"
          borderColor={SEMANTIC_COLORS.borderSubtle}
          mt={SPACING.md}
          pt={SPACING.md}
        >
          {event && (
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.small}
              color={SEMANTIC_COLORS.textPrimary}
            >
              Recorded event · {event.label} · {time(event.at)}
            </Text>
          )}
          {news && (
            <Box mt={event ? SPACING.sm : SPACING.none}>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.label}
                color={SEMANTIC_COLORS.textTertiary}
                textTransform="uppercase"
                letterSpacing="0.28em"
              >
                News · {news.source} · Published {time(news.publishedAt)}
              </Text>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.xs}
                color={SEMANTIC_COLORS.textTertiary}
                mt={SPACING.xs}
              >
                {newsFetchedAtLabel(news.storage)} · {time(news.fetchedAt)}
              </Text>
              <Box
                as="a"
                href={news.url}
                target="_blank"
                rel="noopener noreferrer"
                display="block"
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.small}
                color={SEMANTIC_COLORS.textPrimary}
                transition={TRANSITIONS.colors}
                _hover={{ color: SEMANTIC_COLORS.success, textDecoration: 'underline' }}
                _focus={FOCUS_STYLES.ring}
                mt={SPACING.xs}
              >
                {news.title}
              </Box>
            </Box>
          )}
        </Box>
      )}
    </Card>
  )
}
