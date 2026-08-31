import React from 'react'
import { Text, TextProps } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'

import { parseEmphasisMarkup } from './utils'
import type { EmphasisKind } from './types'

const EMPHASIS_COLOR: Record<EmphasisKind, string> = {
  does: SEMANTIC_COLORS.success,
  not: SEMANTIC_COLORS.info,
  mut: SEMANTIC_COLORS.warning,
}

export interface EmphasisTextProps extends Omit<TextProps, 'children'> {
  /** Copy carrying the proto's inline `<b class="does|not|mut">…</b>` spans. */
  markup: string
}

/**
 * Renders oracle-card copy that the proto marked up with inline `<b
 * class="does|not|mut">` spans (public/proto/borrow.html's ADAPTER_BULLETS /
 * TWAP_BULLETS), as real React nodes colored from SEMANTIC_COLORS — no
 * dangerouslySetInnerHTML, no raw hex.
 */
export const EmphasisText: React.FC<EmphasisTextProps> = ({ markup, ...textProps }) => {
  const segments = parseEmphasisMarkup(markup)
  return (
    <Text {...textProps}>
      {segments.map((seg, i) =>
        seg.emphasis ? (
          <Text as="b" key={i} fontWeight="normal" color={EMPHASIS_COLOR[seg.emphasis]}>
            {seg.text}
          </Text>
        ) : (
          <React.Fragment key={i}>{seg.text}</React.Fragment>
        )
      )}
    </Text>
  )
}

export default EmphasisText
