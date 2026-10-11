import React from 'react'
import { Box, Grid, Link, Text } from '@chakra-ui/react'
import { useQuery } from '@tanstack/react-query'

import { Card } from '@/components/ui/Card'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

import { SectionHeading, Stamp } from './atoms'

type Change = {
  id: string
  protocol: string
  vault: string
  dimension: string
  direction: 'increase'
  allocationId: string
  proposedCapRaw: string
  capUnit: 'asset-base-units' | '1e18-fraction-of-vault-assets'
  lifecycle: 'queued' | 'executed' | 'canceled'
  sourceUrl: string
  firstObservedAt: string
  earliestExecutableAt: string
  statusTxUrl: string | null
}
type Feed = {
  available: boolean
  observationStatus?: 'recent' | 'paused'
  checkedAt?: string
  coveredThroughBlock?: number
  coveredThroughAt?: string
  items: Change[]
  limitation: string
}

const date = (value: string) =>
  new Date(value).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'

const magnitude = (item: Change) => {
  const raw = BigInt(item.proposedCapRaw)
  if (item.capUnit === 'asset-base-units' && raw === (1n << 128n) - 1n)
    return '2^128−1 asset base units (maximum encoded value)'
  if (item.capUnit === 'asset-base-units')
    return `${raw.toLocaleString('en-US')} asset base units (asset decimals unverified)`
  const scale = 10n ** 16n
  const whole = raw / scale
  const fraction = (raw % scale).toString().padStart(16, '0').replace(/0+$/, '')
  return `${whole}${fraction ? `.${fraction}` : ''}% of vault assets`
}

export const CapacityChanges: React.FC = () => {
  const { data, isError } = useQuery<Feed>({
    queryKey: ['venue_capacity_changes'],
    queryFn: async () => {
      const response = await fetch('/api/venues/capacity-changes', { cache: 'no-store' })
      if (!response.ok) throw new Error(`capacity changes ${response.status}`)
      return response.json()
    },
    staleTime: 60_000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    refetchInterval: 60_000,
  })

  const items = [...(data?.items ?? [])]
    .sort(
      (a, b) =>
        Number(b.lifecycle === 'queued') - Number(a.lifecycle === 'queued') ||
        b.firstObservedAt.localeCompare(a.firstObservedAt),
    )
    .slice(0, 8)

  return (
    <Box>
      <SectionHeading
        index="07 /"
        title="Allocation cap activity"
        note="Morpho Vault V2 · onchain requests and executions"
      />
      <Card p={SPACING.base}>
        {data?.available && (
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.small}
            fontWeight={700}
            color={SEMANTIC_COLORS.textPrimary}
            mb={SPACING.sm}
          >
            {data.observationStatus === 'paused' ? 'Coverage paused' : 'Covered through'} ·{' '}
            {date(data.coveredThroughAt!)} · block {data.coveredThroughBlock}. Last checked{' '}
            {date(data.checkedAt!)}.{' '}
            {data.observationStatus === 'paused'
              ? 'Statuses below are historical and may have changed.'
              : 'Statuses are as of the covered block.'}
          </Text>
        )}
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.small}
          color={SEMANTIC_COLORS.textSecondary}
          mb={SPACING.base}
        >
          These requests can change how much a vault may allocate. They do not tell you how much can
          be withdrawn.
        </Text>
        {isError || (data && !data.available) ? (
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.small}
            color={SEMANTIC_COLORS.textSecondary}
          >
            The verified cap feed is unavailable on this host.
          </Text>
        ) : !data ? (
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.small}
            color={SEMANTIC_COLORS.textSecondary}
          >
            Loading cap requests…
          </Text>
        ) : items.length === 0 ? (
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.small}
            color={SEMANTIC_COLORS.textSecondary}
          >
            {data.observationStatus === 'paused'
              ? 'No cap requests in the covered historical window.'
              : 'No cap requests in the currently covered window.'}
          </Text>
        ) : (
          <Box>
            {items.map((item, index) => (
              <Grid
                key={item.id}
                templateColumns={{ base: '1fr', md: '110px minmax(0, 1fr) 170px' }}
                gap={SPACING.base}
                py={SPACING.md}
                borderBottom={index === items.length - 1 ? 'none' : '1px solid'}
                borderColor={SEMANTIC_COLORS.borderSubtle}
              >
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.xs}
                  color={
                    item.lifecycle === 'executed'
                      ? SEMANTIC_COLORS.success
                      : SEMANTIC_COLORS.textSecondary
                  }
                  textTransform="uppercase"
                >
                  {data.observationStatus === 'paused' && item.lifecycle === 'queued'
                    ? 'queued at covered block'
                    : item.lifecycle}
                </Text>
                <Box>
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.small}
                    color={SEMANTIC_COLORS.textPrimary}
                  >
                    {item.protocol}: {item.dimension} {item.direction}
                  </Text>
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.xs}
                    color={SEMANTIC_COLORS.textPrimary}
                    overflowWrap="anywhere"
                  >
                    Requested cap {magnitude(item)}
                  </Text>
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.xs}
                    color={SEMANTIC_COLORS.textSecondary}
                    overflowWrap="anywhere"
                  >
                    Vault {item.vault} · first seen {date(item.firstObservedAt)}
                  </Text>
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.xs}
                    color={SEMANTIC_COLORS.textSecondary}
                    title={item.allocationId}
                  >
                    Allocation {item.allocationId.slice(0, 10)}…{item.allocationId.slice(-6)}
                  </Text>
                </Box>
                <Box>
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.xs}
                    color={SEMANTIC_COLORS.textSecondary}
                  >
                    Earliest execution {date(item.earliestExecutableAt)}
                  </Text>
                  <Link
                    href={item.sourceUrl}
                    isExternal
                    rel="noopener noreferrer"
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.xs}
                    color={SEMANTIC_COLORS.textPrimary}
                    transition={TRANSITIONS.colors}
                    _hover={{ color: SEMANTIC_COLORS.success }}
                    _focus={FOCUS_STYLES.ring}
                  >
                    request source ↗
                  </Link>
                  {item.statusTxUrl && (
                    <Link
                      href={item.statusTxUrl}
                      isExternal
                      rel="noopener noreferrer"
                      ml={SPACING.sm}
                      fontFamily={TYPOGRAPHY.fontMono}
                      fontSize={TYPOGRAPHY.xs}
                      color={SEMANTIC_COLORS.textPrimary}
                      transition={TRANSITIONS.colors}
                      _hover={{ color: SEMANTIC_COLORS.success }}
                      _focus={FOCUS_STYLES.ring}
                    >
                      {item.lifecycle === 'executed'
                        ? 'execution source ↗'
                        : 'cancellation source ↗'}
                    </Link>
                  )}
                </Box>
              </Grid>
            ))}
          </Box>
        )}
        {data?.available && (
          <Stamp>
            Cap changes are permission changes. Actual allocation and exit capacity require separate
            observations.
          </Stamp>
        )}
      </Card>
    </Box>
  )
}

export default CapacityChanges
