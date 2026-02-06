import { create } from 'zustand'
import { TutorialStep, FAQItem } from './usePageTutorial'

interface TutorialStore {
    steps: TutorialStep[]
    faq: FAQItem[]
    currentStep: number
    isFirstStep: boolean
    isLastStep: boolean
    totalSteps: number
    isTutorialOpen: boolean
    setTutorialData: (data: {
        steps: TutorialStep[]
        faq: FAQItem[]
        currentStep: number
        isFirstStep: boolean
        isLastStep: boolean
        totalSteps: number
    }) => void
    setCurrentStep: (step: number) => void
    setIsTutorialOpen: (open: boolean) => void
    nextStep: () => void
    previousStep: () => void
    finishTutorial: () => void
    skipTutorial: () => void
    startTutorial: () => void
    // Action callbacks registered by the hook
    registerActions: (actions: {
        startTutorial: () => void
        nextStep: () => void
        previousStep: () => void
        finishTutorial: () => void
        skipTutorial: () => void
    }) => void
}

export const useTutorialStore = create<TutorialStore>((set, get) => {
    let registeredActions: {
        startTutorial: () => void
        nextStep: () => void
        previousStep: () => void
        finishTutorial: () => void
        skipTutorial: () => void
    } | null = null

    return {
        steps: [],
        faq: [],
        currentStep: 0,
        isFirstStep: true,
        isLastStep: false,
        totalSteps: 0,
        isTutorialOpen: false,
        setTutorialData: (data) => set(data),
        setCurrentStep: (step) => {
            const state = get()
            set({
                currentStep: step,
                isFirstStep: step === 0,
                isLastStep: step === state.totalSteps - 1,
            })
        },
        setIsTutorialOpen: (open) => set({ isTutorialOpen: open }),
        nextStep: () => {
            if (registeredActions) {
                registeredActions.nextStep()
            } else {
                // Fallback to store-only update
                const state = get()
                if (state.currentStep < state.totalSteps - 1) {
                    const newStep = state.currentStep + 1
                    set({
                        currentStep: newStep,
                        isFirstStep: newStep === 0,
                        isLastStep: newStep === state.totalSteps - 1,
                    })
                } else {
                    get().finishTutorial()
                }
            }
        },
        previousStep: () => {
            if (registeredActions) {
                registeredActions.previousStep()
            } else {
                // Fallback to store-only update
                const state = get()
                if (state.currentStep > 0) {
                    const newStep = state.currentStep - 1
                    set({
                        currentStep: newStep,
                        isFirstStep: newStep === 0,
                        isLastStep: newStep === state.totalSteps - 1,
                    })
                }
            }
        },
        finishTutorial: () => {
            if (registeredActions) {
                registeredActions.finishTutorial()
            } else {
                set({ isTutorialOpen: false })
            }
        },
        skipTutorial: () => {
            if (registeredActions) {
                registeredActions.skipTutorial()
            } else {
                set({ isTutorialOpen: false })
            }
        },
        startTutorial: () => {
            if (registeredActions) {
                registeredActions.startTutorial()
            } else {
                set({ isTutorialOpen: true, currentStep: 0 })
            }
        },
        registerActions: (actions) => {
            registeredActions = actions
        },
    }
})
