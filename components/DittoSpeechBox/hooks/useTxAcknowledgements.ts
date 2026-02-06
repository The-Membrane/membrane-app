import { useCallback } from 'react'
import { useRouter } from 'next/router'
import { create } from 'zustand'
import { getAcknowledgement, TxAcknowledgement } from '@/config/dittoMessages'
import { useDittoCompanionState } from './useDittoCompanionState'

interface TxAcknowledgementData {
    transactionHash: string
    gasUsed?: string
    code: number
    actionType: TxAcknowledgement['actionType']
    message: string
    timestamp: number
    page: string
}

interface AcknowledgementsState {
    currentAcknowledgement: TxAcknowledgementData | null
    history: TxAcknowledgementData[]
    isVisible: boolean
}

interface AcknowledgementsStore {
    state: AcknowledgementsState
    setState: (partialState: Partial<AcknowledgementsState>) => void
    addAcknowledgement: (ack: TxAcknowledgementData) => void
    dismiss: () => void
    reset: () => void
}

const initialState: AcknowledgementsState = {
    currentAcknowledgement: null,
    history: [],
    isVisible: false,
}

const useAcknowledgementsStore = create<AcknowledgementsStore>((set) => ({
    state: initialState,
    setState: (partialState) =>
        set((s) => ({ state: { ...s.state, ...partialState } })),
    addAcknowledgement: (ack) =>
        set((s) => ({
            state: {
                ...s.state,
                currentAcknowledgement: ack,
                history: [ack, ...s.state.history.slice(0, 49)], // Keep last 50
                isVisible: true,
            },
        })),
    dismiss: () =>
        set((s) => ({
            state: {
                ...s.state,
                currentAcknowledgement: null,
                isVisible: false,
            },
        })),
    reset: () => set(() => ({ state: initialState })),
}))

/**
 * Hook to manage transaction acknowledgements
 */
export const useTxAcknowledgements = () => {
    const router = useRouter()
    const { state, addAcknowledgement, dismiss, reset } = useAcknowledgementsStore()
    const { recordInteraction } = useDittoCompanionState()

    // Show acknowledgement for a successful transaction
    const showAcknowledgement = useCallback((
        txData: {
            transactionHash: string
            gasUsed?: string | number
            code: number
        },
        actionType: TxAcknowledgement['actionType']
    ) => {
        const page = router.pathname
        const message = getAcknowledgement(actionType, page)

        const ackData: TxAcknowledgementData = {
            transactionHash: txData.transactionHash,
            gasUsed: txData.gasUsed?.toString(),
            code: txData.code,
            actionType,
            message,
            timestamp: Date.now(),
            page,
        }

        addAcknowledgement(ackData)
        recordInteraction('action_completed', { actionType, hash: txData.transactionHash })
    }, [router.pathname, addAcknowledgement, recordInteraction])

    // Dismiss the current acknowledgement
    const dismissAcknowledgement = useCallback(() => {
        dismiss()
    }, [dismiss])

    // Get the most recent acknowledgement
    const getRecentAcknowledgement = useCallback((withinMs: number = 30000) => {
        if (!state.history.length) return null

        const recent = state.history[0]
        if (Date.now() - recent.timestamp < withinMs) {
            return recent
        }
        return null
    }, [state.history])

    // Check if an acknowledgement is currently showing
    const isAcknowledgementShowing = state.isVisible && state.currentAcknowledgement !== null

    return {
        // State
        currentAcknowledgement: state.currentAcknowledgement,
        history: state.history,
        isVisible: state.isVisible,
        isAcknowledgementShowing,

        // Actions
        showAcknowledgement,
        dismissAcknowledgement,
        getRecentAcknowledgement,
        reset,
    }
}

/**
 * Determine action type from transaction context
 * This can be used to infer the action type from the message content
 */
export const inferActionType = (
    msgType: string,
    context?: { page?: string; label?: string }
): TxAcknowledgement['actionType'] => {
    const msgTypeLower = msgType.toLowerCase()
    const labelLower = context?.label?.toLowerCase() || ''
    const pageLower = context?.page?.toLowerCase() || ''

    // Check label first (most specific)
    if (labelLower.includes('deposit')) return 'deposit'
    if (labelLower.includes('withdraw')) return 'withdraw'
    if (labelLower.includes('loop')) return 'loop'
    if (labelLower.includes('stake')) return 'stake'
    if (labelLower.includes('unstake')) return 'unstake'
    if (labelLower.includes('swap')) return 'swap'
    if (labelLower.includes('lock')) return 'lock'
    if (labelLower.includes('unlock')) return 'unlock'
    if (labelLower.includes('mint')) return 'mint'

    // Check message type
    if (msgTypeLower.includes('deposit')) return 'deposit'
    if (msgTypeLower.includes('withdraw')) return 'withdraw'
    if (msgTypeLower.includes('stake')) return 'stake'
    if (msgTypeLower.includes('unstake')) return 'unstake'
    if (msgTypeLower.includes('swap')) return 'swap'
    if (msgTypeLower.includes('lock')) return 'lock'
    if (msgTypeLower.includes('unlock')) return 'unlock'
    if (msgTypeLower.includes('mint')) return 'mint'

    // Check page context
    if (pageLower.includes('manic')) return 'deposit'
    if (pageLower.includes('disco')) return 'deposit'
    if (pageLower.includes('transmuter')) return 'swap'
    if (pageLower.includes('stake')) return 'stake'

    // Default
    return 'deposit'
}

