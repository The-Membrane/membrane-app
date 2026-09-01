/**
 * Disco loss-absorption risk ramp — the single source of truth for slot colouring.
 *
 * This replaces four copies of a hand-rolled interpolation that ran
 * rgb(34,211,238) → rgb(166,146,255), i.e. #22d3ee (cyan) → #a692ff (purple).
 * Both endpoints are banned by the design system: success must be phosphor, and
 * #a692ff is named explicitly as a forbidden purple. The copies lived in
 * SlotSelector.tsx, DiscoPageWaterfallRow.tsx, SlotManageHelpers.ts and
 * DepositModal.tsx, and had drifted — two of them inverted `t` independently.
 *
 * Semantics: a slot's colour encodes WHERE IT SITS IN THE WATERFALL, not its
 * health. The highest-LTV slots absorb loss first, so they read `danger`; the
 * lowest-LTV slots are furthest from harm, so they read `success`.
 */
import { SEMANTIC_COLORS } from '@/config/semanticColors'

/** Riskiest → safest. Interpolated through, so order is load-bearing. */
const RISK_RAMP = [SEMANTIC_COLORS.danger, SEMANTIC_COLORS.warning, SEMANTIC_COLORS.success]

/** The design system's opacity ladder. Continuous alpha is an off-scale defect. */
const OPACITY_STEPS = [0.1, 0.2, 0.4, 0.6, 0.8]

/** The LTV window slots are normalised against: 50% (safest) → 90% (riskiest). */
const LTV_MIN = 50
const LTV_MAX = 90

export interface RGB {
    r: number
    g: number
    b: number
}

const hexToRgb = (hex: string): RGB => {
    const h = hex.replace('#', '')
    return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
    }
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

/** Snap to the nearest allowed opacity step. */
export const snapOpacity = (v: number) =>
    OPACITY_STEPS.reduce((best, step) => (Math.abs(step - v) < Math.abs(best - v) ? step : best))

/**
 * Colour at a normalised waterfall position.
 * @param t 0 = riskiest (absorbs first), 1 = safest (absorbs last).
 */
export const riskRgbAt = (t: number): RGB => {
    const seg = clamp01(t) * (RISK_RAMP.length - 1)
    const i = Math.min(Math.floor(seg), RISK_RAMP.length - 2)
    const f = seg - i
    const a = hexToRgb(RISK_RAMP[i])
    const b = hexToRgb(RISK_RAMP[i + 1])
    return {
        r: Math.round(a.r + (b.r - a.r) * f),
        g: Math.round(a.g + (b.g - a.g) * f),
        b: Math.round(a.b + (b.b - a.b) * f),
    }
}

/**
 * Colour at an ordinal position in a list already sorted riskiest-first.
 * Mirrors the old `idx / (total - 1)` form.
 */
export const riskRgbAtIndex = (index: number, total: number): RGB =>
    riskRgbAt(total > 1 ? index / (total - 1) : 0)

/**
 * Colour for a slot's LTV percentage. Higher LTV = riskier = nearer `danger`.
 * Mirrors the old `(slot - 50) / 40` normalisation.
 */
export const riskRgbForLtv = (ltvPct: number): RGB =>
    riskRgbAt(1 - clamp01((ltvPct - LTV_MIN) / (LTV_MAX - LTV_MIN)))

/** Convenience: an rgba() string with the alpha snapped to the allowed ladder. */
export const riskRgba = (rgb: RGB, opacity: number) =>
    `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${snapOpacity(opacity)})`
