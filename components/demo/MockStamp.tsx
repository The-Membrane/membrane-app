import React from 'react'
import { TextProps, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

export interface MockStampProps extends TextProps {
  /** Overrides the stamped word, e.g. 'measured' or 'source · fetched 14:32'. Defaults to 'mock'. */
  label?: string
}

/**
 * Inline provenance stamp for unverified data blocks (V20 rule: everything
 * unstamped stays marked mock/measured — docs/VETERAN_UX_RULESET.md V20,
 * docs/SEO_RULESET.md R14). Wrap any figure that isn't backed by a live
 * source with this, e.g. `<MockStamp label="source · fetched 14:32" />`.
 */
export const MockStamp: React.FC<MockStampProps> = ({ label = 'mock', ...textProps }) => (
  <Text
    as="span"
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize={TYPOGRAPHY.label}
    textTransform="uppercase"
    letterSpacing="0.28em"
    color={SEMANTIC_COLORS.textTertiary}
    {...textProps}
  >
    {label}
  </Text>
)

export default MockStamp
