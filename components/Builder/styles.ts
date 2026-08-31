// Shared text/style fragments for the Builder feature. Alpha tints below are
// derived from SEMANTIC_COLORS hexes (phosphor/gold/blood/bone) — the proto used
// the same rgba values; kept here so no raw color leaks into components.

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

export const TINTS = {
  phosFaint: 'rgba(155, 220, 79, 0.07)', // slot drop-target wash
  phosBorder: 'rgba(155, 220, 79, 0.45)', // live machine border
  phosRow: 'rgba(155, 220, 79, 0.06)', // "you" leaderboard row
  goldBorder: 'rgba(216, 178, 74, 0.5)', // practice chip border
  bloodBand: 'rgba(207, 64, 52, 0.20)', // LTV band between cap and line
  boneDots: 'rgba(236, 230, 216, 0.055)', // factory-floor dot grid
  boneBar: 'rgba(236, 230, 216, 0.06)', // gauge track
  boneBeltLive: 'rgba(236, 230, 216, 0.16)',
  boneBeltIdle: 'rgba(236, 230, 216, 0.07)',
  sunk: '#070708', // proto --sunk; one step below bgPrimary
  overlay: 'rgba(7, 7, 8, 0.78)',
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
