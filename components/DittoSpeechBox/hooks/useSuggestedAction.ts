import { useCallback } from 'react'
import { useRouter } from 'next/router'
import { usePageActions, PageAction, validatePageAction } from './usePageActions'
import { useChainRoute } from '@/hooks/useChainRoute'

/**
 * Maps a PageAction suggestion type to its target route and view.
 */
const ACTION_ROUTE_MAP: Record<PageAction['type'], { route: string; view?: string }> = {
    deposit: { route: '/disco' },
    withdraw: { route: '/disco' },
    loop: { route: '/manic' },
    swap: { route: '/transmuter' },
    lock: { route: '/transmuter' },
    claim: { route: '/portfolio' },
    stake: { route: '/stake' },
}

interface SuggestedActionResult {
    success: boolean
    errors: string[]
}

/**
 * Hook that bridges the suggestion action flow (PageAction) to the
 * confirmation/navigation flow.
 *
 * Validates that the suggested action has at minimum a filled title (label)
 * and description before allowing the user to proceed.
 */
export const useSuggestedAction = () => {
    const router = useRouter()
    const { chainName } = useChainRoute()
    const { triggerSuggestedAction, actions } = usePageActions()

    /**
     * Execute a suggested action by ID.
     * Validates title/description, then navigates to the appropriate page.
     */
    const executeSuggestedAction = useCallback((actionId: string): SuggestedActionResult => {
        const result = triggerSuggestedAction(actionId)

        if (!result.valid || !result.action) {
            return { success: false, errors: result.errors }
        }

        const routeConfig = ACTION_ROUTE_MAP[result.action.type]
        if (routeConfig) {
            router.push(`/${chainName}${routeConfig.route}`)
        }

        return { success: true, errors: [] }
    }, [triggerSuggestedAction, router, chainName])

    /**
     * Get validated actions unconditionally (using mock data, so skip availability check).
     * Only requires title and description to be filled.
     */
    const validatedActions = actions.filter(action => {
        const { valid } = validatePageAction(action)
        return valid
    })

    return {
        executeSuggestedAction,
        validatedActions,
        hasValidActions: validatedActions.length > 0,
    }
}
