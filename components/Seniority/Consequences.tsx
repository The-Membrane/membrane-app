// THREE CONSEQUENCES of the order above, each with the surface that proves it.
//
// `note` on each record is the refuter's audit trail (what the brief claimed and why
// it was changed). It is deliberately left unrendered — facts.ts is the record, the
// page is the claim.

import { HStack, Link, SimpleGrid, Text, VStack } from '@chakra-ui/react'
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
import { CONSEQUENCES } from './facts'

export const Consequences: React.FC<{ num?: string }> = ({ num = '02' }) => {
  const { chainName } = useChainRoute()

  return (
    <VStack align="stretch" spacing={SPACING_PATTERNS.sectionGap}>
      <Eyebrow>{num} / What follows</Eyebrow>

      <SimpleGrid columns={{ base: 1, md: 3 }} spacing={SPACING_PATTERNS.sectionGap}>
        {CONSEQUENCES.map((c) => (
          <Card key={c.proof} variant="default">
            <VStack align="stretch" spacing={SPACING_PATTERNS.stackSpacing} h="100%">
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.body}
                color={SEMANTIC_COLORS.textPrimary}
                lineHeight="1.7"
              >
                {c.effect}
              </Text>

              <HStack spacing={SPACING.sm} flexWrap="wrap" mt="auto">
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.xs}
                  color={SEMANTIC_COLORS.textSecondary}
                >
                  Proof:
                </Text>
                <Link
                  as={NextLink}
                  href={`/${chainName}${c.proofHref}`}
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.xs}
                  color={SEMANTIC_COLORS.success}
                  textDecoration="underline"
                  textUnderlineOffset="3px"
                  transition={TRANSITIONS.colors}
                  _hover={{ color: SEMANTIC_COLORS.textPrimary }}
                  _focusVisible={FOCUS_STYLES.ring}
                >
                  {c.proof}
                </Link>
              </HStack>

              <Cite>{c.cite}</Cite>
            </VStack>
          </Card>
        ))}
      </SimpleGrid>
    </VStack>
  )
}

export default Consequences
