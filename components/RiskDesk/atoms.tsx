import React from 'react'
import { Box, HStack, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { shortAddr } from '@/lib/riskDesk/riskLogic'

/** Mono 10px uppercase eyebrow, 0.24em tracking. */
export const Eyebrow: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Text as="span" fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" letterSpacing="0.24em" textTransform="uppercase" color={SEMANTIC_COLORS.textSecondary}>
    {children}
  </Text>
)

/** "local chain · Collateral 0x2279…ebe6 · block 133" */
export const Provenance: React.FC<{ contract: string; address: string; block: bigint; extra?: string }> = ({ contract, address, block, extra }) => (
  <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9px" letterSpacing="0.12em" color={SEMANTIC_COLORS.textTertiary} mt={SPACING.sm} lineHeight={1.7}>
    local chain · {contract} {shortAddr(address)} · block {block.toString()}
    {extra ? ` · ${extra}` : ''}
  </Text>
)

/** Label over a mono number. Zeros render like any other value. */
export const Fact: React.FC<{ label: string; value: string; sub?: string; tone?: string }> = ({ label, value, sub, tone }) => (
  <Box minW="120px">
    <Eyebrow>{label}</Eyebrow>
    <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="20px" color={tone ?? SEMANTIC_COLORS.textPrimary} mt={1}>
      {value}
    </Text>
    {sub && (
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11px" color={SEMANTIC_COLORS.textTertiary}>
        {sub}
      </Text>
    )}
  </Box>
)

/** Hairline-bordered, square-cornered panel. */
export const Panel: React.FC<{ children: React.ReactNode; mt?: number | string }> = ({ children, mt }) => (
  <Box border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} borderRadius={0} bg={SEMANTIC_COLORS.bgSecondary} p={SPACING.base} mt={mt}>
    {children}
  </Box>
)

export const PanelHead: React.FC<{ eyebrow: string; title: string; right?: React.ReactNode }> = ({ eyebrow, title, right }) => (
  <HStack justify="space-between" align="baseline" flexWrap="wrap" gap={SPACING.sm} mb={SPACING.md}>
    <Box>
      <Eyebrow>{eyebrow}</Eyebrow>
      <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize={TYPOGRAPHY.h3} color={SEMANTIC_COLORS.textPrimary}>
        {title}
      </Text>
    </Box>
    {right}
  </HStack>
)
