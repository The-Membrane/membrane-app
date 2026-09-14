// CDT — one line, centred, with the door to it. Nothing else belongs in this band.

import { Link, Text, VStack } from '@chakra-ui/react'
import NextLink from 'next/link'
import React from 'react'

import { Eyebrow } from '@/components/Evidence/atoms'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { useChainRoute } from '@/hooks/useChainRoute'

import { CDT_LINE } from './facts'

export const CdtLine: React.FC<{ num?: string }> = ({ num = '05' }) => {
  const { chainName } = useChainRoute()

  return (
    <VStack
      align="center"
      spacing={SPACING_PATTERNS.stackSpacing}
      borderTop="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
      borderBottom="1px solid"
      py={SPACING.xl}
      textAlign="center"
    >
      <Eyebrow>{num} / CDT</Eyebrow>
      <Text
        fontFamily={TYPOGRAPHY.fontDisplay}
        fontSize={TYPOGRAPHY.h3}
        color={SEMANTIC_COLORS.textPrimary}
        maxW="760px"
        lineHeight="1.6"
      >
        {CDT_LINE.line}
      </Text>
      <Link
        as={NextLink}
        href={`/${chainName}${CDT_LINE.href}`}
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.xs}
        textTransform="uppercase"
        letterSpacing="0.28em"
        color={SEMANTIC_COLORS.success}
        textDecoration="underline"
        textUnderlineOffset="4px"
        transition={TRANSITIONS.colors}
        _hover={{ color: SEMANTIC_COLORS.textPrimary }}
        _focusVisible={FOCUS_STYLES.ring}
      >
        Mint CDT
      </Link>
    </VStack>
  )
}

export default CdtLine
