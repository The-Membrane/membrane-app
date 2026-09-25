import React from 'react'
import { Box, Grid, HStack, Text } from '@chakra-ui/react'
import NextLink from 'next/link'

import { Card } from '@/components/ui/Card'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { useChainRoute } from '@/hooks/useChainRoute'
import { useCuratorSnapshot } from '@/hooks/useCuratorRegistry'
import {
  aumCapFigure,
  bondFigure,
  bucketFigure,
  formatCdt,
  rampFigure,
  rateFigure,
  shortAddress,
  slashFigure,
  trailingFigure,
  type Figure,
} from '@/lib/curators/curatorLogic'
import type { CuratorVaultRow } from '@/services/chain/curatorRegistry'

import { Eyebrow, FigureText, RegistryStamp, StatusLine } from './atoms'

// Every listed curator vault, read from CuratorRegistry at one block.

const COLUMNS = { base: '1fr 1fr', lg: '120px 1.2fr 1.2fr 1fr 1fr 1.3fr 1.1fr 0.7fr' }

const HEADERS = ['vault', 'bond', 'AUM cap', 'ramp', 'realized rate', 'bucket', 'trailing 30 d', 'slashes'] as const

const Cell: React.FC<{ label: string; figure: Figure }> = ({ label, figure }) => (
  <Box minW={0}>
    <Box display={{ base: 'block', lg: 'none' }}>
      <Eyebrow>{label}</Eyebrow>
    </Box>
    <FigureText figure={figure} size="12px" />
  </Box>
)

const Row: React.FC<{ row: CuratorVaultRow; last: boolean }> = ({ row, last }) => {
  const { chainName } = useChainRoute()
  return (
    <Grid
      templateColumns={COLUMNS}
      gap={SPACING.base}
      px={SPACING.base}
      py={SPACING.md}
      alignItems="baseline"
      borderBottom={last ? 'none' : '1px solid'}
      borderColor={SEMANTIC_COLORS.borderSubtle}
    >
      <Box gridColumn={{ base: '1 / -1', lg: 'auto' }}>
        <NextLink href={`/${chainName}/curators/${row.vault}`} style={{ textDecoration: 'underline' }}>
          <Text
            as="span"
            title={row.vault}
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="12px"
            color={SEMANTIC_COLORS.textPrimary}
            _hover={{ color: SEMANTIC_COLORS.success }}
          >
            {shortAddress(row.vault)}
          </Text>
        </NextLink>
      </Box>
      <Cell label="bond" figure={bondFigure(row.bond)} />
      <Cell label="AUM cap" figure={aumCapFigure(row.aumCap)} />
      <Cell label="ramp" figure={rampFigure(row.ramp)} />
      <Cell label="realized rate" figure={rateFigure(row.realizedRate)} />
      <Cell label="bucket" figure={bucketFigure(row.bucket, row.trailingPayments)} />
      <Cell label="trailing 30 d" figure={trailingFigure(row.trailingPayments)} />
      <Cell label="slashes" figure={slashFigure(row.slashCount)} />
    </Grid>
  )
}

export const CuratorsTable: React.FC = () => {
  const { data, isLoading, dataUpdatedAt } = useCuratorSnapshot()

  return (
    <Box maxW="1140px" mx="auto" px={SPACING.base} py={SPACING.lg} bg={SEMANTIC_COLORS.bgPrimary} color={SEMANTIC_COLORS.textPrimary}>
      <Eyebrow>curator registry</Eyebrow>
      <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize={TYPOGRAPHY.h1} color={SEMANTIC_COLORS.textPrimary} letterSpacing="-0.01em">
        Curators
      </Text>

      {isLoading && <StatusLine>reading chain…</StatusLine>}
      {!isLoading && !data && <StatusLine tone="danger">CuratorRegistry not reachable on this chain.</StatusLine>}

      {data && (
        <>
          <HStack mt={SPACING.sm} spacing={SPACING.md} flexWrap="wrap" align="baseline">
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.textSecondary}>
              {data.rows.length} {data.rows.length === 1 ? 'vault' : 'vaults'} · {formatCdt(data.totalBonded)} bonded
            </Text>
            <RegistryStamp chainId={data.chainId} registry={data.registry} block={data.blockNumber} at={dataUpdatedAt} />
          </HStack>

          {data.rows.length === 0 ? (
            <StatusLine>No vaults listed.</StatusLine>
          ) : (
            <Card variant="default" p={0} mt={SPACING.lg}>
              <Grid
                display={{ base: 'none', lg: 'grid' }}
                templateColumns={COLUMNS}
                gap={SPACING.base}
                px={SPACING.base}
                py={SPACING.sm}
                borderBottom="1px solid"
                borderColor={SEMANTIC_COLORS.borderSubtle}
              >
                {HEADERS.map((h) => (
                  <Eyebrow key={h}>{h}</Eyebrow>
                ))}
              </Grid>
              {data.rows.map((r, i) => (
                <Row key={r.vault} row={r} last={i === data.rows.length - 1} />
              ))}
            </Card>
          )}
        </>
      )}
    </Box>
  )
}

export default CuratorsTable
