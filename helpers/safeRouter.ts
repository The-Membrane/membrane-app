import { NextRouter } from 'next/router'

/**
 * Safe router utility that ensures chain parameter is always preserved
 * Prevents the "href interpolation failed" error by extracting chain from URL path
 */
export const safeRouterReplace = (
    router: NextRouter,
    updates: Record<string, any> = {},
    options: { shallow?: boolean; scroll?: boolean } = { shallow: true, scroll: false }
) => {
    console.log('🔧 safeRouterReplace called with:', updates);
    console.log('🔧 Router state:', {
        asPath: router.asPath,
        pathname: router.pathname,
        query: router.query,
        isReady: router.isReady
    });

    const nextQuery: Record<string, any> = { ...router.query, ...updates };

    // Log current chain parameter (don't override)
    console.log('🔧 SafeRouter current chain parameter:', nextQuery.chain);

    console.log('🔧 Final routing data:', {
        pathname: router.pathname,
        nextQuery,
        hasChain: !!nextQuery.chain,
        chainValue: nextQuery.chain
    });

    // Validate that we have the chain parameter before routing
    if (!nextQuery.chain) {
        console.error('❌ CRITICAL: Missing chain parameter in route update!', {
            pathname: router.pathname,
            nextQuery,
            currentPath,
            pathSegments,
            updates
        });
        return false;
    }

    try {
        router.replace({ pathname: router.pathname, query: nextQuery }, undefined, options);
        console.log('✅ Route update successful');
        return true;
    } catch (error) {
        console.error('❌ Route update failed:', error);
        return false;
    }
}

/**
 * Safe router utility for updating specific query parameters
 */
export const safeUpdateQuery = (
    router: NextRouter,
    updates: { carId?: string; trackId?: string; tab?: string;[key: string]: any },
    options: { shallow?: boolean; scroll?: boolean } = { shallow: true, scroll: false }
) => {
    const cleanUpdates: Record<string, any> = {};

    // Clean up undefined values
    Object.entries(updates).forEach(([key, value]) => {
        if (value !== undefined) {
            if (value === null || value === '') {
                // Don't add null/empty values, they'll be deleted
            } else {
                cleanUpdates[key] = value;
            }
        }
    });

    return safeRouterReplace(router, cleanUpdates, options);
}

/**
 * Debug function to log current router state
 */
export const debugRouterState = (router: NextRouter, context: string = 'Router Debug') => {
    console.log(`🔍 ${context}:`, {
        asPath: router.asPath,
        pathname: router.pathname,
        query: router.query,
        isReady: router.isReady,
        route: router.route,
        pathSegments: router.asPath.split('/'),
        extractedChain: router.asPath.split('/')[1]
    });
}
