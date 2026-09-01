import React, { useState } from 'react'
import {
  Box,
  VStack,
  HStack,
  Stack,
  Text,
  Divider,
  Badge,
  Image,
  Icon,
  Skeleton,
  Collapse,
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverArrow,
  PopoverBody,
} from '@chakra-ui/react'
import { InfoIcon, ChevronDownIcon, ChevronUpIcon } from '@chakra-ui/icons'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { Card } from '@/components/ui/Card'
import { usePositionOverview } from './hooks/usePositionOverview'

interface PositionOverviewProps {
  positionIndex: number
}

const getHealthColor = (tier: 'green' | 'amber' | 'red') => {
  switch (tier) {
    case 'green': return SEMANTIC_COLORS.success
    case 'amber': return SEMANTIC_COLORS.warning
    case 'red': return SEMANTIC_COLORS.danger
  }
}

const getVolColor = (vol: number) => {
  if (vol < 0.20) return SEMANTIC_COLORS.success
  if (vol < 0.40) return SEMANTIC_COLORS.warning
  if (vol < 0.60) return '#fb923c' // orange
  return SEMANTIC_COLORS.danger
}

const getVolBadgeBg = (classification: string) => {
  switch (classification) {
    case 'Low': return 'rgba(34, 211, 238, 0.15)'
    case 'Medium': return 'rgba(251, 191, 36, 0.15)'
    case 'High': return 'rgba(251, 146, 60, 0.15)'
    case 'Extreme': return 'rgba(239, 68, 68, 0.15)'
    default: return 'rgba(255, 255, 255, 0.1)'
  }
}

const getVolBadgeColor = (classification: string) => {
  switch (classification) {
    case 'Low': return SEMANTIC_COLORS.success
    case 'Medium': return SEMANTIC_COLORS.warning
    case 'High': return '#fb923c'
    case 'Extreme': return SEMANTIC_COLORS.danger
    default: return 'white'
  }
}

const MetricItem = ({
  label,
  value,
  color,
  arrow,
}: {
  label: string
  value: string
  color?: string
  arrow?: 'up' | 'down' | 'flat'
}) => (
  <VStack spacing={SPACING.xs} align="center" flex={1}>
    <Text
      fontSize={TYPOGRAPHY.label}
      textTransform="uppercase"
      color={SEMANTIC_COLORS.textTertiary}
      letterSpacing="0.05em"
    >
      {label}
    </Text>
    <HStack spacing={SPACING.xs}>
      {arrow && arrow !== 'flat' && (
        <Text fontSize={TYPOGRAPHY.small} color={color}>
          {arrow === 'up' ? '↑' : '↓'}
        </Text>
      )}
      <Text
        fontSize={TYPOGRAPHY.h4}
        fontWeight={TYPOGRAPHY.medium}
        color={color || 'white'}
      >
        {value}
      </Text>
    </HStack>
  </VStack>
)

const SectionLabel = ({ label, tooltip }: { label: string; tooltip: string }) => (
  <HStack spacing={SPACING.xs}>
    <Text
      fontSize={TYPOGRAPHY.label}
      textTransform="uppercase"
      color={SEMANTIC_COLORS.textTertiary}
      letterSpacing="0.05em"
    >
      {label}
    </Text>
    <Popover trigger="hover" placement="top">
      <PopoverTrigger>
        <Box as="span" display="inline-flex">
          <Icon
            as={InfoIcon}
            color="whiteAlpha.400"
            boxSize={3}
            cursor="pointer"
            _hover={{ color: 'whiteAlpha.700' }}
          />
        </Box>
      </PopoverTrigger>
      <PopoverContent bg="rgba(10, 10, 10, 0.95)" borderColor="whiteAlpha.200" maxW="260px">
        <PopoverArrow bg="rgba(10, 10, 10, 0.95)" />
        <PopoverBody fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary} py={SPACING.sm} px={SPACING.md}>
          {tooltip}
        </PopoverBody>
      </PopoverContent>
    </Popover>
  </HStack>
)

