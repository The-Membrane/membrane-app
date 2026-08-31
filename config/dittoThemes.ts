/**
 * Ditto Theme Configuration
 * 
 * Maps routes to themed Ditto images and styling
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

// Theme definitions
export const dittoThemes: Record<string, DittoTheme> = {
    default: {
        id: 'default',
        imagePath: '/images/ditto.svg',
        altText: 'Ditto',
        glowColor: 'rgba(70, 211, 154, 0.8)', // cyber teal #46d39a
        accentColor: '#46d39a',
    },
    manic: {
        id: 'manic',
        imagePath: '/images/ditto-manic.png',
        altText: 'Ditto with lightning hat',
        glowColor: 'rgba(70, 211, 154, 0.8)', // cyber teal #46d39a
        accentColor: '#46d39a',
    },
    disco: {
        id: 'disco',
        imagePath: '/images/ditto-disco.png',
        altText: 'Ditto with DJ hat',
        glowColor: 'rgba(155, 220, 79, 0.8)', // phosphor #9bdc4f
        accentColor: '#9bdc4f',
    },
    transmuter: {
        id: 'transmuter',
        imagePath: '/images/ditto-transmuter.png',
        altText: 'Ditto with alchemy hat',
        glowColor: 'rgba(70, 211, 154, 0.8)', // cyber teal #46d39a
        accentColor: '#46d39a',
    },
    portfolio: {
        id: 'portfolio',
        imagePath: '/images/ditto-portfolio.png',
        altText: 'Ditto with analyst hat',
        glowColor: 'rgba(70, 211, 154, 0.8)', // cyber teal #46d39a
        accentColor: '#46d39a',
    },
    lockdrop: {
        id: 'lockdrop',
        imagePath: '/images/ditto-lockhead.png',
        altText: 'Ditto with lock hat',
        glowColor: 'rgba(216, 178, 74, 0.8)', // gold #d8b24a — lockdrop is a gate
        accentColor: '#d8b24a',
    },
    mint: {
        id: 'mint',
        imagePath: '/images/ditto-printer.png',
        altText: 'Ditto with printer',
        glowColor: 'rgba(155, 220, 79, 0.8)', // phosphor #9bdc4f
        accentColor: '#9bdc4f',
        imageSize: '220px',
        imageBottom: '-5px',
    },
}

// Route to theme mapping
export const routeThemeMap: Record<string, string> = {
    '/manic': 'manic',
    '/disco': 'disco',
    '/transmuter': 'transmuter',
    '/portfolio': 'portfolio',
    '/acquisition': 'lockdrop',
    '/mint': 'mint',
}

/**
 * Routes where Ditto does not appear at all.
 *
 * These are PROOF surfaces. Ditto's four message types (ALERT / UPDATE / INSIGHT /
 * SHORTCUT) are all scoped to the user's own position state — see
 * `.claude/skills/branding-guidelines/references/ditto-character.md`. The evidence
 * page has no user position: it is 2,350 strangers' accounts from October 2025. Ditto
 * would have nothing valid to say there, and anything he did say would have to be
 * invented, which is the one thing a page built to be checked cannot afford
 * (VETERAN_UX_RULESET.md V19: "Trust claims the user can check beat trust claims the
 * user must read").
 *
 * These are Next.js route PATTERNS (`router.pathname`), not URLs — the landing page is
 * `/[chain]`, not `/ethereum`. Matching is EXACT on purpose: a prefix match on
 * `/[chain]` would suppress Ditto on every page in the app.
 */
export const dittoSuppressedRoutes: string[] = [
    '/[chain]', // the landing page — renders the Evidence counterfactual tool
    '/[chain]/evidence', // kept for the legacy route, which 308s to /[chain]
]

/** True when Ditto should not mount at all for this route pattern. */
export const isDittoSuppressed = (pathname: string): boolean =>
    dittoSuppressedRoutes.includes(pathname)

/**
 * Get theme for a given route
 */
export const getThemeForRoute = (pathname: string): DittoTheme => {
    // Check direct match
    const directMatch = routeThemeMap[pathname]
    if (directMatch && dittoThemes[directMatch]) {
        return dittoThemes[directMatch]
    }

    // Check partial match (e.g., /neutron/manic matches /manic)
    for (const [route, themeId] of Object.entries(routeThemeMap)) {
        if (pathname.includes(route)) {
            return dittoThemes[themeId] || dittoThemes.default
        }
    }

    return dittoThemes.default
}

/**
 * Fallback to default image if themed image doesn't exist
 * This should be used with an onError handler on the Image component
 */
export const getFallbackImage = (): string => {
    return dittoThemes.default.imagePath
}

