import React from 'react';
import { JsonRaceResult } from '@/services/q-racing';
import { CampaignRaceUnlock, CampaignStepModal } from '@/persisted-state/useRacingCampaign';

interface UseRaceViewerActionsParams {
    // exit
    endCampaign: () => void;
    setShowTraining: React.Dispatch<React.SetStateAction<boolean>>;
    setModalQueue: React.Dispatch<React.SetStateAction<CampaignStepModal[]>>;
    setActiveModal: React.Dispatch<React.SetStateAction<CampaignStepModal | null>>;
    progress: any;
    // playback
    playing: boolean;
    log: any;
    tickRef: React.MutableRefObject<number>;
    setPlaying: React.Dispatch<React.SetStateAction<boolean>>;
    leaderboardRef: React.MutableRefObject<HTMLDivElement | null>;
    // show latest race
    carRecentRaces: JsonRaceResult[] | undefined;
    setSelectedRace: React.Dispatch<React.SetStateAction<JsonRaceResult | null>>;
    setSelectedTrackId: React.Dispatch<React.SetStateAction<string | undefined>>;
    setTickDisplay: React.Dispatch<React.SetStateAction<number>>;
    isMazeMode: boolean | '' | undefined;
    triggerConfetti: () => void;
    refetchTrainingStats: () => any;
    refetchTopTimes: () => any;
    refetchTopTimesWithSessions: () => any;
    // race success (campaign)
    isCampaign: boolean;
    selectedTrackId: string | undefined;
    incrementRaceCountForTrack: (trackId: string) => void;
    config: any;
    applyUnlocks: (unlocks: any) => void;
    showTraining: boolean;
    trackIqPercent: number;
    setShowcaseMode: (v: boolean) => void;
    setShowShowcaseDialogue: React.Dispatch<React.SetStateAction<boolean>>;
    // advance modal
    modalQueue: CampaignStepModal[];
    activeModal: CampaignStepModal | null;
    nextTrack: () => void;
    updateRouteQuery: (updates: { carId?: string; trackId?: string }) => void;
}

const replay = () => {
    // Dispatch KeyR event to trigger the proper replay logic
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR' }));
};

