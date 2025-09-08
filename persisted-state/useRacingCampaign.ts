import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type CampaignUnlocks = {
    showRaceControls: boolean
    showTileLegend: boolean
    showAdvancedParams: boolean
    showRaceCountControl: boolean
}

export type CampaignStepModal = {
    id: string
    title: string
    body: string
    showConfetti?: boolean
    navigateTo?: { trackId?: string; path?: string }
    raceCount?: number // Optional: show modal only on specific race number
}

export type CampaignRaceUnlock = {
    raceCount: number
    unlocks: Partial<CampaignUnlocks>
}

export type CampaignTrackConfig = {
    trackId: string
    iqTargetPercent?: number
    afterEachRaceModals?: CampaignStepModal[]
    onCompletionModals?: CampaignStepModal[]
    unlocksOnRace?: CampaignRaceUnlock[] | Partial<CampaignUnlocks> // Support both formats
    unlocksOnCompletion?: Partial<CampaignUnlocks>
}

export type CampaignConfig = {
    name: string
    tracks: CampaignTrackConfig[]
}

export type CampaignProgress = {
    active: boolean
    currentIndex: number
    hasStartedTrial: boolean
    currentTrackId?: string
    // per-track progress keys
    racesRunOnTrack: number
    racesPerTrack: Record<string, number> // Track race count per track ID
    isShowcaseMode: boolean
    unlocks: CampaignUnlocks
    autoStartEnabled: boolean
    isCompleted: boolean
}

type Store = {
    config?: CampaignConfig
    progress: CampaignProgress
    setConfig: (config: CampaignConfig) => void
    startCampaign: (config?: CampaignConfig) => void
    endCampaign: () => void
    nextTrack: () => void
    incrementRaceCount: () => void
    incrementRaceCountForTrack: (trackId: string) => void
    setShowcaseMode: (isShowcase: boolean) => void
    applyUnlocks: (partial: Partial<CampaignUnlocks>) => void
    resetProgressForTrack: (trackId?: string) => void
    setAutoStartEnabled: (enabled: boolean) => void
    markCampaignCompleted: () => void
}

const defaultUnlocks: CampaignUnlocks = {
    showRaceControls: false,
    showTileLegend: false,
    showAdvancedParams: false,
    showRaceCountControl: false,
}

const initialProgress: CampaignProgress = {
    active: false,
    currentIndex: 0,
    hasStartedTrial: false,
    currentTrackId: undefined,
    racesRunOnTrack: 0,
    racesPerTrack: {},
    isShowcaseMode: false,
    unlocks: { ...defaultUnlocks },
    autoStartEnabled: true,
    isCompleted: false,
}

const useRacingCampaign = create<Store>()(
    persist(
        (set, get) => ({
            config: undefined,
            progress: initialProgress,
            setConfig: (config) => set({ config }),
            startCampaign: (config) => {
                const cfg = config ?? get().config
                const firstTrackId = cfg?.tracks?.[0]?.trackId
                console.log('[Campaign] startCampaign called', { firstTrackId, hasConfig: !!cfg })
                set({
                    config: cfg ?? get().config,
                    progress: {
                        active: true,
                        currentIndex: 0,
                        hasStartedTrial: false,
                        currentTrackId: firstTrackId,
                        racesRunOnTrack: 0,
                        racesPerTrack: {},
                        isShowcaseMode: false,
                        unlocks: { ...defaultUnlocks },
                        autoStartEnabled: get().progress.autoStartEnabled,
                        isCompleted: false,
                    },
                })
                console.log('[Campaign] startCampaign state', get().progress)
            },
            endCampaign: () => {
                console.log('[Campaign] endCampaign called')
                set({ progress: { ...initialProgress, active: false, autoStartEnabled: false } })
                console.log('[Campaign] endCampaign state', get().progress)
            },
            nextTrack: () => {
                const state = get()
                const nextIndex = state.progress.currentIndex + 1
                const nextCfg = state.config?.tracks?.[nextIndex]
                console.log('[Campaign] nextTrack', { nextIndex, nextTrackId: nextCfg?.trackId })
                set({
                    progress: {
                        active: !!state.progress.active,
                        currentIndex: nextIndex,
                        hasStartedTrial: false,
                        currentTrackId: nextCfg?.trackId,
                        racesRunOnTrack: 0,
                        racesPerTrack: { ...state.progress.racesPerTrack }, // Keep existing per-track counts
                        isShowcaseMode: false,
                        unlocks: { ...defaultUnlocks },
                        autoStartEnabled: state.progress.autoStartEnabled,
                        isCompleted: false,
                    },
                })
                console.log('[Campaign] nextTrack state', get().progress)
            },
            incrementRaceCount: () => set((s) => {
                const next = { ...s.progress, hasStartedTrial: true, racesRunOnTrack: s.progress.racesRunOnTrack + 1 }
                console.log('[Campaign] incrementRaceCount', {
                    from: s.progress.racesRunOnTrack,
                    to: next.racesRunOnTrack,
                    trackIndex: s.progress.currentIndex,
                    active: s.progress.active
                })
                return { progress: next }
            }),
            incrementRaceCountForTrack: (trackId: string) => set((s) => {
                const currentCount = s.progress.racesPerTrack[trackId] || 0;
                const newCount = currentCount + 1;
                const next = {
                    ...s.progress,
                    hasStartedTrial: true,
                    racesRunOnTrack: newCount,
                    racesPerTrack: { ...s.progress.racesPerTrack, [trackId]: newCount }
                }
                console.log('[Campaign] incrementRaceCountForTrack', {
                    trackId,
                    from: currentCount,
                    to: newCount,
                    trackIndex: s.progress.currentIndex,
                    active: s.progress.active
                })
                return { progress: next }
            }),
            setShowcaseMode: (isShowcase) => set((s) => {
                const next = { ...s.progress, isShowcaseMode: isShowcase }
                console.log('[Campaign] setShowcaseMode', next)
                return { progress: next }
            }),
            applyUnlocks: (partial) => set((s) => {
                const next = { ...s.progress, unlocks: { ...s.progress.unlocks, ...partial } }
                console.log('[Campaign] applyUnlocks', next.unlocks)
                return { progress: next }
            }),
            resetProgressForTrack: (trackId) => set((s) => ({
                progress: {
                    active: s.progress.active,
                    currentIndex: s.progress.currentIndex,
                    hasStartedTrial: false,
                    currentTrackId: trackId ?? s.progress.currentTrackId,
                    racesRunOnTrack: 0,
                    racesPerTrack: { ...s.progress.racesPerTrack },
                    isShowcaseMode: false,
                    unlocks: { ...defaultUnlocks },
                    autoStartEnabled: s.progress.autoStartEnabled,
                    isCompleted: false,
                }
            })),
            setAutoStartEnabled: (enabled: boolean) => set((s) => {
                const next = { ...s.progress, autoStartEnabled: enabled }
                console.log('[Campaign] setAutoStartEnabled', next.autoStartEnabled)
                return { progress: next }
            }),
            markCampaignCompleted: () => set((s) => {
                const next = { ...s.progress, isCompleted: true }
                console.log('[Campaign] markCampaignCompleted', next.isCompleted)
                return { progress: next }
            }),
        }),
        { name: 'racingCampaign' }
    )
)

export default useRacingCampaign