const formatDollar = (value: number): string => {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`
  return `$${value.toFixed(0)}`
}

const formatCDT = (value: number): string => {
  if (value >= 1_000) return `~${(value / 1_000).toFixed(1)}K CDT`
  if (value >= 100) return `~${value.toFixed(0)} CDT`
  if (value >= 1) return `~${value.toFixed(1)} CDT`
  return `~${value.toFixed(2)} CDT`
}

const VolatilitySection = ({ volatility }: {
  volatility: { composite: number; classification: string; btcVol: number; perAsset: { denom: string; symbol: string; logo: string; weight: number; annualizedVol: number }[] }
}) => {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <VStack spacing={SPACING_PATTERNS.stackSpacing} align="stretch">
      {/* Summary row - always visible */}
      <HStack
        justify="space-between"
        align="center"
        cursor="pointer"
        onClick={() => setIsOpen(!isOpen)}
        _hover={{ opacity: 0.8 }}
        role="button"
        aria-expanded={isOpen}
        aria-label="Toggle volatility details"
      >
        <HStack spacing={SPACING.md} align="center">
          <SectionLabel
            label="Collateral Volatility"
            tooltip="30-day realized volatility ranked against BTC as a baseline. Low = below BTC, Medium = 1–1.5× BTC, High = 1.5–2× BTC, Extreme = above 2× BTC."
          />
          <Badge
            bg={getVolBadgeBg(volatility.classification)}
            color={getVolBadgeColor(volatility.classification)}
            px={SPACING.sm}
            py={1}
            borderRadius="full"
            fontSize={TYPOGRAPHY.xs}
            fontWeight={TYPOGRAPHY.medium}
            textTransform="none"
          >
            {volatility.classification}
          </Badge>
        </HStack>
        <HStack spacing={SPACING.sm}>
          <Text fontSize={TYPOGRAPHY.h4} fontWeight={TYPOGRAPHY.medium} color="white">
            {(volatility.composite * 100).toFixed(1)}%
          </Text>
          <Icon
            as={isOpen ? ChevronUpIcon : ChevronDownIcon}
            color="whiteAlpha.600"
            boxSize={5}
            _hover={{ color: 'whiteAlpha.800' }}
          />
        </HStack>
      </HStack>

      {/* Expanded details */}
      <Collapse in={isOpen} animateOpacity>
        <VStack spacing={SPACING_PATTERNS.stackSpacing} align="stretch" pt={SPACING.xs}>
          {volatility.btcVol > 0 && (
            <Text fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textTertiary}>
              BTC baseline: {(volatility.btcVol * 100).toFixed(1)}% · Composite: {(volatility.composite * 100).toFixed(1)}% annualized
            </Text>
          )}

          {volatility.perAsset.length > 0 && (
            <VStack spacing={SPACING_PATTERNS.listItemGap} align="stretch">
              {volatility.perAsset.map((asset) => (
                <HStack key={asset.denom} justify="space-between">
                  <HStack spacing={SPACING.sm}>
                    <Image
                      src={asset.logo}
                      w="18px"
                      h="18px"
                      borderRadius="full"
                      alt={asset.symbol}
                    />
                    <Text fontSize={TYPOGRAPHY.small} color="white">
                      {asset.symbol}
                    </Text>
                    <Text fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textTertiary}>
                      {(asset.weight * 100).toFixed(0)}%
                    </Text>
                  </HStack>
                  <Text fontSize={TYPOGRAPHY.small} color={getVolColor(asset.annualizedVol)}>
                    {(asset.annualizedVol * 100).toFixed(1)}%
                  </Text>
                </HStack>
              ))}
            </VStack>
          )}

          <Text fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textTertiary}>
            Higher volatility = liquidation threshold may be reached faster than buffer % suggests
          </Text>
        </VStack>
      </Collapse>
    </VStack>
  )
}

export const PositionOverview: React.FC<PositionOverviewProps> = ({ positionIndex }) => {
  const { health, borrowCost, volatility, isLoading, hasPosition, hasDebt } = usePositionOverview({ positionIndex })

  if (!hasPosition) return null

  if (isLoading) {
    return (
      <Card>
        <Text fontSize="lg" fontWeight="bold" color="white" mb={SPACING.base}>
          Position Overview
        </Text>
        <VStack spacing={SPACING_PATTERNS.stackSpacing} align="stretch">
          <Skeleton height="60px" borderRadius="md" />
          <Skeleton height="60px" borderRadius="md" />
          <Skeleton height="60px" borderRadius="md" />
        </VStack>
      </Card>
    )
  }

  const tierColor = getHealthColor(health.healthTier)

  return (
    <Card>
      <Text fontSize="lg" fontWeight="bold" color="white" mb={SPACING.base}>
        Position Overview
      </Text>

      {/* Section 1: Health Summary */}
      <VStack spacing={SPACING_PATTERNS.stackSpacing} align="stretch">
        <SectionLabel
          label="Position Health"
          tooltip="How far your collateral value sits above the liquidation threshold. Cyan means safe (>30%), yellow means caution (10–30%), red means at risk (<10%)."
        />
        <Stack direction={{ base: 'column', sm: 'row' }} justify="space-between" spacing={SPACING.base}>
          {hasDebt ? (
            <>
              <MetricItem
                label="Collateral Buffer"
                value={`${health.collateralBufferPct.toFixed(1)}%`}
                color={tierColor}
                arrow={health.bufferTrend}
              />
              <MetricItem
                label="Dollar Buffer"
                value={`${formatDollar(health.dollarBuffer)} above liq.`}
                color={tierColor}
              />
              <MetricItem
                label="Worst-Case Drop"
                value={`Liquidates at −${health.worstCaseDrop.toFixed(1)}%`}
                color={tierColor}
              />
            </>
          ) : (
            <Box py={SPACING.sm}>
              <Text fontSize={TYPOGRAPHY.body} color={SEMANTIC_COLORS.success}>
                No liquidation risk — no outstanding debt
              </Text>
            </Box>
          )}
        </Stack>
      </VStack>

      <Divider borderColor="whiteAlpha.100" my={SPACING.base} />

      {/* Section 2: Borrow Cost */}
      <VStack spacing={SPACING_PATTERNS.stackSpacing} align="stretch">
        <SectionLabel
          label="Borrow Cost"
          tooltip="Your current variable interest rate and what it costs to hold your debt position, calculated from the live on-chain rate."
        />
        <Stack direction={{ base: 'column', sm: 'row' }} justify="space-between" spacing={SPACING.base}>
          <MetricItem
            label="Current Rate"
            value={`${borrowCost.currentRate.toFixed(1)}% APR`}
          />
          <MetricItem
            label="Daily Cost"
            value={hasDebt ? `${formatCDT(borrowCost.dailyCost)} / day` : '—'}
          />
          <MetricItem
            label="Monthly Cost"
            value={hasDebt ? `${formatCDT(borrowCost.monthlyCost)} / mo` : '—'}
          />
        </Stack>
        <Text fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textTertiary}>
          Rate sourced from Disco signal · updates on-chain
        </Text>
      </VStack>

      <Divider borderColor="whiteAlpha.100" my={SPACING.base} />

      {/* Section 3: Collateral Volatility (collapsible) */}
      <VolatilitySection volatility={volatility} />
    </Card>
  )
}

export default PositionOverview
