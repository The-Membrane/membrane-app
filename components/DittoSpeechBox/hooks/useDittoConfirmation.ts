import { useCallback, useEffect, useRef } from 'react'
import { create } from 'zustand'
import { Action } from '@/types/tx'
import useDittoSpeechBoxState from './useDittoSpeechBoxState'

export type ConfirmationView = 'loading' | 'confirm' | 'success' | 'error'

interface ConfirmationState {
    isActive: boolean
    view: ConfirmationView
    action: Action | null
    children: React.ReactNode | null
    label: string
    actionType: string // For acknowledgement messages
    previousView: string // To restore after confirmation
}

interface ConfirmationStore {
    state: ConfirmationState
    setState: (partialState: Partial<ConfirmationState>) => void
    reset: () => void
}

const initialState: ConfirmationState = {
    isActive: false,
    view: 'confirm',
    action: null,
    children: null,
    label: 'Confirm',
    actionType: 'action',
    previousView: 'hub',
}

const useConfirmationStore = create<ConfirmationStore>((set) => ({
    state: initialState,
    setState: (partialState) =>
        set((s) => ({ state: { ...s.state, ...partialState } })),
    reset: () => set(() => ({ state: initialState })),
}))

/**
 * Hook to manage transaction confirmation flow within Ditto
 */
export const useDittoConfirmation = () => {
    const { state, setState, reset } = useConfirmationStore()
    const { dittoSpeechBoxState, setDittoSpeechBoxState } = useDittoSpeechBoxState()
    const hasOpenedRef = useRef(false)

    // Open confirmation in Ditto
    const openConfirmation = useCallback((
        action: Action,
        children: React.ReactNode,
        options?: { label?: string; actionType?: string }
    ) => {
        const currentView = dittoSpeechBoxState.currentView

        setState({
            isActive: true,
            view: 'confirm',
            action,
            children,
            label: options?.label || 'Confirm',
            actionType: options?.actionType || 'action',
            previousView: currentView === 'tx-confirmation' ? 'hub' : currentView,
        })

        // Open Ditto and switch to confirmation view
        setDittoSpeechBoxState({
            currentView: 'tx-confirmation',
            isOpen: true,
            isClosed: false,
        })

        // Trigger simulate refetch
        setTimeout(() => action?.simulate.refetch(), 0)
    }, [dittoSpeechBoxState.currentView, setState, setDittoSpeechBoxState])

    // Close confirmation and return to previous view
    const closeConfirmation = useCallback(() => {
        const prevView = state.previousView as any

        // Reset the transaction if pending
        state.action?.tx.reset()

        setDittoSpeechBoxState({
            currentView: prevView || 'hub',
        })

        reset()
    }, [state.previousView, state.action, setDittoSpeechBoxState, reset])

    // Execute the transaction
    const confirmTransaction = useCallback(() => {
        if (!state.action) return

        state.action.tx.mutate()
    }, [state.action])

    // Watch for transaction state changes
    useEffect(() => {
        if (!state.action || !state.isActive) return

        const { tx } = state.action

        // Update view based on transaction state
        if (tx.isPending) {
            setState({ view: 'loading' })
        } else if (tx.isSuccess) {
            setState({ view: 'success' })
        } else if (tx.isError) {
            setState({ view: 'error' })
        } else {
            setState({ view: 'confirm' })
        }
    }, [
        state.action?.tx.isPending,
        state.action?.tx.isSuccess,
        state.action?.tx.isError,
        state.isActive,
        setState,
    ])

    // Computed values
    const isLoading = state.action?.simulate.isLoading || state.action?.tx.isPending
    const canConfirm = !state.action?.simulate.isError && !!state.action?.simulate.data && !isLoading
    const simulateError = state.action?.simulate.isError ? state.action.simulate.error : null
    const txError = state.action?.tx.isError ? state.action.tx.error : null
    const txData = state.action?.tx.isSuccess ? state.action.tx.data : null

    return {
        // State
        isActive: state.isActive,
        view: state.view,
        action: state.action,
        children: state.children,
        label: state.label,
        actionType: state.actionType,

        // Computed
        isLoading,
        canConfirm,
        simulateError,
        txError,
        txData,
        isApproved: state.action?.tx.isApproved || false,
        isPending: state.action?.tx.isPending || false,
        isSuccess: state.action?.tx.isSuccess || false,

        // Actions
        openConfirmation,
        closeConfirmation,
        confirmTransaction,
        reset,
    }
}

