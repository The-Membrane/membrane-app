// Shared text/style fragments for the Builder feature. The alpha tints below are
// theme-following: color-mix() over the semantic vars, so they invert on Parchment.
// These are all DOM-consumed (Chakra bg/border/backgroundImage), where CSS resolves
// var()/color-mix() natively. The former canvas-only belt strokes (boneBeltLive/Idle)
// moved to FactoryFloor's paint site, which must compose rgba in JS (canvas cannot
// parse var()/color-mix()).

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

export const TINTS = {
  phosFaint: 'color-mix(in srgb, var(--m-primary) 7%, transparent)', // slot drop-target wash
  phosBorder: 'color-mix(in srgb, var(--m-primary) 45%, transparent)', // live machine border
  phosRow: 'color-mix(in srgb, var(--m-primary) 6%, transparent)', // "you" leaderboard row
  goldBorder: 'color-mix(in srgb, var(--m-warning) 50%, transparent)', // practice chip border
  bloodBand: 'color-mix(in srgb, var(--m-danger) 20%, transparent)', // LTV band between cap and line
  boneDots: 'color-mix(in srgb, var(--m-text-primary) 5.5%, transparent)', // factory-floor dot grid
  boneBar: 'color-mix(in srgb, var(--m-text-primary) 6%, transparent)', // gauge track
  sunk: 'var(--m-bg-primary)', // proto --sunk (a hair below bgPrimary); no darker token exists, nearest is bg-primary
  overlay: 'var(--m-overlay)', // modal scrim
} as const

/** Mono uppercase eyebrow, 9.5–11px tier. */
export const eyebrow = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: '9.5px',
  letterSpacing: '0.24em',
  textTransform: 'uppercase' as const,
  color: SEMANTIC_COLORS.textSecondary,
}

export const eyebrowPhos = { ...eyebrow, color: SEMANTIC_COLORS.success }

/** Small mono data text. */
export const monoXs = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: '10px',
  color: SEMANTIC_COLORS.textTertiary,
}

export const monoSm = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: '11.5px',
  color: SEMANTIC_COLORS.textSecondary,
}

/** Tabular numerals for every figure. */
export const tabular = { fontVariantNumeric: 'tabular-nums' }
