import React from 'react'
import { HStack, Text, VStack } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { Card } from '@/components/ui/Card'
import { MockStamp, DemoAwareCta } from '@/components/demo'

import { CLAIM_FEES_REQUEST, REVENUE_FEED, UNCLAIMED_FEES_USD } from './fixtures'
import { useExecutionSheet } from './hooks/useExecutionSheet'

/** Sect 04 "Fees paid to you" — the realized revenue feed and claim CTA (proto :220-225, 293-303). */
export const RevenueFeed: React.FC = () => {
  const { open } = useExecutionSheet()

  return (
    <VStack align="stretch" spacing={SPACING.md}>
      <HStack justify="space-between" wrap="wrap" spacing={SPACING.md}>
        <MockStamp label="realized only" />
        {/* Quiet outline: the hero deposit CTA is the page's one solid action;
            claiming is secondary and stays hairline-weight (hierarchy). */}
        <DemoAwareCta
          onAction={() => open(CLAIM_FEES_REQUEST)}
          bg="transparent"
          border="1px solid"
          borderColor={SEMANTIC_COLORS.borderStrong}
          color={SEMANTIC_COLORS.success}
          flexShrink={0}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.small}
          textTransform="uppercase"
          letterSpacing="0.14em"
          _hover={{ bg: 'transparent', borderColor: SEMANTIC_COLORS.success }}
        >
          {`Claim $${UNCLAIMED_FEES_USD.toFixed(2)}`}
        </DemoAwareCta>
      </HStack>

      <Card variant="default" p={0}>
        <VStack align="stretch" spacing={0}>
          {REVENUE_FEED.map((entry, i) => (
            <HStack
              key={`${entry.source}-${i}`}
              justify="space-between"
              align="baseline"
              spacing={SPACING.md}
              px={SPACING.base}
              py={SPACING.sm}
              borderBottom={i < REVENUE_FEED.length - 1 ? '1px solid' : undefined}
              borderColor={SEMANTIC_COLORS.borderSubtle}
            >
              <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.success} flexShrink={0}>
                +${entry.amountUsd.toFixed(2)}
              </Text>
              <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textSecondary} flex={1}>
                {entry.source}
              </Text>
              <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" color={SEMANTIC_COLORS.textTertiary} flexShrink={0}>
                {entry.ago}
              </Text>
            </HStack>
          ))}
        </VStack>
      </Card>
    </VStack>
  )
}

export default RevenueFeed
