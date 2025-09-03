import { useState, useCallback } from 'react'
import useAppState from '@/persisted-state/useAppState'
import { TutorialStep } from './TutorialOverlay'

// Default tutorial steps - can be easily modified
export const defaultTutorialSteps: TutorialStep[] = [
    {
        id: 'welcome',
        title: 'Welcome to Maze Runners!',
        content: 'Congratulations on minting your first Maze Runner! Nurture its brain to become the best in the world.',
        position: 'right',
        targetTab: 'car',
    },
    {
        id: 'energy',
        title: 'Energy System',
        content: 'Your Runner uses energy to train. Energy regenerates over time, but you can also refill it manually for a fee. Keep an eye on your energy levels!',
        position: 'left',
        targetTab: 'car',
    },
    {
        id: 'racing',
        title: 'How to Train',
        content: 'Switch to the Race tab to train your Runner on the slew of tracks. Each track has a leaderboard for you to compete against other runners.',
        position: 'right',
        targetTab: 'race',
    },
    {
        id: 'tracks',
        title: 'Track Creation',
        content: 'Create your own tracks in the Create Track tab. Design unique layouts and share them with the community!',
        position: 'left',
        targetTab: 'create',
    },
    {
        id: 'traits',
        title: 'Maze Running',
        content: 'Mazes are generated on a regular cadence. Train your Runner to complete the maze and earn $BYTE.',
        position: 'top',
        targetTab: undefined,
    },
]

export const useTutorial = (setTab?: (tab: 'car' | 'race' | 'create') => void) => {
    const { appState, setAppState } = useAppState()
    const [isTutorialOpen, setIsTutorialOpen] = useState(false)
    const [currentStep, setCurrentStep] = useState(0)

    const startTutorial = useCallback(() => {
        setCurrentStep(0)
        setIsTutorialOpen(true)

        // Switch to the first step's target tab
        const firstStep = defaultTutorialSteps[0]
        if (firstStep.targetTab && setTab) {
            setTab(firstStep.targetTab)
        }
    }, [setTab])

    const nextStep = useCallback(() => {
        const nextStepIndex = currentStep + 1
        setCurrentStep(nextStepIndex)

        // Switch tab if the next step has a target tab
        if (nextStepIndex < defaultTutorialSteps.length) {
            const nextStepData = defaultTutorialSteps[nextStepIndex]
            if (nextStepData.targetTab && setTab) {
                setTab(nextStepData.targetTab)
            }
        }
    }, [currentStep, setTab])

    const previousStep = useCallback(() => {
        const prevStepIndex = Math.max(0, currentStep - 1)
        setCurrentStep(prevStepIndex)

        // Switch tab if the previous step has a target tab
        if (prevStepIndex < defaultTutorialSteps.length) {
            const prevStepData = defaultTutorialSteps[prevStepIndex]
            if (prevStepData.targetTab && setTab) {
                setTab(prevStepData.targetTab)
            }
        }
    }, [currentStep, setTab])

    const closeTutorial = useCallback(() => {
        setIsTutorialOpen(false)
        setAppState({
            hasCompletedTutorial: true,
            tutorialStep: 0
        })
    }, [setAppState])

    const skipTutorial = useCallback(() => {
        setIsTutorialOpen(false)
        setAppState({
            hasCompletedTutorial: true,
            tutorialStep: 0
        })
    }, [setAppState])

    const resetTutorial = useCallback(() => {
        setAppState({
            hasCompletedTutorial: false,
            tutorialStep: 0
        })
    }, [setAppState])

    // New function to trigger tutorial after successful mint
    const triggerTutorialAfterMint = useCallback(() => {
        console.log('Triggering tutorial after successful mint...')
        setAppState({ hasMintedFirstCar: true })
        // Start tutorial with a small delay to ensure state is updated
        setTimeout(() => {
            startTutorial()
        }, 1000)
    }, [setAppState, startTutorial])

    const shouldShowPreMintGuidance = !appState.hasSeenPreMintGuidance
    const shouldShowTutorial = appState.hasMintedFirstCar && !appState.hasCompletedTutorial

    return {
        // State
        isTutorialOpen,
        currentStep,
        shouldShowPreMintGuidance,
        shouldShowTutorial,
        hasCompletedTutorial: appState.hasCompletedTutorial,

        // Actions
        startTutorial,
        nextStep,
        previousStep,
        closeTutorial,
        skipTutorial,
        resetTutorial,
        triggerTutorialAfterMint, // New function

        // Data
        steps: defaultTutorialSteps,
    }
}
