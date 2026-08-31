import React from 'react'
import { Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

/**
 * Renders the small subset of inline markup the proto embeds in oracle/route
 * copy — `<b class="does|not|mut">…</b>` and `<b style="color:var(--x)">…</b>`
 * — as semantic-coloured spans. The strings are trusted static fixtures, but we
 * parse rather than dangerouslySetInnerHTML so every colour maps to a token
 * (proto's var(--phos/teal/gold/blood) → success/info/warning/danger).
 */

// Living Typeface class → semantic token.
const CLASS_COLOR: Record<string, string> = {
  does: SEMANTIC_COLORS.success, // phosphor
  not: SEMANTIC_COLORS.info, // teal
  mut: SEMANTIC_COLORS.warning, // gold
}

const VAR_COLOR: Record<string, string> = {
  phos: SEMANTIC_COLORS.success,
  teal: SEMANTIC_COLORS.info,
  gold: SEMANTIC_COLORS.warning,
  blood: SEMANTIC_COLORS.danger,
}

// Matches <b class="x">…</b> or <b style="color:var(--x)">…</b> or bare <b>…</b>.
const B_TAG = /<b(?:\s+class="([^"]*)"|\s+style="color:var\(--([a-z]+)\)")?\s*>(.*?)<\/b>/gis

function boldColor(cls?: string, cssVar?: string): string {
  if (cls && CLASS_COLOR[cls]) return CLASS_COLOR[cls]
  if (cssVar && VAR_COLOR[cssVar]) return VAR_COLOR[cssVar]
  return SEMANTIC_COLORS.textPrimary // bare <b> → bone
}

export function parseRich(html: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  let key = 0
  B_TAG.lastIndex = 0
  while ((m = B_TAG.exec(html)) !== null) {
    if (m.index > last) out.push(html.slice(last, m.index))
    const [, cls, cssVar, inner] = m
    out.push(
      <Text as="span" key={key++} fontWeight={TYPOGRAPHY.normal} color={boldColor(cls, cssVar)}>
        {inner}
      </Text>
    )
    last = m.index + m[0].length
  }
  if (last < html.length) out.push(html.slice(last))
  return out
}

export interface RichTextProps {
  html: string
}

/** Inline component wrapper around {@link parseRich}. */
export const RichText: React.FC<RichTextProps> = ({ html }) => <>{parseRich(html)}</>

export default RichText
