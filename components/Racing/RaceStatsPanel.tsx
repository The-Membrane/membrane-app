import React from 'react';
import TrackIQMetric from './TrackIQMetric';

interface RaceStatsPanelProps {
    trackTrainingStats: any;
    track: any;
    selectedCarId: string;
    tickDisplay: number;
    log: any;
    availableTracks: any[] | undefined;
    selectedTrackId: string | undefined;
}

const RaceStatsPanel: React.FC<RaceStatsPanelProps> = ({
    trackTrainingStats,
    track,
    selectedCarId,
    tickDisplay,
    log,
    availableTracks,
    selectedTrackId,
}) => {
    return (
        <div style={{ padding: '12px 18px', borderBottom: '1px solid #2a3550', background: '#0a0f1e' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontFamily: '"Press Start 2P", monospace', fontSize: 12 }}>
                {/* Performance Stats - Always show track-specific improvement */}
                <div style={{ color: '#b8c1ff' }}>
                    Performance: {(() => {
                        const stats = trackTrainingStats?.stats;
                        // Always show training stats for the selected car + track, regardless of mode
                        const trainingStats = stats?.solo;
                        if (!trainingStats) return 'N/A';
                        const first = trainingStats.first_time;
                        const fastest = trainingStats.fastest;
                        if (!first || first === 0 || !fastest || fastest === 0 || fastest > first) return 'N/A';
                        const improvement = Math.round(((first - fastest) / first) * 100);
                        return `+${improvement}% (${trainingStats.tally} sessions)`;
                    })()}
                </div>

                {/* Track IQ Metric */}
                {track && selectedCarId && (
                    <TrackIQMetric track={track} carId={selectedCarId} />
                )}

                {/* Current Run Stats */}
                <div style={{ color: '#b8c1ff' }}>
                    Current Run: {tickDisplay}/{Math.max(0, (log?.length ?? 0) - 1)} ticks | Fastest Possible: {(() => {
                        if (availableTracks && selectedTrackId) {
                            const selectedTrack = availableTracks.find((t: any) => t.id === selectedTrackId);
                            if (selectedTrack?.fastest_tick_time) {
                                return selectedTrack.fastest_tick_time;
                            }
                        }
                        return 'N/A';
                    })()}
                </div>
            </div>
        </div>
    );
};

export default RaceStatsPanel;
