import React from 'react'
import { VStack, Text } from '@chakra-ui/react'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

/* ── Page header ── */
export const DashboardHeader: React.FC = () => (
  <VStack spacing={1}>
    <Text
      as="h1"
      fontSize={TYPOGRAPHY.h1}
      fontWeight={TYPOGRAPHY.bold}
      color={SEMANTIC_COLORS.textPrimary}
      fontFamily={TYPOGRAPHY.fontDisplay}
      textAlign="center"
    >
      Acquisition Dashboard
    </Text>
    <Text
      fontSize={TYPOGRAPHY.xs}
      color={SEMANTIC_COLORS.textSecondary}
      fontFamily={TYPOGRAPHY.fontMono}
      letterSpacing="1px"
      textAlign="center"
    >
      MBRN Supply & Lockdrop Analytics
    </Text>
  </VStack>
)
