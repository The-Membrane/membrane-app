import React from 'react';

interface RacePlaybackControlsProps {
    isCampaign: boolean;
    progress: any;
    hasRaceData: boolean;
    showControls: boolean;
    setShowControls: React.Dispatch<React.SetStateAction<boolean>>;
    togglePlay: () => void;
    playing: boolean;
    replay: () => void;
    speed: number;
    setSpeed: React.Dispatch<React.SetStateAction<number>>;
}

const SECTION_HEADER_STYLE: React.CSSProperties = {
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    color: '#00ffea',
    fontFamily: '"Press Start 2P", monospace',
    fontSize: 12,
    padding: '16px 16px 12px 16px',
    userSelect: 'none',
    transition: 'color 0.2s ease',
};

const RacePlaybackControls: React.FC<RacePlaybackControlsProps> = ({
    isCampaign,
    progress,
    hasRaceData,
    showControls,
    setShowControls,
    togglePlay,
    playing,
    replay,
    speed,
    setSpeed,
}) => {
    const toggleControls = () => setShowControls(!showControls);

    return (
        <>
            {/* Race Controls Section */}
            {(!isCampaign || progress.unlocks.showRaceControls) && (
                <div style={{ opacity: hasRaceData ? 1 : 0.5 }}>
                    <button
                        type="button"
                        onClick={toggleControls}
                        aria-expanded={showControls}
                        style={SECTION_HEADER_STYLE}
                        onMouseEnter={(e) => e.currentTarget.style.color = '#00ffff'}
                        onMouseLeave={(e) => e.currentTarget.style.color = '#00ffea'}
                    >
                        <span style={{ fontSize: 14, transition: 'transform 0.2s ease', transform: showControls ? 'rotate(0deg)' : 'rotate(-90deg)' }}>▼</span>
                        <span>RACE CONTROLS</span>
                    </button>
                    {showControls && (
                        <div style={{ padding: '0 16px 16px 16px' }}>
                            <div style={{ display: 'flex', gap: 16, alignItems: 'center', justifyContent: 'center', color: '#fff', fontFamily: '"Press Start 2P", monospace', fontSize: 12 }}>
                                <button
                                    type="button"
                                    onClick={togglePlay}
                                    style={{ padding: '10px 18px', background: playing ? '#ff2d2d' : '#274bff', color: '#fff', border: '2px solid #0033ff', cursor: 'pointer', boxShadow: '0 0 8px #0033ff', letterSpacing: 1 }}>
                                    {playing ? 'PAUSE' : 'START'}
                                </button>
                                <button
                                    type="button"
                                    onClick={replay}
                                    style={{ padding: '10px 18px', background: '#274bff', color: '#fff', border: '2px solid #0033ff', cursor: 'pointer', boxShadow: '0 0 8px #0033ff', letterSpacing: 1 }}>
                                    REPLAY
                                </button>
                                <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                    Speed:
                                    <select
                                        value={speed}
                                        onChange={e => setSpeed(parseFloat(e.target.value))}
                                        style={{ background: '#0a0f1e', color: '#fff', border: '2px solid #0033ff', fontFamily: 'inherit', fontSize: 12, padding: '6px 8px', boxShadow: '0 0 8px #0033ff inset' }}>
                                        {[0.25, 0.5, 1, 2, 4].map((s: number) => (
                                            <option key={s} value={s} style={{ background: '#0a0f1e', color: '#fff' }}>{s}x</option>
                                        ))}
                                    </select>
                                </label>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </>
    );
};

export default RacePlaybackControls;