// Extracted verbatim from RaceViewer: the imperative action handlers (exit,
// play/replay, scroll, show-latest-race, campaign race-success, modal advance).
// These contain no React hooks, so relocation does not affect hook order.
export default function useRaceViewerActions({
    endCampaign,
    setShowTraining,
    setModalQueue,
    setActiveModal,
    progress,
    playing,
    log,
    tickRef,
    setPlaying,
    leaderboardRef,
    carRecentRaces,
    setSelectedRace,
    setSelectedTrackId,
    setTickDisplay,
    isMazeMode,
    triggerConfetti,
    refetchTrainingStats,
    refetchTopTimes,
    refetchTopTimesWithSessions,
    isCampaign,
    selectedTrackId,
    incrementRaceCountForTrack,
    config,
    applyUnlocks,
    showTraining,
    trackIqPercent,
    setShowcaseMode,
    setShowShowcaseDialogue,
    modalQueue,
    activeModal,
    nextTrack,
    updateRouteQuery,
}: UseRaceViewerActionsParams) {
    const handleExitCampaign = () => {
        console.log('[RaceViewer] handleExitCampaign: disabling auto-start and ending campaign', { before: progress })
        // endCampaign now handles both active: false and autoStartEnabled: false
        endCampaign();
        setShowTraining(true);
        setModalQueue([]);
        setActiveModal(null);
        console.log('[RaceViewer] handleExitCampaign: after', { after: progress })
    };

    const togglePlay = () => {
        // If we're at the end of the race and clicking start, restart first
        if (!playing && log && tickRef.current >= log.length - 1) {
            // Replay the race first
            replay();
            // Then start playing
            setPlaying(true);
        } else {
            setPlaying(p => !p);
        }
    };

    const scrollToLeaderboard = () => {
        if (leaderboardRef.current) {
            leaderboardRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    };

    // Function to show the latest race
    const showLatestRace = () => {
        // Add a small delay to ensure queries are refreshed
        setTimeout(() => {
            if (carRecentRaces && carRecentRaces.length > 0) {
                const latest = carRecentRaces[carRecentRaces.length - 1];
                setSelectedRace(latest);
                setSelectedTrackId(latest.track_id);
                // Reset race playback to beginning and start playing
                if (tickRef.current) {
                    tickRef.current = 0;
                    setTickDisplay(0);
                }
                // Start playing the new race after successful RunRace transaction
                setPlaying(true);

                // Trigger confetti if in maze mode
                if (isMazeMode) {
                    triggerConfetti();
                }

                // Manually refetch training stats and top times to ensure fresh data
                setTimeout(() => {
                    refetchTrainingStats();
                    refetchTopTimes();
                    refetchTopTimesWithSessions();
                }, 1000); // Additional delay to ensure blockchain state is updated
            }
        }, 500); // 500ms delay to allow queries to refresh
    };

    // Campaign-aware success callback for useRunRace
    const handleRaceSuccess = () => {
        console.log('[RaceViewer] Race success callback triggered', { isCampaign, selectedTrackId });

        // Always show the latest race
        showLatestRace();

        // Handle campaign-specific logic only if in campaign mode
        if (isCampaign && selectedTrackId) {
            console.log('[RaceViewer] Processing campaign race success', { trackId: selectedTrackId });

            // Increment race count for this specific track
            incrementRaceCountForTrack(selectedTrackId);

            // Get current track config
            const curr = config?.tracks?.[progress.currentIndex];
            if (!curr) return;

            // Get current race count for this track
            const currentRaceCount = progress.racesPerTrack[selectedTrackId] || 0;
            console.log('[RaceViewer] Current race count for track', { trackId: selectedTrackId, count: currentRaceCount });

            // Apply race count-based unlocks
            if (curr.unlocksOnRace) {
                if (Array.isArray(curr.unlocksOnRace)) {
                    curr.unlocksOnRace.forEach((raceUnlock: CampaignRaceUnlock) => {
                        console.log('[RaceViewer] Checking unlock', {
                            requiredRaceCount: raceUnlock.raceCount,
                            currentRaceCount,
                            matches: raceUnlock.raceCount === currentRaceCount
                        });
                        if (raceUnlock.raceCount === currentRaceCount) {
                            console.log('[RaceViewer] Applying race unlock', { raceCount: currentRaceCount, unlocks: raceUnlock.unlocks });
                            applyUnlocks(raceUnlock.unlocks);
                        }
                    });
                } else {
                    // Legacy format - apply after every race
                    console.log('[RaceViewer] Applying legacy race unlock', curr.unlocksOnRace);
                    applyUnlocks(curr.unlocksOnRace);
                }
            }

            // Queue modals based on race count
            const queue: CampaignStepModal[] = [];
            if (curr.afterEachRaceModals && curr.afterEachRaceModals.length) {
                curr.afterEachRaceModals.forEach((modal: CampaignStepModal) => {
                    if (modal.raceCount !== undefined) {
                        if (modal.raceCount === currentRaceCount) {
                            queue.push(modal);
                        }
                    } else {
                        // If no raceCount specified, show after every race (backward compatibility)
                        queue.push(modal);
                    }
                });
            }

            // Switch to showcase if IQ target met
            const target = curr.iqTargetPercent ?? 100;
            if (showTraining && trackIqPercent >= target) {
                setShowTraining(false);
                setShowcaseMode(true);
                setShowShowcaseDialogue(true);
            }

            // If in showcase now, detect completion (winner) - this will be handled when the race result is processed
            // The completion logic will be in the useEffect that processes selectedRace

            if (queue.length) {
                setModalQueue(queue);
                setActiveModal(queue[0]);
                if (queue[0].showConfetti) triggerConfetti();
            }
        }
    };

    const advanceModal = () => {
        if (!modalQueue.length) { setActiveModal(null); return; }
        const nextIdx = modalQueue.findIndex(m => m.id === activeModal?.id) + 1;
        if (nextIdx < modalQueue.length) {
            const m = modalQueue[nextIdx];
            setActiveModal(m);
            if (m.showConfetti) triggerConfetti();
        } else {
            const last = activeModal;
            setActiveModal(null);
            setModalQueue([]);
            if (last?.navigateTo?.trackId) {
                nextTrack();
                setSelectedTrackId(last.navigateTo.trackId);
                updateRouteQuery({ trackId: last.navigateTo.trackId });
            }
        }
    };

    return {
        handleExitCampaign,
        togglePlay,
        replay,
        scrollToLeaderboard,
        showLatestRace,
        handleRaceSuccess,
        advanceModal,
    };
}
