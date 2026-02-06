import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import { SpeechBoxView } from '../types'
import { DittoActivationState, DittoMessage } from '../types/dittoContract'

type DittoSpeechBoxState = {
    currentView: SpeechBoxView
    previousView?: SpeechBoxView
    isUserNavigated: boolean
    justReturnedToHub: boolean
    justManuallyNavigated: boolean
    isMinimized: boolean
    isClosed: boolean
    isOpen: boolean
    isEditPanelOpen: boolean
    // Welcome system
    hasSeenWelcome: boolean
    showWelcome: boolean
    // Timed messages (legacy)
    currentTimedMessage: string | null
    timedMessageDismissed: boolean
    // New Ditto state machine integration
    activationState: DittoActivationState
    currentDittoMessage: DittoMessage | null
    badgeCount: number
    pageId: string | null
}

type Store = {
    dittoSpeechBoxState: DittoSpeechBoxState
    setDittoSpeechBoxState: (partialState: Partial<DittoSpeechBoxState>) => void
}

const initialState: DittoSpeechBoxState = {
    currentView: 'hub',
    isUserNavigated: false,
    justReturnedToHub: false,
    justManuallyNavigated: false,
    isMinimized: false,
    isClosed: false,
    isOpen: false,
    isEditPanelOpen: false,
    // Welcome system
    hasSeenWelcome: false,
    showWelcome: false,
    // Timed messages (legacy)
    currentTimedMessage: null,
    timedMessageDismissed: false,
    // New Ditto state machine integration
    activationState: 'IDLE',
    currentDittoMessage: null,
    badgeCount: 0,
    pageId: null,
}

// @ts-ignore
const store = (set) => ({
    dittoSpeechBoxState: initialState,
    setDittoSpeechBoxState: (partialState: Partial<DittoSpeechBoxState>) =>
        set(
            (state: Store) => ({ dittoSpeechBoxState: { ...state.dittoSpeechBoxState, ...partialState } }),
            false,
            `@update/${Object.keys(partialState).join(',')}`,
        ),
})

// @ts-ignore
const useDittoSpeechBoxState = create<Store>(devtools(store, { name: 'dittoSpeechBoxState' }))

export default useDittoSpeechBoxState

