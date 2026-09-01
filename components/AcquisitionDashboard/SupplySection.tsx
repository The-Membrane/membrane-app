import React from 'react'
import { Box, VStack, Text, HStack } from '@chakra-ui/react'
import { SPACING } from '@/config/spacing'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { ASSET_COLORS } from '@/config/chartTheme'
import { Card } from '@/components/ui/Card'
import { PRIMARY_PURPLE } from './constants'
import { ChartInfo } from './ChartInfo'
import { SupplyHistoryChart } from './charts'

/* ── MBRN Supply Over Time (top-line chart) ── */
export const SupplySection: React.FC<{ data: any[] }> = ({ data }) => (
  <VStack spacing={SPACING.md} align="stretch">
    <Text
      fontSize="sm"
      fontWeight="bold"
      color={PRIMARY_PURPLE}
      fontFamily="mono"
      letterSpacing="1px"
      textTransform="uppercase"
    >
      MBRN Supply
    </Text>
    <Card variant="subtle" p={4} borderRadius={0}>
      <Box mb={2}>
        <Text
          fontSize="2xl"
          fontWeight="bold"
          color={SEMANTIC_COLORS.textPrimary}
          fontFamily="heading"
          letterSpacing="2px"
          textTransform="uppercase"
        >
          Supply History
        </Text>
        <HStack spacing={2}>
          <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} fontFamily="mono" letterSpacing="1px">
            Current Supply & Burned Supply Over Time
          </Text>
          <ChartInfo tip="Total MBRN minted (current supply) and total MBRN permanently removed from circulation (burned) via protocol fees. Tracked daily by the proxy contract." />
        </HStack>
      </Box>
      <SupplyHistoryChart data={data} />
      {/* Legend */}
      <HStack justify="center" mt={2} spacing={6}>
        <HStack spacing={2}>
          <Box w="12px" h="3px" bg={ASSET_COLORS[1]} borderRadius={0} />
          <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} fontFamily="mono">Current Supply</Text>
        </HStack>
        <HStack spacing={2}>
          <Box w="12px" h="3px" bg={ASSET_COLORS[3]} borderRadius={0} />
          <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} fontFamily="mono">Burned</Text>
        </HStack>
      </HStack>
    </Card>
  </VStack>
)
