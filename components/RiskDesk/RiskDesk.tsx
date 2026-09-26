import React from 'react'
import { Box, HStack, Text } from '@chakra-ui/react'
import { useQuery } from '@tanstack/react-query'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { LOCAL_RPC_URL, loadRiskDesk, type RiskDeskSnapshot } from '@/lib/riskDesk/loadRiskDesk'
import { fmtWadPct, glideRuleSentence } from '@/lib/riskDesk/riskLogic'

import { Eyebrow, Provenance } from './atoms'
import { LtvPanel } from './LtvPanel'
import { WaterfallPanel } from './WaterfallPanel'

// Risk desk — per asset: how its max LTV is changing and who absorbs bad debt.
// Every number is a read against the local anvil deploy, pinned to one block.

export const RiskDesk: React.FC = () => {
  const q = useQuery<RiskDeskSnapshot>({
    queryKey: ['risk-desk', LOCAL_RPC_URL],
    queryFn: () => loadRiskDesk(),
    refetchInterval: 15_000,
    retry: 1,
  })
  const s = q.data

  return (
    <Box maxW="1140px" mx="auto" px={SPACING.base} py={SPACING.lg} bg={SEMANTIC_COLORS.bgPrimary} color={SEMANTIC_COLORS.textPrimary}>
      <HStack spacing={SPACING.sm}>
        <Eyebrow>Risk desk</Eyebrow>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="9px"
          letterSpacing="0.24em"
          textTransform="uppercase"
          color={SEMANTIC_COLORS.warning}
          border="1px solid"
          borderColor={SEMANTIC_COLORS.warning}
          px={1}
        >
          local chain
        </Text>
      </HStack>
      <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize={TYPOGRAPHY.h1} letterSpacing="-0.01em" mt={1}>
        Collateral terms, and who pays for bad debt
      </Text>
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.textSecondary} mt={SPACING.sm} maxW="680px">
        {glideRuleSentence()}
      </Text>

      {q.isLoading && (
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.textTertiary} mt={SPACING.lg}>
          Reading {LOCAL_RPC_URL}…
        </Text>
      )}
      {q.isError && (
        <Box mt={SPACING.lg} border="1px solid" borderColor={SEMANTIC_COLORS.danger} p={SPACING.base}>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.danger}>
            No local chain at {LOCAL_RPC_URL}.
          </Text>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11px" color={SEMANTIC_COLORS.textTertiary} mt={1}>
            {(q.error as Error)?.message?.split('\n')[0]}
          </Text>
        </Box>
      )}

      {s && (
        <>
          <Provenance contract="Collateral" address={s.addresses.collateral} block={s.block} extra={`${s.assets.length} ${s.assets.length === 1 ? 'asset' : 'assets'}`} />
          {s.assets.length === 0 && (
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.textTertiary} mt={SPACING.lg}>
              0 assets listed
            </Text>
          )}
          {s.assets.map((a) => (
            <Box key={a.denom} as="section" mt={SPACING.xl} id={a.symbol.toLowerCase()}>
              <HStack align="baseline" spacing={SPACING.md} flexWrap="wrap" borderBottom="1px solid" borderColor={SEMANTIC_COLORS.borderMedium} pb={SPACING.sm} mb={SPACING.md}>
                <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize={TYPOGRAPHY.h2}>
                  {a.symbol}
                </Text>
                <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.textSecondary}>
                  max LTV {fmtWadPct(a.current)} · cap {fmtWadPct(a.cap)}
                </Text>
                <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" color={SEMANTIC_COLORS.textTertiary}>
                  {a.denom.slice(0, 18)}…
                </Text>
              </HStack>
              <LtvPanel a={a} s={s} />
              <WaterfallPanel a={a} s={s} />
            </Box>
          ))}
        </>
      )}
    </Box>
  )
}

export default RiskDesk
