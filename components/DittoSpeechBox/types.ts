// Simplified Ditto panel tabs
export type DittoPanelTab = 'status' | 'learn'

// Legacy types kept for backwards compatibility during migration
export type SpeechBoxView = 'hub' | 'disco' | 'transmuter' | 'manic' | 'transmuter-lockdrop' | 'boost' | 'welcome' | 'updates' | 'tx-confirmation' | 'tutorial' | 'faq'

export interface SectionComponentProps {
    onBack: () => void
}

// Deprecated - replaced by StatusCard
export interface HubRowData {
    id: SpeechBoxView
    label: string
    summary?: {
        value?: string
        label?: string
        status?: 'active' | 'inactive' | 'pending'
    }
}
