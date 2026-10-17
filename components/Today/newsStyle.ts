// The Today bodies' shared style constants (newsAtoms.tsx draws with them). Plain
// values, no React.

import { NEWS, NEWS_FONT } from '@/components/NewsEdition/tokens'

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

/** The nameplate's measure: "Membrane" (8 characters). */
const NAMEPLATE_CHARS = 8
/**
 * The masthead nameplate's size. "Membrane" sets at clamp(56px, 16vw, 120px); a longer
 * page name ("Carry Radar") scales every bound by 8 / its length, so it spans the same
 * measure and never breaks or overflows a phone.
 */
export function nameplateSize(name: string): string {
  const k = Math.min(1, NAMEPLATE_CHARS / Math.max(1, name.length))
  return `clamp(${Math.round(56 * k)}px, ${Number((16 * k).toFixed(1))}vw, ${Math.round(120 * k)}px)`
}

/**
 * The raised print button (a primary action on a news page): ink-2, the page's brown,
 * paper text, the hard raised shadow (NEWS.shadowRaised, owner ruling 2026-10-17), ink
 * on hover. Spread into a Chakra Box/Button inside a `.news-edition` root.
 */
export const RAISED_BUTTON = {
  minH: TARGET,
  fontFamily: NEWS_FONT.mono,
  fontSize: '13px',
  fontWeight: 700,
  textAlign: 'center' as const,
  color: NEWS.paper,
  bg: NEWS.ink2,
  border: 'none',
  borderRadius: 0,
  boxShadow: NEWS.shadowRaised,
  whiteSpace: 'nowrap' as const,
  _hover: { bg: NEWS.ink },
}
