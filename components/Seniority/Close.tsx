// THE CLOSE. The seniority argument ends on measured outcomes, not on a promise.
//
// DebtLens is the path-independent lens from the Evidence tool, mounted here on the
// same server-rendered summary the page already carries (pages/[chain]/index.tsx),
// so a crawler and the first paint both see real figures. The full cohort table
// stays at /[chain]/evidence, which the second CTA points at.

import { Box, Button, HStack, Text, VStack } from '@chakra-ui/react'
import NextLink from 'next/link'
import React from 'react'

import { Eyebrow } from '@/components/Evidence/atoms'
import { DebtLens } from '@/components/Evidence/DebtLens'
import type { EvidenceDoc } from '@/components/Evidence/types'
import { useEvidence } from '@/components/Evidence/useEvidence'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { ACTIVE_EFFECTS, FOCUS_STYLES, HOVER_EFFECTS, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { useChainRoute } from '@/hooks/useChainRoute'

import { CLOSE } from './facts'

export const Close: React.FC<{ initialDoc?: EvidenceDoc | null; num?: string }> = ({
  initialDoc,
  num = '06',
}) => {
  const { chainName } = useChainRoute()
  const { doc, error } = useEvidence(initialDoc)

  return (
    <VStack align="stretch" spacing={SPACING_PATTERNS.sectionGap}>
      <VStack align="flex-start" spacing={SPACING.sm}>
        <Eyebrow>
          {num} / {CLOSE.eyebrow}
        </Eyebrow>
        <Text
          as="h2"
          fontFamily={TYPOGRAPHY.fontDisplay}
          fontSize={TYPOGRAPHY.h2}
          fontWeight={TYPOGRAPHY.semibold}
          color={SEMANTIC_COLORS.textPrimary}
        >
          {CLOSE.headline}
        </Text>
      </VStack>

      {doc ? <DebtLens debt={doc.debt} byAsset={doc.byAsset} /> : null}

      {error && !doc ? (
        <Box
          border="1px solid"
          borderColor={SEMANTIC_COLORS.danger}
          p={SPACING_PATTERNS.cardPadding}
        >
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.small}
            color={SEMANTIC_COLORS.danger}
          >
            Could not load the dataset ({error}). Nothing is rendered rather than showing invented
            numbers.
          </Text>
        </Box>
      ) : null}

      <HStack spacing={SPACING_PATTERNS.buttonGroupGap} flexWrap="wrap">
        <Button
          as={NextLink}
          href={`/${chainName}${CLOSE.href}`}
          borderRadius={0}
          bg={SEMANTIC_COLORS.success}
          color={SEMANTIC_COLORS.bgPrimary}
          border="1px solid"
          borderColor={SEMANTIC_COLORS.success}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.small}
          transition={TRANSITIONS.colors}
          _hover={{ opacity: 0.9 }}
          _active={ACTIVE_EFFECTS.dim}
          _focus={FOCUS_STYLES.ring}
        >
          {CLOSE.cta}
        </Button>

        <Button
          as={NextLink}
          href={`/${chainName}${CLOSE.evidenceHref}`}
          variant="ghost"
          borderRadius={0}
          border="1px solid"
          borderColor={SEMANTIC_COLORS.borderSubtle}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.small}
          transition={TRANSITIONS.colors}
          _hover={HOVER_EFFECTS.borderHighlight}
          _active={ACTIVE_EFFECTS.dim}
          _focus={FOCUS_STYLES.ring}
        >
          Every account, filterable
        </Button>
      </HStack>
    </VStack>
  )
}

export default Close
