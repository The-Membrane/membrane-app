// The Today bodies' shared style constants (newsAtoms.tsx draws with them). Plain
// values, no React.

export const CAPS = { textTransform: 'uppercase' as const, letterSpacing: '0.12em' }
export const TABULAR = { fontVariantNumeric: 'tabular-nums' }
/** A faint ink hatch: stale or unavailable data (never a colour). Same as the strip. */
export const HATCH =
  'repeating-linear-gradient(-45deg, var(--news-rule) 0 1px, transparent 1px 6px)'
export const HEADLINE_LINE = '28px'
/** Two headline lines: every headline slot reserves this, so a wrap never shifts. */
export const HEADLINE_SLOT = '56px'
export const TARGET = '44px'
/** Each body's lead (and the loading skeleton) has this height, so the body that
 *  arrives never moves what is above the fold. On phones it also keeps the jump line and
 *  the method heading below a 390×844 fold in the Safety states (DESIGN_RULES §3). */
export const LEAD_MIN_H = { base: '268px', lg: '252px' }

/** An em dash, the loading placeholder (never a number). */
export const DASH = '—'
