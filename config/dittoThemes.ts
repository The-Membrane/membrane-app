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
}

// Theme definitions
export const dittoThemes: Record<string, DittoTheme> = {
    default: {
        id: 'default',
        imagePath: '/images/ditto.svg',
        altText: 'Ditto',
        glowColor: 'rgba(105, 67, 255, 0.8)',
        accentColor: '#6943FF',
    },
    manic: {
        id: 'manic',
        imagePath: '/images/ditto-manic.png',
        altText: 'Ditto with lightning hat',
        glowColor: 'rgba(59, 229, 229, 0.8)',
        accentColor: '#3BE5E5',
    },
    disco: {
        id: 'disco',
        imagePath: '/images/ditto-disco.png',
        altText: 'Ditto with DJ hat',
        glowColor: 'rgba(147, 51, 234, 0.8)',
        accentColor: '#9333EA',
    },
    transmuter: {
        id: 'transmuter',
        imagePath: '/images/ditto-transmuter.png',
        altText: 'Ditto with alchemy hat',
        glowColor: 'rgba(34, 211, 238, 0.8)',
        accentColor: '#22D3EE',
    },
    portfolio: {
        id: 'portfolio',
        imagePath: '/images/ditto-portfolio.png',
        altText: 'Ditto with analyst hat',
        glowColor: 'rgba(52, 211, 153, 0.8)',
        accentColor: '#34D399',
    },
    lockdrop: {
        id: 'lockdrop',
        imagePath: '/images/ditto-lockdrop.png',
        altText: 'Ditto with lock hat',
        glowColor: 'rgba(168, 85, 247, 0.8)',
        accentColor: '#A855F7',
    },
}

// Route to theme mapping
export const routeThemeMap: Record<string, string> = {
    '/manic': 'manic',
    '/disco': 'disco',
    '/transmuter': 'transmuter',
    '/portfolio': 'portfolio',
    '/transmuter-lockdrop': 'lockdrop',
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

