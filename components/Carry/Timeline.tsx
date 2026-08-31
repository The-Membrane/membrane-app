import React, { useEffect, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'

import { Card } from '@/components/ui/Card'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'

import { SectionHeading } from './atoms'
import { cureLabel } from './utils'

const Label: React.FC<{
  left: string
  top?: string
  bottom?: string
  color: string
  mono?: boolean
  children: React.ReactNode
}> = ({ left, top, bottom, color, mono, children }) => (
  <Text
    position="absolute"
    left={left}
    top={top}
    bottom={bottom}
    fontFamily={mono ? TYPOGRAPHY.fontMono : TYPOGRAPHY.fontMono}
    fontSize="9px"
    letterSpacing="0.14em"
    textTransform="uppercase"
    color={color}
    whiteSpace="nowrap"
  >
    {children}
  </Text>
)

/**
 * Breach → cure window → liquidation, in order. The window is a corridor with
 * one exit up (cure, any time inside it) and one terminal at the end. Ported
 * from paintTimeline() in public/proto/carry.html; the setInterval becomes a
 * useEffect ticker.
 */
export const Timeline: React.FC = () => {
  const [t, setT] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setT((prev) => (prev + 0.02) % 1.15), 80)
    return () => clearInterval(id)
  }, [])

  const k = Math.min(1, t / 1)

  return (
    <Box>
      <SectionHeading index="04 /" title="Breach, cure window, liquidation" note="the mechanism, in order" />
      <Card p={SPACING.base}>
        <Box position="relative" h="96px" bg={SEMANTIC_COLORS.bgPrimary} border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} mt={SPACING.md} overflow="hidden">
          {/* Healthy band */}
          <Box position="absolute" top={0} bottom={0} left={0} w="20%" bg={SEMANTIC_COLORS.success} opacity={0.08} />
          <Label left="2%" top="8px" color={SEMANTIC_COLORS.success}>
            HEALTHY
          </Label>
          <Label left="2%" bottom="8px" color={SEMANTIC_COLORS.textPrimary} mono>
            LTV under your cap
          </Label>

          {/* Breach tick + timer band */}
          <Box position="absolute" top={0} bottom={0} left="20%" w="1px" bg={SEMANTIC_COLORS.borderStrong} />
          <Label left="21.5%" top="8px" color={SEMANTIC_COLORS.warning}>
            BREACH · 8H TIMER STARTS
          </Label>
          <Box position="absolute" top={0} bottom={0} left="20%" w="60%" bg={SEMANTIC_COLORS.warning} opacity={0.1} />
          <Box position="absolute" top={0} bottom={0} left="20%" w={`${k * 60}%`} bg={SEMANTIC_COLORS.warning} opacity={0.28} />
          <Label left="44%" top="44px" color={SEMANTIC_COLORS.warning} mono>
            {cureLabel(k)}
          </Label>
          <Label left="34%" bottom="8px" color={SEMANTIC_COLORS.textPrimary}>
            ↑ cure anytime in the window: deposit, repay, or price recovery → back to healthy
          </Label>

          {/* Liquidation terminal */}
          <Box position="absolute" top={0} bottom={0} left="80%" w="1px" bg={SEMANTIC_COLORS.borderStrong} />
          <Box position="absolute" top={0} bottom={0} left="80%" w="20%" bg={SEMANTIC_COLORS.danger} opacity={0.22} />
          <Label left="82%" top="8px" color={SEMANTIC_COLORS.danger}>
            LIQUIDATION
          </Label>
          <Label left="82%" bottom="8px" color={SEMANTIC_COLORS.textPrimary} mono>
            timer expired uncured · repays to the cap
          </Label>
        </Box>

        <Flex justify="space-between" gap={SPACING.base} flexWrap="wrap" mt={SPACING.sm}>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9.5px" color={SEMANTIC_COLORS.textTertiary}>
            Two ways in: cross the cap and the timer starts; jump 4% past it and liquidation is immediate, no window.
          </Text>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9.5px" color={SEMANTIC_COLORS.textTertiary}>
            Liquidation repays to the cap — not the whole loan.
          </Text>
        </Flex>
      </Card>
    </Box>
  )
}

export default Timeline
