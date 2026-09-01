import { Box, VStack, HStack, Button, Text } from '@chakra-ui/react'
import BidAction from './BidAction'
import Risk from './Risk'
import React, { useState } from "react"
import LiquidateButton from '../Nav/LiquidateButton'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

// Hexagon background matching the brand's cyberpunk aesthetic
const HexagonBackground = () => (
  <Box
    position="fixed"
    inset={0}
    opacity={0.4}
    zIndex={0}
    pointerEvents="none"
  >
    <Box as="svg" w="100%" h="100%">
      <defs>
        <pattern id="hexagonPatternLiq" x="0" y="0" width="103.92" height="60" patternUnits="userSpaceOnUse">
          <polygon
            points="34.64,10 51.96,20 51.96,40 34.64,50 17.32,40 17.32,20"
            fill="none"
            stroke="#9bdc4f"
            strokeWidth="1"
          />
          <polygon
            points="86.6,40 103.92,50 103.92,70 86.6,80 69.28,70 69.28,50"
            fill="none"
            stroke="#9bdc4f"
            strokeWidth="1"
          />
          <polygon
            points="86.6,-20 103.92,-10 103.92,10 86.6,20 69.28,10 69.28,-10"
            fill="none"
            stroke="#9bdc4f"
            strokeWidth="1"
          />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#hexagonPatternLiq)" />
    </Box>
  </Box>
)

export const CheckLiquidations = () => {
  const [enabled, setEnabled] = useState(false)
  return (
    <Box>
      {!enabled ? (
        <Button
          onClick={() => setEnabled(true)}
          size="sm"
          transition={TRANSITIONS.transformAndShadow}
          _hover={HOVER_EFFECTS.lift}
          _active={ACTIVE_EFFECTS.press}
          _focus={FOCUS_STYLES.ring}
        >
          Check for Liquidations
        </Button>
      ) : (
        <LiquidateButton enabled={enabled} setEnabled={setEnabled} />
      )}
    </Box>
  )
}

const Bid = React.memo(function Bid() {
  return (
    <Box w="full" position="relative" minH="100vh">
      <HexagonBackground />
      <Box
        w="full"
        px={{ base: SPACING.sm, md: SPACING.xl }}
        py={{ base: SPACING.base, md: SPACING.xl }}
        position="relative"
        zIndex={1}
      >
        <VStack align="stretch" spacing={SPACING.xl} w="full" maxW="1200px" mx="auto">
          {/* Header: Neon title + Check Liquidations button */}
          <HStack w="full" justifyContent="space-between" alignItems="flex-start">
            <VStack align="flex-start" spacing={SPACING.sm}>
              <Text
                as="h1"
                fontSize={TYPOGRAPHY.h1}
                fontWeight={TYPOGRAPHY.bold}
                color={SEMANTIC_COLORS.textPrimary}
                fontFamily={TYPOGRAPHY.fontDisplay}
              >
                Liquidations
              </Text>
              <Text
                fontSize={TYPOGRAPHY.body}
                color={SEMANTIC_COLORS.textSecondary}
                fontFamily={TYPOGRAPHY.fontMono}
                maxW="420px"
              >
                Bid for liquidated collateral at a premium
              </Text>
            </VStack>
            <CheckLiquidations />
          </HStack>

          {/* Main content */}
          <VStack gap={SPACING.xl} w={{ base: '100%', md: '80%' }} mx="auto" align="stretch">
            <Risk />
            <BidAction />
          </VStack>
        </VStack>
      </Box>
    </Box>
  )
})

export default Bid
