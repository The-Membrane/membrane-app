import React, { useState, useCallback, useEffect } from 'react'
import useAppState from '@/persisted-state/useAppState'
import { useTutorialStore } from './useTutorialStore'

export interface TutorialStep {
    id: string
    title: string
    content: string
    targetSelector?: string
    targetElement?: HTMLElement | null
    position?: 'left' | 'right' | 'top' | 'bottom' | 'center'
}

export interface FAQItem {
    id: string
    question: string
    answer: string
}

export interface PageTutorialConfig {
    pageId: string
    steps: TutorialStep[]
    faq?: FAQItem[]
}

export const usePageTutorial = (config: PageTutorialConfig) => {
    const { appState, setAppState } = useAppState()
    const tutorialStore = useTutorialStore()
    const [isTutorialOpen, setIsTutorialOpen] = useState(false)
    const [currentStep, setCurrentStep] = useState(0)
    const wasOpenedRef = React.useRef(false)

    const seenKey = `hasSeen${config.pageId}Tutorial` as keyof typeof appState
    const completionKey = `hasCompleted${config.pageId}Tutorial` as keyof typeof appState
    const hasSeenTutorial = appState[seenKey] as boolean | undefined
    const hasCompletedTutorial = appState[completionKey] as boolean | undefined

    // Sync to global store whenever state changes (one-way: hook -> store)
    // Note: tutorialStore is a stable zustand reference, so we don't include it in deps
    useEffect(() => {
        tutorialStore.setTutorialData({
            steps: config.steps,
            faq: config.faq || [],
            currentStep,
            isFirstStep: currentStep === 0,
            isLastStep: currentStep === config.steps.length - 1,
            totalSteps: config.steps.length,
        })
        tutorialStore.setIsTutorialOpen(isTutorialOpen)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [config.steps, config.faq, currentStep, isTutorialOpen])

    const startTutorial = useCallback(() => {
        setCurrentStep(0)
        setIsTutorialOpen(true)
        wasOpenedRef.current = true
        // Mark tutorial as seen when it starts (even if not completed)
        if (!hasSeenTutorial) {
            setAppState({
                [seenKey]: true,
            })
        }
    }, [hasSeenTutorial, setAppState, seenKey])

    const finishTutorial = useCallback(() => {
        setIsTutorialOpen(false)
        setAppState({
            [completionKey]: true,
        })
    }, [setAppState, completionKey])

    const nextStep = useCallback(() => {
        setCurrentStep((prevStep) => {
            if (prevStep < config.steps.length - 1) {
                return prevStep + 1
            } else {
                // Tutorial complete
                finishTutorial()
                return prevStep
            }
        })
    }, [config.steps.length, finishTutorial])

    const previousStep = useCallback(() => {
        setCurrentStep((prevStep) => {
            if (prevStep > 0) {
                return prevStep - 1
            }
            return prevStep
        })
    }, [])

    const skipTutorial = useCallback(() => {
        setIsTutorialOpen(false)
        // Mark as seen (already done in startTutorial, but ensure it's set)
        setAppState({
            [seenKey]: true,
        })
    }, [setAppState, seenKey])

    const resetTutorial = useCallback(() => {
        setAppState({
            [seenKey]: false,
            [completionKey]: false,
        })
        setCurrentStep(0)
    }, [setAppState, seenKey, completionKey])

    // Mark tutorial as seen when it closes (user navigates away, closes Ditto, etc.)
    // Only if it was actually opened at some point
    useEffect(() => {
        if (!isTutorialOpen && wasOpenedRef.current && !hasSeenTutorial) {
            // Tutorial was opened and then closed but not marked as seen yet - mark it now
            setAppState({
                [seenKey]: true,
            })
        }
    }, [isTutorialOpen, hasSeenTutorial, setAppState, seenKey])

    // Auto-close tutorial when component unmounts (e.g., navigating away)
    useEffect(() => {
        return () => {
            if (isTutorialOpen) {
                setIsTutorialOpen(false)
            }
        }
    }, [isTutorialOpen])

    // Register actions with store so DittoSpeechBox can trigger them
    useEffect(() => {
        tutorialStore.registerActions({
            startTutorial,
            nextStep,
            previousStep,
            finishTutorial,
            skipTutorial,
        })
    }, [startTutorial, nextStep, previousStep, finishTutorial, skipTutorial, tutorialStore])

    // Note: Auto-start is disabled by default
    // Pages should call startTutorial() manually when ready
    // This allows pages to control when the tutorial starts (e.g., after Ditto is ready)

    const currentStepData = config.steps[currentStep]
    const isFirstStep = currentStep === 0
    const isLastStep = currentStep === config.steps.length - 1

    return {
        // State
        isTutorialOpen,
        currentStep,
        currentStepData,
        hasSeenTutorial: hasSeenTutorial || false,
        hasCompletedTutorial: hasCompletedTutorial || false,
        isFirstStep,
        isLastStep,
        totalSteps: config.steps.length,

        // Actions
        startTutorial,
        nextStep,
        previousStep,
        finishTutorial,
        skipTutorial,
        resetTutorial,

        // Data
        steps: config.steps,
        faq: config.faq || [],
    }
}

