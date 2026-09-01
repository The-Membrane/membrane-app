import React from 'react';

interface RaceCarRankProps {
    selectedCarId: string;
    topTimes: any[] | undefined;
    scrollToLeaderboard: () => void;
}

const RANK_BADGE_STYLE: React.CSSProperties = {
    color: '#00ffea',
    fontSize: 16,
    fontWeight: 'bold',
    padding: '8px 12px',
    background: 'rgba(0, 255, 234, 0.1)',
    border: '1px solid #00ffea',
    borderRadius: '4px',
    cursor: 'pointer',
    transition: 'background-color 0.2s ease, transform 0.2s ease',
    display: 'inline-block'
};

const RaceCarRank: React.FC<RaceCarRankProps> = ({ selectedCarId, topTimes, scrollToLeaderboard }) => {
    if (selectedCarId && topTimes) {
        const carRank = topTimes.findIndex(t => t.car_id === selectedCarId);
        return (
            <div style={{ background: '#0a0f1e', width: '100%', display: 'flex', justifyContent: 'center' }}>
                <div style={{ padding: '12px 18px', background: '#0a0f1e' }}>
                    <button
                        type="button"
                        onClick={scrollToLeaderboard}
                        style={RANK_BADGE_STYLE}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.background = 'rgba(0, 255, 234, 0.2)';
                            e.currentTarget.style.transform = 'scale(1.05)';
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.background = 'rgba(0, 255, 234, 0.1)';
                            e.currentTarget.style.transform = 'scale(1)';
                        }}
                    >
                        Rank {carRank !== -1 ? carRank + 1 : "N/A"}
                    </button>
                </div>
            </div>
        );
    }
    return null;
};

export default RaceCarRank;
