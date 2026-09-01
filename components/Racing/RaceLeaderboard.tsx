import React from 'react';
import { useBreakpointValue } from '@chakra-ui/react';
import { useCarName } from '../../services/q-racing';

// Displays a car name with fallback to ID (extracted verbatim from RaceViewer;
// the previously-closed-over rpcUrl is now an explicit prop).
const CarNameDisplay: React.FC<{ carId: string; isOwned: boolean; rpcUrl: string }> = ({ carId, isOwned, rpcUrl }) => {
    const { data: carName } = useCarName(carId, rpcUrl);

    return (
        <div style={{
            color: isOwned ? '#00ffea' : '#fff',
            fontWeight: isOwned ? 'bold' : 'normal',
            fontSize: 14
        }}>
            {carName || `Car ${carId}`}
        </div>
    );
};

interface RaceLeaderboardProps {
    leaderboardRef: React.MutableRefObject<HTMLDivElement | null>;
    topTimesWithSessions: any[] | undefined;
    ownedCars: any[] | undefined;
    rpcUrl: string;
}

const RaceLeaderboard: React.FC<RaceLeaderboardProps> = ({ leaderboardRef, topTimesWithSessions, ownedCars, rpcUrl }) => {
    // SSR-safe responsive size (no direct `window` read during render).
    const titleFontSize = useBreakpointValue({ base: 12, md: 16 }) ?? 16;
    return (
        <div ref={leaderboardRef} style={{ padding: '20px 24px', borderTop: '1px solid #2a3550', background: '#0a0f1e' }}>
            <div style={{ fontFamily: '"Press Start 2P", monospace', fontSize: titleFontSize, color: '#00ffea', marginBottom: 16 }}>
                Leaderboard (Top Times)
            </div>
            <div className="leaderboard-container">
                {/* Header */}
                <div className="leaderboard-header">
                    <div className="leaderboard-header-rank">Rank</div>
                    <div className="leaderboard-header-name">Car Name</div>
                    <div className="leaderboard-header-time">Time (ticks)</div>
                    <div className="leaderboard-header-sessions">Sessions</div>
                </div>
                {/* Entries */}
                {(topTimesWithSessions ?? []).map((t, idx) => {
                    const isOwned = ownedCars?.some(car => car.id === t.car_id) || false;
                    return (
                        <div key={t.car_id} className="leaderboard-entry">
                            <div className="leaderboard-rank">{idx + 1}</div>
                            <div className="leaderboard-name">
                                <CarNameDisplay carId={t.car_id} isOwned={isOwned} rpcUrl={rpcUrl} />
                            </div>
                            <div className="leaderboard-time">{t.time}</div>
                            <div className="leaderboard-sessions">{t.sessions}</div>
                        </div>
                    );
                })}
                {(!topTimesWithSessions || topTimesWithSessions.length === 0) && (
                    <div className="leaderboard-empty">No times yet.</div>
                )}
            </div>
        </div>
    );
};

export default RaceLeaderboard;
