import React from 'react'
import RiskChart from './RiskChart'
import { Box, HStack, Icon, Text, VStack, Popover, PopoverTrigger, PopoverContent, PopoverArrow, PopoverBody } from '@chakra-ui/react'
import { InfoIcon } from '@chakra-ui/icons'
import { Card } from '@/components/ui/Card'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import useCollateralAtRisk from './hooks/useCollateralAtRisk'

import SelectAsset from './SelectAsset'

const Risk = () => {
  const { count, totalAtRisk, atRiskCount, totalDebtAtRisk } = useCollateralAtRisk()

  return (
    <Card variant="default" display="flex" flexDirection="column" alignItems="center" gap={SPACING.lg} w="full">
      <HStack>
        <Text fontSize={TYPOGRAPHY.h3} fontWeight={TYPOGRAPHY.semibold} color={SEMANTIC_COLORS.textPrimary}>
          Bids For
        </Text>

        <SelectAsset />
      </HStack>

      <RiskChart />

      {/* Collateral at risk metrics */}
      <HStack
        w="full"
        justifyContent="space-around"
        pt={SPACING.sm}
        borderTop="1px solid"
        borderColor={SEMANTIC_COLORS.borderSubtle}
      >
        <VStack spacing={SPACING.xs}>
          <HStack spacing={SPACING.xs}>
            <Text fontSize={TYPOGRAPHY.label} textTransform="uppercase" letterSpacing="0.1em" color={SEMANTIC_COLORS.textTertiary}>
              Near Liquidation
            </Text>
            <Popover trigger="hover" placement="top">
              <PopoverTrigger>
                <Box as="span" display="inline-flex">
                  <Icon
                    as={InfoIcon}
                    color="whiteAlpha.400"
                    boxSize={3}
                    cursor="pointer"
                    _hover={{ color: 'whiteAlpha.700' }}
                  />
                </Box>
              </PopoverTrigger>
              <PopoverContent bg="rgba(10, 10, 10, 0.95)" borderColor="whiteAlpha.200" maxW="260px">
                <PopoverArrow bg="rgba(10, 10, 10, 0.95)" />
                <PopoverBody fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary} py={SPACING.sm} px={SPACING.md}>
                  Positions within 90% of liquidation LTV
                </PopoverBody>
              </PopoverContent>
            </Popover>
          </HStack>
          <Text
            fontSize={TYPOGRAPHY.h3}
            fontWeight={TYPOGRAPHY.bold}
            color={atRiskCount > 0 ? SEMANTIC_COLORS.warning : SEMANTIC_COLORS.success}
          >
            {atRiskCount}
          </Text>
          <Text fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary}>
            {totalDebtAtRisk.toFixed(2)} CDT
          </Text>
        </VStack>
        <VStack spacing={SPACING.xs}>
          <Text fontSize={TYPOGRAPHY.label} textTransform="uppercase" letterSpacing="0.1em" color={SEMANTIC_COLORS.textTertiary}>
            Liquidatable
          </Text>
          <Text
            fontSize={TYPOGRAPHY.h3}
            fontWeight={TYPOGRAPHY.bold}
            color={count > 0 ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.success}
          >
            {count}
          </Text>
          <Text fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary}>
            {totalAtRisk.toFixed(2)} CDT
          </Text>
        </VStack>
      </HStack>
    </Card>
  )
}

export default Risk
