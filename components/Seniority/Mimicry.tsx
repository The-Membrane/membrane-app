// MIMICRY — Helmer's counter-positioning test, one card per incumbent.
//
// Each card holds two clauses: what Membrane does, and the business reason the
// incumbent leaves it alone. Both come from facts.ts; neither is softened here.

import { Link, SimpleGrid, Text, VStack } from '@chakra-ui/react'
import NextLink from 'next/link'
import React from 'react'

import { Eyebrow } from '@/components/Evidence/atoms'
import { Card } from '@/components/ui/Card'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { useChainRoute } from '@/hooks/useChainRoute'

import { Cite } from './BondCoverage'
import { MIMICRY, MIMICRY_FOOT } from './facts'

export const Mimicry: React.FC<{ num?: string }> = ({ num = '03' }) => {
  const { chainName } = useChainRoute()

  return (
    <VStack align="stretch" spacing={SPACING_PATTERNS.sectionGap}>
      <Eyebrow>{num} / Counter-positioning</Eyebrow>

      <SimpleGrid columns={{ base: 1, md: 2 }} spacing={SPACING_PATTERNS.sectionGap}>
        {MIMICRY.map((m) => (
          <Card key={m.name} variant="default">
            <VStack align="stretch" spacing={SPACING_PATTERNS.stackSpacing}>
              <Text
                fontFamily={TYPOGRAPHY.fontDisplay}
                fontSize={TYPOGRAPHY.h4}
                fontWeight={TYPOGRAPHY.medium}
                color={SEMANTIC_COLORS.textPrimary}
              >
                {m.name}
              </Text>

              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.small}
                color={SEMANTIC_COLORS.textPrimary}
                lineHeight="1.7"
              >
                {m.membrane}
              </Text>

              <VStack align="flex-start" spacing={SPACING.sm}>
                <Eyebrow>why they will not copy it</Eyebrow>
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.xs}
                  color={SEMANTIC_COLORS.textSecondary}
                  lineHeight="1.8"
                >
                  {m.wontCopy}
                </Text>
              </VStack>

              <Cite>{m.cite}</Cite>
            </VStack>
          </Card>
        ))}
      </SimpleGrid>

      <VStack align="flex-start" spacing={SPACING.sm}>
        <Text
          fontFamily={TYPOGRAPHY.fontDisplay}
          fontSize={TYPOGRAPHY.h4}
          fontStyle="italic"
          color={SEMANTIC_COLORS.textSecondary}
          maxW="760px"
          lineHeight="1.7"
        >
          {MIMICRY_FOOT.line}
        </Text>
        <Link
          as={NextLink}
          href={`/${chainName}${MIMICRY_FOOT.proofHref}`}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
          color={SEMANTIC_COLORS.success}
          textDecoration="underline"
          textUnderlineOffset="3px"
          transition={TRANSITIONS.colors}
          _hover={{ color: SEMANTIC_COLORS.textPrimary }}
          _focusVisible={FOCUS_STYLES.ring}
        >
          Run it against the measured day
        </Link>
      </VStack>
    </VStack>
  )
}

export default Mimicry
