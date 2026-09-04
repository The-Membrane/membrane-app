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
        glowColor: 'color-mix(in srgb, var(--m-secondary) 80%, transparent)', // cyber teal, 0.8 alpha preserved
        accentColor: 'var(--m-secondary)',
    },
    manic: {
        id: 'manic',
        imagePath: '/images/ditto-manic.png',
        altText: 'Ditto with lightning hat',
        glowColor: 'color-mix(in srgb, var(--m-secondary) 80%, transparent)', // cyber teal, 0.8 alpha preserved
        accentColor: 'var(--m-secondary)',
    },
    disco: {
        id: 'disco',
        imagePath: '/images/ditto-disco.png',
        altText: 'Ditto with DJ hat',
        glowColor: 'color-mix(in srgb, var(--m-primary) 80%, transparent)', // phosphor, 0.8 alpha preserved
        accentColor: 'var(--m-primary)',
    },
    transmuter: {
        id: 'transmuter',
        imagePath: '/images/ditto-transmuter.png',
        altText: 'Ditto with alchemy hat',
        glowColor: 'color-mix(in srgb, var(--m-secondary) 80%, transparent)', // cyber teal, 0.8 alpha preserved
        accentColor: 'var(--m-secondary)',
    },
    portfolio: {
        id: 'portfolio',
        imagePath: '/images/ditto-portfolio.png',
        altText: 'Ditto with analyst hat',
        glowColor: 'color-mix(in srgb, var(--m-secondary) 80%, transparent)', // cyber teal, 0.8 alpha preserved
        accentColor: 'var(--m-secondary)',
    },
    lockdrop: {
        id: 'lockdrop',
        imagePath: '/images/ditto-lockhead.png',
        altText: 'Ditto with lock hat',
        glowColor: 'color-mix(in srgb, var(--m-warning) 80%, transparent)', // gold, 0.8 alpha preserved — lockdrop is a gate
        accentColor: 'var(--m-warning)',
    },
    mint: {
        id: 'mint',
        imagePath: '/images/ditto-printer.png',
        altText: 'Ditto with printer',
        glowColor: 'color-mix(in srgb, var(--m-primary) 80%, transparent)', // phosphor, 0.8 alpha preserved
        accentColor: 'var(--m-primary)',
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

