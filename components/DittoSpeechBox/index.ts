// Components - New refactored UI
export { DittoPanel } from './DittoPanel'
export { StatusCard, ShortcutCard } from './StatusCard'

// Components - Legacy (kept for backwards compatibility)
export { DittoSpeechBox } from './DittoSpeechBox'
export { DittoSpeechBoxSection } from './DittoSpeechBoxSection'
export { EditTab } from './EditTab'
export { EditPanel } from './EditPanel'
export { DittoToast, DittoToastContainer } from './DittoToast'

// Tabs
export { StatusTab } from './tabs/StatusTab'
export { LearnTab } from './tabs/LearnTab'

// Hooks
export { useDittoSpeechBox } from './hooks/useDittoSpeechBox'
export { useDittoStateMachine } from './hooks/useDittoStateMachine'
export { useDittoMessageEngine } from './hooks/useDittoMessageEngine'
export { useDittoPage } from './hooks/useDittoPage'
export { useInteractionDetection } from './hooks/useInteractionDetection'

// Types
export * from './types'
export * from './types/dittoContract'
