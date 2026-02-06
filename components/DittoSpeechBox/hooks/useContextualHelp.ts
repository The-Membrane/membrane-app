import { useMemo, useCallback } from 'react'
import { useRouter } from 'next/router'
import { useDittoCompanionState } from './useDittoCompanionState'

interface HelpTopic {
    id: string
    title: string
    description: string
    pages?: string[] // Pages where this help is relevant
    triggerCondition?: 'always' | 'no_position' | 'has_position' | 'first_visit'
    priority: number
}

// Contextual help topics
const helpTopics: HelpTopic[] = [
    // Manic page help
    {
        id: 'manic-intro',
        title: 'What is Manic?',
        description: 'Manic is a leveraged yield farming protocol. Deposit USDC to earn amplified yields through automated looping strategies.',
        pages: ['/manic'],
        triggerCondition: 'first_visit',
        priority: 10,
    },
    {
        id: 'manic-deposit',
        title: 'How to Deposit',
        description: 'Enter the amount of USDC you want to deposit and click the deposit button. Your funds will start earning immediately.',
        pages: ['/manic'],
        triggerCondition: 'no_position',
        priority: 8,
    },
    {
        id: 'manic-loop',
        title: 'Understanding Loops',
        description: 'Looping multiplies your position by borrowing against your collateral. More loops = higher yield but also higher risk.',
        pages: ['/manic'],
        triggerCondition: 'has_position',
        priority: 7,
    },
    // Disco page help
    {
        id: 'disco-intro',
        title: 'What is Disco?',
        description: 'Disco is the MBRN distribution protocol. Deposit assets to earn MBRN governance tokens.',
        pages: ['/disco'],
        triggerCondition: 'first_visit',
        priority: 10,
    },
    {
        id: 'disco-deposit',
        title: 'Earning MBRN',
        description: 'Deposit supported assets to start earning MBRN. Your rewards accumulate over time and can be claimed anytime.',
        pages: ['/disco'],
        triggerCondition: 'no_position',
        priority: 8,
    },
    // Transmuter page help
    {
        id: 'transmuter-intro',
        title: 'What is the Transmuter?',
        description: 'The Transmuter allows you to swap between CDT and USDC at a 1:1 rate, subject to available liquidity.',
        pages: ['/transmuter'],
        triggerCondition: 'first_visit',
        priority: 10,
    },
    {
        id: 'transmuter-swap',
        title: 'How to Swap',
        description: 'Enter the amount you want to swap and the direction. The Transmuter will process your swap using available liquidity.',
        pages: ['/transmuter'],
        triggerCondition: 'always',
        priority: 5,
    },
    // Portfolio page help
    {
        id: 'portfolio-overview',
        title: 'Your Portfolio',
        description: 'This page shows all your positions across Membrane protocols. Track your earnings and manage your investments.',
        pages: ['/portfolio'],
        triggerCondition: 'first_visit',
        priority: 10,
    },
    // General help
    {
        id: 'ditto-usage',
        title: 'Using Ditto',
        description: 'Click on me anytime to access quick actions, view updates, or get help. I\'m here to make your experience easier!',
        triggerCondition: 'first_visit',
        priority: 3,
    },
]

export const useContextualHelp = () => {
    const router = useRouter()
    const { hasVisitedPage, engagementLevel } = useDittoCompanionState()

    // Get relevant help topics for current page
    const relevantTopics = useMemo(() => {
        const pathname = router.pathname

        return helpTopics
            .filter(topic => {
                // If topic has specific pages, check if current page matches
                if (topic.pages && topic.pages.length > 0) {
                    const matches = topic.pages.some(page => pathname.includes(page))
                    if (!matches) return false
                }

                // Check trigger conditions
                if (topic.triggerCondition === 'first_visit') {
                    const isFirstVisit = !hasVisitedPage(pathname)
                    if (!isFirstVisit) return false
                }

                return true
            })
            .sort((a, b) => b.priority - a.priority)
    }, [router.pathname, hasVisitedPage])

    // Get the most relevant help topic
    const topHelpTopic = relevantTopics[0] || null

    // Search help topics
    const searchHelp = useCallback((query: string): HelpTopic[] => {
        const lowerQuery = query.toLowerCase()
        return helpTopics.filter(topic =>
            topic.title.toLowerCase().includes(lowerQuery) ||
            topic.description.toLowerCase().includes(lowerQuery)
        )
    }, [])

    // Get help by ID
    const getHelpById = useCallback((id: string): HelpTopic | undefined => {
        return helpTopics.find(topic => topic.id === id)
    }, [])

    // Get all help for current page
    const getPageHelp = useCallback((): HelpTopic[] => {
        const pathname = router.pathname
        return helpTopics.filter(topic =>
            !topic.pages || topic.pages.length === 0 || topic.pages.some(page => pathname.includes(page))
        )
    }, [router.pathname])

    // Suggest help based on user behavior
    const suggestHelp = useCallback((): HelpTopic | null => {
        // For new users, prioritize introductory content
        if (engagementLevel === 'new') {
            return relevantTopics.find(t => t.triggerCondition === 'first_visit') || relevantTopics[0]
        }

        // For learning users, focus on actionable help
        if (engagementLevel === 'learning') {
            return relevantTopics.find(t =>
                t.triggerCondition === 'no_position' || t.triggerCondition === 'has_position'
            ) || relevantTopics[0]
        }

        // For experienced users, only show if highly relevant
        return relevantTopics.find(t => t.priority >= 8) || null
    }, [engagementLevel, relevantTopics])

    return {
        relevantTopics,
        topHelpTopic,
        searchHelp,
        getHelpById,
        getPageHelp,
        suggestHelp,
        allTopics: helpTopics,
    }
}

