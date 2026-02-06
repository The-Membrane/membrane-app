import { useMemo } from 'react'
import { useRouter } from 'next/router'
import { useManicData } from '@/hooks/useManic'
import { useDiscoUserMetrics } from '@/hooks/useDiscoData'
import useWallet from '@/hooks/useWallet'

export interface PageAction {
    id: string
    label: string
    description: string
    available: boolean
    type: 'deposit' | 'withdraw' | 'loop' | 'swap' | 'lock' | 'claim' | 'stake'
}

interface PageActionsConfig {
    page: string
    getActions: (context: ActionContext) => PageAction[]
}

interface ActionContext {
    hasPosition: boolean
    hasDeposit: boolean
    isConnected: boolean
    hasBalance: boolean
}

const pageActionsConfig: PageActionsConfig[] = [
    {
        page: '/manic',
        getActions: (ctx) => [
            {
                id: 'manic-deposit',
                label: 'Deposit',
                description: 'Deposit USDC to start earning',
                available: ctx.isConnected && ctx.hasBalance,
                type: 'deposit',
            },
            {
                id: 'manic-withdraw',
                label: 'Withdraw',
                description: 'Withdraw your position',
                available: ctx.hasPosition,
                type: 'withdraw',
            },
            {
                id: 'manic-loop',
                label: 'Loop',
                description: 'Optimize your position with looping',
                available: ctx.hasPosition,
                type: 'loop',
            },
        ],
    },
    {
        page: '/disco',
        getActions: (ctx) => [
            {
                id: 'disco-deposit',
                label: 'Deposit',
                description: 'Deposit assets to earn MBRN',
                available: ctx.isConnected && ctx.hasBalance,
                type: 'deposit',
            },
            {
                id: 'disco-withdraw',
                label: 'Withdraw',
                description: 'Withdraw your deposits',
                available: ctx.hasDeposit,
                type: 'withdraw',
            },
        ],
    },
    {
        page: '/transmuter',
        getActions: (ctx) => [
            {
                id: 'transmuter-swap',
                label: 'Swap',
                description: 'Swap between CDT and USDC',
                available: ctx.isConnected && ctx.hasBalance,
                type: 'swap',
            },
            {
                id: 'transmuter-lock',
                label: 'Lock',
                description: 'Lock assets in the transmuter',
                available: ctx.isConnected && ctx.hasBalance,
                type: 'lock',
            },
        ],
    },
    {
        page: '/portfolio',
        getActions: (ctx) => [
            {
                id: 'portfolio-claim',
                label: 'Claim',
                description: 'Claim your rewards',
                available: ctx.isConnected,
                type: 'claim',
            },
        ],
    },
    {
        page: '/stake',
        getActions: (ctx) => [
            {
                id: 'stake-stake',
                label: 'Stake',
                description: 'Stake MBRN tokens',
                available: ctx.isConnected && ctx.hasBalance,
                type: 'stake',
            },
        ],
    },
]

export const usePageActions = () => {
    const router = useRouter()
    const { address } = useWallet()
    const { hasPosition } = useManicData()
    const { deposits } = useDiscoUserMetrics(address || 'mock-user')

    const context: ActionContext = useMemo(() => ({
        hasPosition: hasPosition || false,
        hasDeposit: (deposits?.length || 0) > 0,
        isConnected: !!address,
        hasBalance: true, // Simplified - could check actual balance
    }), [hasPosition, deposits, address])

    const currentPageActions = useMemo(() => {
        const pathname = router.pathname
        const config = pageActionsConfig.find(c => pathname.includes(c.page))

        if (!config) return []

        return config.getActions(context)
    }, [router.pathname, context])

    const availableActions = useMemo(() => {
        return currentPageActions.filter(action => action.available)
    }, [currentPageActions])

    const hasAvailableActions = availableActions.length > 0

    // Generate tooltip text based on available actions
    const actionTooltip = useMemo(() => {
        if (availableActions.length === 0) return null
        return "I can help you deposit"
    }, [availableActions])

    return {
        actions: currentPageActions,
        availableActions,
        hasAvailableActions,
        actionTooltip,
        context,
    }
}

