/**
 * Ditto theme configuration.
 *
 * ONE theme. The hat variants (manic / disco / transmuter / portfolio / lockhead /
 * printer) were retired on 4 Sep 2026: the new app does not use per-page costumes, so
 * routeThemeMap and getThemeForRoute are gone with them. `glowColor` survives because
 * DittoHologram interpolates it into the drop-shadow when actions are pending.
 */

export interface DittoTheme {
    id: string
    imagePath: string
    altText: string
    glowColor: string
    accentColor: string
    imageSize?: string
    imageBottom?: string
}

export const dittoThemes: Record<string, DittoTheme> = {
    default: {
        id: 'default',
        imagePath: '/images/ditto.png',
        altText: 'Ditto',
        glowColor: 'rgba(155, 220, 79, 0.8)', // phosphor #9bdc4f — matches the seam glow
        accentColor: '#9bdc4f',
    },
}

/** Single theme; kept as a function so call sites do not change. */
export const getThemeForRoute = (_pathname?: string): DittoTheme => dittoThemes.default

/** Fallback if the themed image fails to load. */
export const getFallbackImage = (): string => dittoThemes.default.imagePath
