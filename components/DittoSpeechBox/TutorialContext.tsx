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
    // Both Hooks must run unconditionally every render (Rules of Hooks): call them up
    // front, then branch on the values. useTutorialStore just subscribes to the store,
    // so calling it even when a context provider is present is harmless.
    const context = useContext(TutorialContext)
    const store = useTutorialStore()

    // Prefer a page-specific provider when present.
    if (context) {
        return context
    }

    // Fallback to global store (read-only for DittoSpeechBox)
    // Note: Actions should be called through the hook, not directly from store
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

