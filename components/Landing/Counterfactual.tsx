import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'

import { Eyebrow, Num } from './atoms'
import { LandingCalc, LandingState } from './types'
import { btcs, counterfactual, usd, usdc } from './utils'

interface Props {
  st: LandingState
  c: LandingCalc
}

const Row: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <Box display="flex" justifyContent="space-between" gap={SPACING.md} fontSize="11.5px">
    <Text fontFamily={TYPOGRAPHY.fontMono} color={SEMANTIC_COLORS.textSecondary}>
      {label}
    </Text>
    <Text fontFamily={TYPOGRAPHY.fontMono} color={SEMANTIC_COLORS.textPrimary} sx={{ fontVariantNumeric: 'tabular-nums' }}>
      {value}
    </Text>
  </Box>
)

export const Counterfactual: React.FC<Props> = ({ st, c }) => {
  const { btcSold, kept } = counterfactual(st, c)

  return (
    <Box as="section" display="grid" gap={SPACING.lg}>
      <Box display="grid" gap={SPACING.md}>
        <Eyebrow>What the other choice cost</Eyebrow>
        <Text as="h2" fontFamily={TYPOGRAPHY.fontDisplay} fontWeight={TYPOGRAPHY.normal} fontSize={{ base: '21px', md: '30px' }} lineHeight="1.15" color={SEMANTIC_COLORS.textPrimary} sx={{ textWrap: 'balance' }}>
          You needed <Num>{usd(c.debt)}</Num>. Selling would have taken <Num>{btcSold.toFixed(2)} BTC</Num>.
        </Text>
      </Box>

      <Box display="grid" gridTemplateColumns={{ base: '1fr', md: '1fr 1fr' }} gap="1px" bg={SEMANTIC_COLORS.borderSubtle} border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}>
        {/* you borrowed */}
        <Box bg={SEMANTIC_COLORS.bgSecondary} p={SPACING.lg} display="grid" gap={SPACING.md} alignContent="start" borderTop="2px solid" borderColor={SEMANTIC_COLORS.success}>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" letterSpacing="0.24em" textTransform="uppercase" color={SEMANTIC_COLORS.success}>
            You borrowed
          </Text>
          <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize={{ base: '22px', md: '30px' }} lineHeight="1.1" color={SEMANTIC_COLORS.textPrimary}>
            <Num>{btcs(st.btc)}</Num>{' '}
            <Text as="span" color={SEMANTIC_COLORS.textTertiary}>
              still held
            </Text>
          </Text>
          <Box display="grid" gap={SPACING.xs} mt={SPACING.xs}>
            <Row label="Cash in hand" value={usd(c.debt)} />
            <Row label="Bitcoin sold" value="0.00 BTC" />
            <Row label="Position earns" value={`${usdc(c.net)}/yr`} />
          </Box>
        </Box>

        {/* you sold */}
        <Box bg={SEMANTIC_COLORS.bgSecondary} p={SPACING.lg} display="grid" gap={SPACING.md} alignContent="start" borderTop="2px solid" borderColor={SEMANTIC_COLORS.textTertiary}>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" letterSpacing="0.24em" textTransform="uppercase" color={SEMANTIC_COLORS.textSecondary}>
            You sold instead
          </Text>
          <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize={{ base: '22px', md: '30px' }} lineHeight="1.1" color={SEMANTIC_COLORS.textPrimary}>
            <Num>{btcs(kept)}</Num>{' '}
            <Text as="span" color={SEMANTIC_COLORS.textTertiary}>
              left
            </Text>
          </Text>
          <Box display="grid" gap={SPACING.xs} mt={SPACING.xs}>
            <Row label="Cash in hand" value={usd(c.debt)} />
            <Row label="Bitcoin sold" value={`${btcSold.toFixed(2)} BTC`} />
            <Row label="Position earns" value="$0/yr" />
          </Box>
        </Box>
      </Box>

      <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize={{ base: '17px', md: '23px' }} lineHeight="1.3" color={SEMANTIC_COLORS.textPrimary}>
        Same cash either way. One of them{' '}
        <Text as="b" fontWeight={TYPOGRAPHY.normal} color={SEMANTIC_COLORS.success}>
          keeps <Num color={SEMANTIC_COLORS.success}>{btcSold.toFixed(2)} BTC</Num>
        </Text>{' '}
        and pays you to wait.
      </Text>
    </Box>
  )
}

export default Counterfactual
