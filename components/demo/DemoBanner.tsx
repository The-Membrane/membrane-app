import React from 'react'
import { Box, HStack, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'

import useDemoMode from '@/hooks/useDemoMode'

export interface DemoBannerProps {
  /** Overrides the trailing copy after "Demo — not yours ·". */
  note?: string
}

const DEFAULT_NOTE = 'connect a wallet to see your own'

/**
 * Persistent V20 demo banner (docs/VETERAN_UX_RULESET.md V20). Renders null
 * outside demo mode. Ported from the `.demobar2` bar in
 * public/proto/_demo-layer.html.
 */
export const DemoBanner: React.FC<DemoBannerProps> = ({ note = DEFAULT_NOTE }) => {
  const { isDemo } = useDemoMode()

  if (!isDemo) return null

  return (
    <Box
      data-testid="demo-banner"
      w="100%"
      bg={SEMANTIC_COLORS.bgTertiary}
      borderTop="1px solid"
      borderBottom="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
      borderRadius={0}
      py={SPACING.sm}
      px={SPACING.base}
    >
      <HStack spacing={SPACING.sm} justify="center">
        <Box
          w="6px"
          h="6px"
          borderRadius="full"
          bg={SEMANTIC_COLORS.warning}
          flexShrink={0}
        />
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.label}
          textTransform="uppercase"
          letterSpacing="0.28em"
          color={SEMANTIC_COLORS.textSecondary}
        >
          Demo — not yours · {note}
        </Text>
      </HStack>
    </Box>
  )
}

export default DemoBanner
