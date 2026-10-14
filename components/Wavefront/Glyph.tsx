import React, { memo, useId } from 'react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

import { MARK_TOKEN, markPathD, type MarkKind } from './marks'

/** A legend glyph: the canvas mark itself, as inline SVG. Decorative; the text carries meaning. */
export const Glyph: React.FC<{ kind: MarkKind; size?: number }> = ({ kind, size = 10 }) => {
  const d = markPathD(kind, size)
  const color = MARK_TOKEN[kind]
  // pattern ids must be unique per instance (DESIGN_RULES §9)
  const id = `wf-hatch-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
      focusable="false"
      style={{ flex: 'none', overflow: 'visible' }}
    >
      {kind === 'gridEnd' ? (
        <>
          <defs>
            <pattern
              id={id}
              width={3}
              height={3}
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <rect width={1.2} height={3} style={{ fill: color }} />
            </pattern>
          </defs>
          <path d={d} style={{ fill: `url(#${id})` }} />
        </>
      ) : kind === 'pending' ? (
        <path d={d} style={{ fill: 'none', stroke: color, strokeWidth: 1.4 }} />
      ) : (
        <path d={d} style={{ fill: color }} />
      )}
    </svg>
  )
}

/** Per-frame text uses plain elements with token styles: no style recomputation per frame. */
const countStyle: React.CSSProperties = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: TYPOGRAPHY.xs,
  color: SEMANTIC_COLORS.textPrimary,
  fontVariantNumeric: 'tabular-nums',
}
const labelStyle: React.CSSProperties = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: TYPOGRAPHY.xs,
  color: SEMANTIC_COLORS.textSecondary,
}
const itemStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--chakra-space-1)',
  whiteSpace: 'nowrap',
}

/** "<glyph> 2,536 sold": glyph coloured, count in bone, label in muted ink (§2). */
export const LegendItem: React.FC<{ kind: MarkKind; count: string; label: string }> = memo(
  function LegendItem({ kind, count, label }) {
    return (
      <span style={itemStyle}>
        <Glyph kind={kind} />
        <span style={countStyle}>{count}</span>
        <span style={labelStyle}>{label}</span>
      </span>
    )
  },
)
