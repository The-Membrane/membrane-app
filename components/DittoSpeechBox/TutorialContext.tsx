import React, { createContext, useContext, ReactNode } from 'react'
import { TutorialStep, FAQItem } from './hooks/usePageTutorial'
import { useTutorialStore } from './hooks/useTutorialStore'

interface TutorialContextValue {
    steps: TutorialStep[]
    faq: FAQItem[]
    currentStep: number
    isFirstStep: boolean
    isLastStep: boolean
    totalSteps: number
    onNext: () => void
    onPrevious: () => void
    onFinish: () => void
    onSkip: () => void
}

const TutorialContext = createContext<TutorialContextValue | null>(null)

export const useTutorialContext = () => {
    // Try to get from context first (for page-specific providers)
    const context = useContext(TutorialContext)
    if (context) {
        return context
    }
    
    // Fallback to global store (read-only for DittoSpeechBox)
    // Note: Actions should be called through the hook, not directly from store
    const store = useTutorialStore()
    return {
        steps: store.steps,
        faq: store.faq,
        currentStep: store.currentStep,
        isFirstStep: store.isFirstStep,
        isLastStep: store.isLastStep,
        totalSteps: store.totalSteps,
        // Use store actions as fallback, but these should ideally come from the hook
        onNext: store.nextStep,
        onPrevious: store.previousStep,
        onFinish: store.finishTutorial,
        onSkip: store.skipTutorial,
    }
}

interface TutorialProviderProps {
    children: ReactNode
    value: TutorialContextValue
}

export const TutorialProvider: React.FC<TutorialProviderProps> = ({ children, value }) => {
    return <TutorialContext.Provider value={value}>{children}</TutorialContext.Provider>
}

