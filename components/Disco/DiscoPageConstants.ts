import { SEMANTIC_COLORS } from '@/config/semanticColors'

// Colour constants shared across DiscoPage sections.

/**
 * Phosphor — the Disco accent. Value is #9bdc4f (SEMANTIC_COLORS.primary).
 *
 * DELIBERATELY still an `rgb()` literal, not the hex token. ~20 call sites across
 * components/Disco build alpha variants as `${PRIMARY_PURPLE}40`, which against an
 * rgb() string yields `rgb(155, 220, 79)40` — invalid CSS the browser drops. Those
 * borders and `0 0 20px` glows are therefore currently DEAD. Swapping this to hex
 * makes every one of them render at once: the borders would be an improvement, but
 * the glows violate the "no glow on interactive UI" rule.
 *
 * So: convert this to SEMANTIC_COLORS.primary only as part of a single sweep that
 * also strips the glows. Don't change it in isolation.
 */
export const PHOSPHOR = 'rgb(155, 220, 79)'

/** @deprecated Misnomer from the pre-Living-Typeface palette — this value is phosphor, not purple. Use PHOSPHOR. */
export const PRIMARY_PURPLE = PHOSPHOR

export const DARK_BG = SEMANTIC_COLORS.bgPrimary
