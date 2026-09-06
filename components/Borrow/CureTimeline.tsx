import React, { useEffect, useState } from 'react'
import { Box, Text, HStack } from '@chakra-ui/react'

import { Card } from '@/components/ui/Card'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'

/**
 * Illustrative breach → cure → liquidation timeline, ported from
 * public/proto/borrow.html's `.tl` markup and its setInterval loop (lines
 * ~186-194, 326-349). This is reading matter, not decision matter — the
 * cure-fill animation is a mocked demonstration of the 8h window, not a
 * live per-position timer (there is no open position here to time).
 */
export const CureTimeline: React.FC = () => {
  const [t, setT] = useState(0)

  useEffect(() => {
    const id = setInterval(() => {
      setT((prev) => (prev + 0.02) % 1.15)
    }, 80)
    return () => clearInterval(id)
  }, [])

  const k = Math.min(1, t / 1)
  const cureFillPct = k * 60
  const mins = Math.round(k * 480)
  const cureLabel = `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m of 8h`

  return (
    <Box mt={SPACING['2xl']}>
      <HStack spacing={SPACING.md} align="baseline" flexWrap="wrap" mb={SPACING.sm}>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.label}
          letterSpacing="0.28em"
          textTransform="uppercase"
          color={SEMANTIC_COLORS.textSecondary}
        >
          02 /
        </Text>
        <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize={TYPOGRAPHY.h2} color={SEMANTIC_COLORS.textPrimary}>
          Breach, cure window, liquidation
        </Text>
      </HStack>

      <Card variant="default" p={SPACING.lg}>
        <Box position="relative" h="96px" bg={SEMANTIC_COLORS.bgPrimary} border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} overflow="hidden">
          {/* Healthy segment: 0-20% */}
          <Box position="absolute" top={0} bottom={0} left="0%" w="20%" bg="rgba(155,220,79,0.08)" />
          <Text position="absolute" left="2%" top="8px" fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" letterSpacing="0.14em" textTransform="uppercase" color={SEMANTIC_COLORS.success}>
            Healthy
          </Text>
          <Text position="absolute" left="2%" bottom="8px" fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" letterSpacing="0.14em" textTransform="uppercase" color={SEMANTIC_COLORS.textSecondary}>
            LTV under your cap
          </Text>

          {/* Breach tick + amber zone: 20-80% */}
          <Box position="absolute" top={0} bottom={0} left="20%" w="1px" bg={SEMANTIC_COLORS.borderStrong} />
          <Text position="absolute" left="21.5%" top="8px" fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" letterSpacing="0.14em" textTransform="uppercase" color={SEMANTIC_COLORS.warning}>
            Breach · 8h timer starts
          </Text>
          <Box position="absolute" top={0} bottom={0} left="20%" w="60%" bg="rgba(216,178,74,0.10)" />
          <Box position="absolute" top={0} bottom={0} left="20%" w={`${cureFillPct}%`} bg="rgba(216,178,74,0.28)" />
          <Text position="absolute" left="44%" top="44px" fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" color={SEMANTIC_COLORS.warning}>
            {cureLabel}
          </Text>
          {/* Capped at the liquidation tick (80%) so this can never overlap
              the liquidation captions on narrow layouts. */}
          <Text position="absolute" left="21.5%" bottom="8px" maxW="56%" whiteSpace="nowrap" overflow="hidden" fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" letterSpacing="0.14em" textTransform="uppercase" color={SEMANTIC_COLORS.textPrimary}>
            ↑ cure in the window: deposit, repay, or price recovery
          </Text>

          {/* Liquidation tick + zone: 80-100% */}
          <Box position="absolute" top={0} bottom={0} left="80%" w="1px" bg={SEMANTIC_COLORS.borderStrong} />
          <Box position="absolute" top={0} bottom={0} left="80%" w="20%" bg="rgba(207,64,52,0.22)" />
          <Text position="absolute" left="82%" top="8px" fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" letterSpacing="0.14em" textTransform="uppercase" color={SEMANTIC_COLORS.danger}>
            Liquidation
          </Text>
          <Text position="absolute" left="82%" bottom="8px" fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" letterSpacing="0.14em" textTransform="uppercase" color={SEMANTIC_COLORS.textSecondary}>
            timer expired uncured · repays to the cap
          </Text>
        </Box>

        {/* Risk disclosure (rule 5 keeps it): one line, one place. */}
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" color={SEMANTIC_COLORS.textTertiary} mt={SPACING.sm}>
          Jump 4% past the line and liquidation is immediate · liquidation repays to the cap only
        </Text>
      </Card>
    </Box>
  )
}

export default CureTimeline
