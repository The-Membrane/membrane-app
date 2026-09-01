import React, { useEffect } from 'react';
import { JsonRaceResult } from '@/services/q-racing';
import { CampaignStepModal } from '@/persisted-state/useRacingCampaign';

interface UseRaceCampaignCompletionParams {
    isCampaign: boolean;
    selectedRace: JsonRaceResult | null;
    selectedTrackId: string | undefined;
    showTraining: boolean;
    config: any;
    progress: any;
    selectedCarId: string;
    applyUnlocks: (unlocks: any) => void;
    setModalQueue: React.Dispatch<React.SetStateAction<CampaignStepModal[]>>;
    setActiveModal: React.Dispatch<React.SetStateAction<CampaignStepModal | null>>;
    triggerConfetti: () => void;
    markCampaignCompleted: () => void;
}

// Extracted verbatim from RaceViewer: detects a showcase-mode win, applies
// completion unlocks/modals, and marks the campaign complete on the last track.
// Behaviour-identical relocation (effect order preserved).
export default function useRaceCampaignCompletion({
    isCampaign,
    selectedRace,
    selectedTrackId,
    showTraining,
    config,
    progress,
    selectedCarId,
    applyUnlocks,
    setModalQueue,
    setActiveModal,
    triggerConfetti,
    markCampaignCompleted,
}: UseRaceCampaignCompletionParams) {
    // Handle campaign completion detection (when race is won in showcase mode)
    // no-pass-live-state-to-parent FP: win-detection event (keyed on selectedRace) writes campaignConfig-derived modals into the caller's own setters — a discrete event effect, not continuous upward mirroring.
    useEffect(() => {
        if (!isCampaign || !selectedRace || !selectedTrackId || showTraining) return;
        const curr = config?.tracks?.[progress.currentIndex];
        if (!curr) return;

        // Check if car won in showcase mode
        const carWon = Array.isArray(selectedRace.winner_ids) && selectedCarId && selectedRace.winner_ids.includes(selectedCarId);
        if (carWon) {
            console.log('[RaceViewer] Car won in showcase mode - handling completion', { trackId: selectedTrackId });

            // Apply completion unlocks
            if (curr.unlocksOnCompletion) {
                console.log('[RaceViewer] Applying completion unlocks', curr.unlocksOnCompletion);
                applyUnlocks(curr.unlocksOnCompletion);
            }

            // Queue completion modals
            if (curr.onCompletionModals && curr.onCompletionModals.length && curr.onCompletionModals[0].title !== '' && curr.onCompletionModals[0].body !== '') {
                console.log('[RaceViewer] Queueing completion modals', curr.onCompletionModals);
                setModalQueue(curr.onCompletionModals);
                setActiveModal(curr.onCompletionModals[0]);
                if (curr.onCompletionModals[0].showConfetti) triggerConfetti();
            }

            // Check if this is the last track in the campaign
            const isLastTrack = config && progress.currentIndex === config.tracks.length - 1;
            if (isLastTrack) {
                console.log('[RaceViewer] Last track completed, marking campaign as completed');
                markCampaignCompleted();
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isCampaign, selectedRace, showTraining]);
}
