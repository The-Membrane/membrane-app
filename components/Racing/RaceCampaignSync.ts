import React, { useEffect } from 'react';
import campaignConfig from '@/components/Racing/campaignConfig';

interface UseRaceCampaignSyncParams {
    config: any;
    setConfig: (c: any) => void;
    isCampaign: boolean;
    progress: any;
    selectedTrackId: string | undefined;
    setSelectedTrackId: React.Dispatch<React.SetStateAction<string | undefined>>;
    updateRouteQuery: (updates: { carId?: string; trackId?: string }) => void;
    lastProcessedRaceRef: React.MutableRefObject<string | null>;
    racingState: any;
    setRacingState: (s: any) => void;
    showTraining: boolean;
    setShowTraining: React.Dispatch<React.SetStateAction<boolean>>;
    showPvp: boolean;
    setShowPvp: React.Dispatch<React.SetStateAction<boolean>>;
}

// Extracted verbatim from RaceViewer: seeds the campaign config once, syncs the
// selected track to campaign progress, and mirrors external racingState changes
// into local state. Behaviour-identical relocation (effect order preserved).
export default function useRaceCampaignSync({
    config,
    setConfig,
    isCampaign,
    progress,
    selectedTrackId,
    setSelectedTrackId,
    updateRouteQuery,
    lastProcessedRaceRef,
    racingState,
    setRacingState,
    showTraining,
    setShowTraining,
    showPvp,
    setShowPvp,
}: UseRaceCampaignSyncParams) {
    // Initialize campaign config once
    // no-pass-live-state-to-parent FP: setConfig is the caller's (RaceViewer) own setter and campaignConfig is a static import — a one-time seed, not live state mirrored up.
    useEffect(() => {
        if (!config) setConfig(campaignConfig);
    }, [config, setConfig]);

    // Sync selected track with campaign when active
    // no-pass-live-state-to-parent FP: syncs external campaign progress into the caller's own selectedTrackId; state already lives at RaceViewer, so this is a sync, not upward mirroring.
    useEffect(() => {
        if (isCampaign && progress.currentTrackId && progress.currentTrackId !== selectedTrackId) {
            setSelectedTrackId(progress.currentTrackId);
            updateRouteQuery({ trackId: progress.currentTrackId });
            // Reset last processed race when track changes
            lastProcessedRaceRef.current = null;
        }
        // exhaustive-deps: `updateRouteQuery` intentionally omitted. It is an unstable fn
        // (rebuilt every render in RaceRouteQuery.ts, out of scope to memoize here) that reads
        // fresh router at call time, so omitting it causes no staleness; adding it would make
        // this guarded one-shot campaign sync re-evaluate on every render. Setter/ref deps are
        // stable and add nothing, so they are omitted too to keep this extract behaviour-identical.
    }, [isCampaign, progress.currentTrackId, selectedTrackId]);

    // Sync racing state with local state. This performs side effects (setState / route
    // updates), so it must run in an effect (after commit), never in a useMemo during render.
    // no-pass-live-state-to-parent FP: consume-once handoff from the external racingState store into the caller's own setters (each field cleared back to undefined) — an external-system sync.
    useEffect(() => {
        if (racingState.selectedTrackId && racingState.selectedTrackId !== selectedTrackId) {
            setSelectedTrackId(racingState.selectedTrackId);
            updateRouteQuery({ trackId: racingState.selectedTrackId });
            setRacingState({ ...racingState, selectedTrackId: undefined });
        }
        if (racingState.showTraining !== undefined && racingState.showTraining !== showTraining) {
            setShowTraining(racingState.showTraining);
            setRacingState({ ...racingState, showTraining: undefined });
        }
        if (racingState.showPvp !== undefined && racingState.showPvp !== showPvp) {
            setShowPvp(racingState.showPvp);
            setRacingState({ ...racingState, showPvp: undefined });
        }
        // exhaustive-deps: depended on the specific racingState.* fields on purpose, NOT the whole
        // `racingState` object. This is a consume-once handoff (it writes those fields back to
        // undefined via setRacingState), so keying on the object would re-run on every unrelated
        // racingState change (e.g. energy updates) and churn against its own writes. `updateRouteQuery`
        // is likewise omitted (unstable fn, out of scope to memoize; reads fresh router at call time).
    }, [racingState.selectedTrackId, racingState.showTraining, racingState.showPvp, selectedTrackId, showTraining, showPvp]);
}
