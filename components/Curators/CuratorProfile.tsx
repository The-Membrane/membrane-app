import React from 'react'
import { Box, Grid, HStack, SimpleGrid, Text } from '@chakra-ui/react'
import NextLink from 'next/link'

import { Card } from '@/components/ui/Card'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { useChainRoute } from '@/hooks/useChainRoute'
import { useCuratorProfile } from '@/hooks/useCuratorRegistry'
import {
  aumCapFigure,
  aumFigure,
  bondFigure,
  bucketFigure,
  formatBlockTime,
  formatCdt,
  isAddress,
  rampFigure,
  rateFigure,
  slashFigure,
  trailingFigure,
  type Figure,
  type HistoryTone,
} from '@/lib/curators/curatorLogic'

import { Eyebrow, Fact, RegistryStamp, StatusLine } from './atoms'

// One curator vault: its CuratorRegistry figures and its event history, newest first.

const TONE_COLOR: Record<HistoryTone, string> = {
  neutral: SEMANTIC_COLORS.textSecondary,
  credit: SEMANTIC_COLORS.success,
  debit: SEMANTIC_COLORS.warning,
  slash: SEMANTIC_COLORS.danger,
}

const unbondFigure = (p: { active: boolean; newCap: bigint; readyTime: bigint }): Figure =>
  p.active
    ? { text: `cap to ${formatCdt(p.newCap, 0)} · ready ${formatBlockTime(p.readyTime)}`, empty: false }
    : { text: 'no unbond pending', empty: true }

export const CuratorProfile: React.FC<{ vault: string }> = ({ vault }) => {
  const { chainName } = useChainRoute()
  const valid = isAddress(vault)
  const { data, status, error, dataUpdatedAt } = useCuratorProfile(valid ? vault : undefined)

  return (
    <Box maxW="1140px" mx="auto" px={SPACING.base} py={SPACING.lg} bg={SEMANTIC_COLORS.bgPrimary} color={SEMANTIC_COLORS.textPrimary}>
      <NextLink href={`/${chainName}/curators`}>
        <Text as="span" fontFamily={TYPOGRAPHY.fontMono} fontSize="11px" color={SEMANTIC_COLORS.textTertiary} _hover={{ color: SEMANTIC_COLORS.success }}>
          ← all curators
        </Text>
      </NextLink>
      <Box mt={SPACING.md}>
        <Eyebrow>curator vault</Eyebrow>
      </Box>
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={{ base: '14px', md: '20px' }} color={SEMANTIC_COLORS.textPrimary} wordBreak="break-all">
        {vault}
      </Text>

      {!valid && <StatusLine tone="danger">Not an address.</StatusLine>}
      {valid && status === 'pending' && <StatusLine>reading chain…</StatusLine>}
      {valid && status === 'error' && <StatusLine tone="danger">{`CuratorRegistry read failed: ${(error as Error)?.message?.split('\n')[0] ?? 'unknown error'}`}</StatusLine>}
      {valid && status === 'success' && !data && <StatusLine tone="danger">CuratorRegistry not reachable on this chain.</StatusLine>}

      {data && (
        <>
          <HStack mt={SPACING.sm} spacing={SPACING.md} flexWrap="wrap">
            <RegistryStamp chainId={data.chainId} registry={data.registry} block={data.blockNumber} at={dataUpdatedAt} />
          </HStack>
          {!data.listed && <StatusLine>Not listed in CuratorRegistry.</StatusLine>}

          <SimpleGrid columns={{ base: 1, sm: 2, md: 4 }} spacing={SPACING.base} mt={SPACING.lg}>
            <Fact label="bond" figure={bondFigure(data.row.bond)} />
            <Fact label="AUM cap" figure={aumCapFigure(data.row.aumCap)} />
            <Fact label="tracked AUM" figure={aumFigure(data.row.trackedAum)} />
            <Fact label="ramp" figure={rampFigure(data.row.ramp)} />
            <Fact label="realized rate" figure={rateFigure(data.row.realizedRate)} />
            <Fact label="bucket" figure={bucketFigure(data.row.bucket, data.row.trailingPayments)} />
            <Fact label="trailing 30 d" figure={trailingFigure(data.row.trailingPayments)} />
            <Fact label="slashes" figure={slashFigure(data.row.slashCount)} />
            <Fact label="unbond" figure={unbondFigure(data.row.pendingUnbond)} />
          </SimpleGrid>

          <Box mt={SPACING.xl}>
            <Eyebrow>history · {data.history.length} {data.history.length === 1 ? 'event' : 'events'}</Eyebrow>
          </Box>
          {data.history.length === 0 ? (
            <StatusLine>No registry events for this vault.</StatusLine>
          ) : (
            <Card variant="default" p={0} mt={SPACING.sm}>
              {data.history.map((h, i) => (
                <Grid
                  key={h.key}
                  templateColumns={{ base: '1fr', md: '170px 150px 1fr 90px' }}
                  gap={SPACING.base}
                  px={SPACING.base}
                  py={SPACING.md}
                  alignItems="baseline"
                  borderBottom={i === data.history.length - 1 ? 'none' : '1px solid'}
                  borderColor={SEMANTIC_COLORS.borderSubtle}
                >
                  <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11px" color={SEMANTIC_COLORS.textTertiary}>
                    {h.timestamp === null ? 'time not read' : formatBlockTime(h.timestamp)}
                  </Text>
                  <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11px" letterSpacing="0.24em" textTransform="uppercase" color={TONE_COLOR[h.tone]}>
                    {h.title}
                  </Text>
                  <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.textPrimary} wordBreak="break-word">
                    {h.detail}
                  </Text>
                  <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11px" color={SEMANTIC_COLORS.textTertiary} textAlign={{ base: 'left', md: 'right' }} title={h.txHash}>
                    block {h.blockNumber.toString()}
                  </Text>
                </Grid>
              ))}
            </Card>
          )}
        </>
      )}
    </Box>
  )
}

export default CuratorProfile
