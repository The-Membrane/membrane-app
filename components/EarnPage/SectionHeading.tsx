import React from 'react'
import { Heading, Text, Wrap, WrapItem } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'

export interface SectionHeadingProps {
  index: string
  title: string
  note?: string
}

/** Ported from the proto's `.sect` header row: "NN /" eyebrow, serif h2, right-aligned note (proto :191-236). */
export const SectionHeading: React.FC<SectionHeadingProps> = ({ index, title, note }) => (
  <Wrap spacing={SPACING.md} align="baseline" mt={SPACING.xl} mb={SPACING.sm}>
    <WrapItem>
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.label} letterSpacing="0.28em" textTransform="uppercase" color={SEMANTIC_COLORS.textSecondary}>
        {index} /
      </Text>
    </WrapItem>
    <WrapItem>
      <Heading as="h2" fontFamily={TYPOGRAPHY.fontDisplay} fontWeight={TYPOGRAPHY.normal} fontSize={TYPOGRAPHY.h2} color={SEMANTIC_COLORS.textPrimary}>
        {title}
      </Heading>
    </WrapItem>
    {note && (
      <WrapItem>
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11px" color={SEMANTIC_COLORS.textTertiary}>
          {note}
        </Text>
      </WrapItem>
    )}
  </Wrap>
)

export default SectionHeading
