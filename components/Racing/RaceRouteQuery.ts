import { NextRouter } from 'next/router';

// Extracted verbatim from RaceViewer: builds the next route query (preserving the
// chain param) and shallow-replaces the URL. Behaviour-identical relocation.
export default function useRaceRouteQuery(router: NextRouter) {
    const updateRouteQuery = (updates: { carId?: string; trackId?: string }) => {
        console.log('🔧 updateRouteQuery called with:', updates);
        console.log('🔧 Current router state:', {
            asPath: router.asPath,
            pathname: router.pathname,
            query: router.query,
            isReady: router.isReady
        });

        const nextQuery: Record<string, any> = { ...router.query };

        // Log current chain parameter (don't override)
        console.log('🔧 Current chain parameter:', nextQuery.chain);

        if (updates.carId !== undefined) {
            if (updates.carId) nextQuery.carId = updates.carId; else delete nextQuery.carId;
            console.log('🔧 Updated carId:', updates.carId);
        }
        if (updates.trackId !== undefined) {
            if (updates.trackId) nextQuery.trackId = updates.trackId; else delete nextQuery.trackId;
            console.log('🔧 Updated trackId:', updates.trackId);
        }

        // Ensure chain parameter is preserved for dynamic routes
        const pathname = router.pathname; // This preserves the dynamic route structure like /[chain]/maze-runners

        console.log('🔧 Final routing data:', {
            pathname,
            nextQuery,
            hasChain: !!nextQuery.chain,
            chainValue: nextQuery.chain
        });

        // Validate that we have the chain parameter before routing
        if (!nextQuery.chain) {
            console.error('❌ CRITICAL: Missing chain parameter in route update!', {
                pathname,
                nextQuery
            });
            return;
        }

        try {
            router.replace({ pathname, query: nextQuery }, undefined, { shallow: true, scroll: false });
            console.log('✅ Route update successful');
        } catch (error) {
            console.error('❌ Route update failed:', error);
        }
    };

    return updateRouteQuery;
}
