import React, { useEffect, useMemo } from 'react';
import { NextRouter } from 'next/router';
import { JsonRaceResult } from '@/services/q-racing';

interface UseRaceSelectionParams {
    router: NextRouter;
    carRecentRaces: JsonRaceResult[] | undefined;
    setSelectedRace: React.Dispatch<React.SetStateAction<JsonRaceResult | null>>;
    setSelectedTrackId: React.Dispatch<React.SetStateAction<string | undefined>>;
    availableTracks: any[] | undefined;
    ownedCars: any[] | undefined;
    selectedCarId: string;
    setSelectedCarId: React.Dispatch<React.SetStateAction<string>>;
    updateRouteQuery: (updates: { carId?: string; trackId?: string }) => void;
    selectedTrackId: string | undefined;
    showPvp: boolean;
}

// Extracted verbatim from RaceViewer: auto-selects the most recent race, derives
// the filtered track list, and keeps the selected car/track in sync with the
// URL and loaded data. Behaviour-identical relocation (effect order preserved).
export default function useRaceSelection({
    router,
    carRecentRaces,
    setSelectedRace,
    setSelectedTrackId,
    availableTracks,
    ownedCars,
    selectedCarId,
    setSelectedCarId,
    updateRouteQuery,
    selectedTrackId,
    showPvp,
}: UseRaceSelectionParams) {
    // Always select the most recent race (last in the list)
    // no-pass-live-state-to-parent FP: syncs async React Query data (carRecentRaces) into the caller's own selectedRace/selectedTrackId — external-data sync, not a child mirroring state up.
    useEffect(() => {
        if (carRecentRaces && carRecentRaces.length > 0) {
            // The contract stores races in insertion order (newest at the end)
            // So the last race in the array should be the most recent
            const mostRecentRace = carRecentRaces[carRecentRaces.length - 1];

            // Always auto-select the latest race
            setSelectedRace(mostRecentRace);
            setSelectedTrackId(mostRecentRace.track_id);
        } else {
            setSelectedRace(null);
        }
    }, [carRecentRaces, setSelectedRace, setSelectedTrackId]);

    // Remove navigation via route; always show latest race

    // Memoized filtered tracks: PvP filtering disabled (tabled until v2)
    const filteredTracks = useMemo(() => {
        if (!availableTracks) return [] as any[];
        // if (showPvp) {
        //     return availableTracks.filter((t: any) => (t?.starting_tiles?.length ?? 0) > 1);
        // }
        return availableTracks;
    }, [availableTracks]);

    // Always auto-select the latest race - no URL-based race selection
    // This prevents circular dependencies and ensures we always show the most recent race

    // Sync selected car from URL when present
    // no-pass-live-state-to-parent FP: restores the caller's own selectedCarId from the router URL (an external system) — a sync, not upward state mirroring.
    useEffect(() => {
        const qCar = (router.query?.carId as string) || '';
        if (qCar && qCar !== selectedCarId) {
            if (!ownedCars || ownedCars.some((c) => c.id === qCar)) {
                setSelectedCarId(qCar);
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [router.query?.carId, ownedCars]);

    // Auto-select first car when ownedCars load
    // no-pass-live-state-to-parent FP: syncs async ownedCars into the caller's own selectedCarId + URL — external-data sync, not upward mirroring of a child's state.
    useEffect(() => {
        if (ownedCars && ownedCars.length > 0) {
            if (!selectedCarId || !ownedCars.some((c) => c.id === selectedCarId)) {
                const first = ownedCars[0].id;
                setSelectedCarId(first);
                updateRouteQuery({ carId: first });
            }
        } else if (selectedCarId) {
            setSelectedCarId('');
            updateRouteQuery({ carId: undefined });
        }
        // exhaustive-deps: `updateRouteQuery` intentionally omitted. It is an unstable fn (rebuilt
        // every render in RaceRouteQuery.ts, out of scope to memoize here) that reads fresh router at
        // call time, so omitting it causes no staleness; adding it would make this guarded one-shot
        // car-selection sync re-evaluate every render. `setSelectedCarId` is a stable setter.
    }, [ownedCars, selectedCarId]);

    // Auto-select first track from filtered list when none selected yet
    // no-pass-live-state-to-parent / no-pass-data-to-parent FP: tid derives from async availableTracks and feeds the caller's own selectedTrackId + URL — an owner-side external-data sync, not a child shipping generated data up.
    useEffect(() => {
        if (!selectedTrackId && filteredTracks && filteredTracks.length > 0) {
            const first = filteredTracks[0];
            if (first && first.id != null) {
                const tid = String(first.id);
                setSelectedTrackId(tid);
                updateRouteQuery({ trackId: tid });
            }
        }
        // exhaustive-deps: `updateRouteQuery` intentionally omitted (unstable fn from
        // RaceRouteQuery.ts, out of scope to memoize; reads fresh router at call time). Adding it
        // would make this guarded one-shot track-selection sync re-evaluate every render.
    }, [filteredTracks, selectedTrackId]);

    // Auto-select first available track when PvP is toggled on
    useEffect(() => {
        // This logic has been moved to the toggle button click handler
    }, [showPvp, availableTracks, selectedTrackId]);

    return filteredTracks;
}
