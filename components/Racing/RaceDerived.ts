import { useMemo } from 'react';
import { JsonRaceResult } from '@/services/q-racing';

interface UseRaceDerivedParams {
    trackTrainingStats: any;
    showTraining: boolean;
    showPvp: boolean;
    selectedRace: JsonRaceResult | null;
    selectedCarId: string;
    log: any;
}

// Extracted verbatim from RaceViewer: the derived improvement label and the
// total-tick computation. Behaviour-identical relocation (the totalTicks useMemo
// keeps its original position in the hook sequence).
export default function useRaceDerived({
    trackTrainingStats,
    showTraining,
    showPvp,
    selectedRace,
    selectedCarId,
    log,
}: UseRaceDerivedParams) {
    // Derive improvement label from training stats and toggles
    const { improvementLabel, sessions } = (() => {
        const stats = trackTrainingStats?.stats;
        const active = showTraining ? stats?.solo : showPvp ? stats?.pvp : undefined;
        if (!active) return { improvementLabel: '', sessions: 0 };
        const first = active.first_time;
        const fastest = active.fastest;
        if (!first || first === 0 || !fastest || fastest === 0 || fastest > first) return { improvementLabel: '', sessions: 0 };
        const improvement = Math.round(((first - fastest) / first) * 100);
        const sessions = active.tally;

        return {
            improvementLabel: `${improvement}% faster in ${sessions} training sessions`,
            sessions: sessions
        };
    })();

    // Compute total ticks from race result steps_taken for the selected car (fallbacks apply)
    const totalTicks = useMemo(() => {
        // Prefer steps_taken from selectedRace if available
        const fallbackFromLog = Math.max(0, (log?.length ?? 0) - 1);
        if (!selectedRace || !Array.isArray(selectedRace.steps_taken) || selectedRace.steps_taken.length === 0) {
            return fallbackFromLog;
        }
        // Try selected car first
        if (selectedCarId) {
            const match = selectedRace.steps_taken.find((s) => s.car_id === selectedCarId);
            if (match && typeof match.steps_taken === 'number') return match.steps_taken;
        }
        // Then try winner
        if (Array.isArray(selectedRace.winner_ids) && selectedRace.winner_ids.length > 0) {
            const win = selectedRace.steps_taken.find((s) => s.car_id === selectedRace.winner_ids[0]);
            if (win && typeof win.steps_taken === 'number') return win.steps_taken;
        }
        // Fallback to first entry in steps_taken
        const first = selectedRace.steps_taken[0];
        if (first && typeof first.steps_taken === 'number') return first.steps_taken;
        return fallbackFromLog;
    }, [selectedRace, selectedCarId, log]);

    return { improvementLabel, sessions, totalTicks };
}
