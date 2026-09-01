import React from 'react';
import campaignConfig from '@/components/Racing/campaignConfig';
import { TEST_CONFETTI } from './raceConstants';

interface RaceHeaderProps {
    isCampaign: boolean;
    isMazeMode: boolean | '' | undefined;
    handleExitCampaign: () => void;
    startCampaign: (config: typeof campaignConfig) => void;
    triggerConfetti: () => void;
}

const ENTER_TRIALS_BUTTON_STYLE: React.CSSProperties = {
    padding: '8px 16px',
    background: '#274bff',
    color: '#fff',
    border: '2px solid #0033ff',
    borderRadius: 4,
    cursor: 'pointer',
    fontFamily: '"Press Start 2P", monospace',
    fontSize: 12,
    boxShadow: '0 0 8px #0033ff',
    marginBottom: '8px',
};

const TEST_CONFETTI_BUTTON_STYLE: React.CSSProperties = {
    padding: '8px 16px',
    background: '#d946ef',
    color: '#fff',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontFamily: '"Press Start 2P", monospace',
    fontSize: '10px',
};

const RaceHeader: React.FC<RaceHeaderProps> = ({ isCampaign, isMazeMode, handleExitCampaign, startCampaign, triggerConfetti }) => {
    return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 18px', borderBottom: '2px solid #0033ff', background: '#0a0f1e', position: 'relative' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {isCampaign && (
                    <button type="button" onClick={handleExitCampaign} style={{ background: 'transparent', color: '#00ffea', border: 'none', cursor: 'pointer', fontFamily: '"Press Start 2P", monospace', fontSize: 14 }}>←</button>
                )}
                <div style={{
                    fontFamily: '"Press Start 2P", monospace',
                    fontSize: 16,
                    color: isMazeMode ? '#8b5cf6' : '#00ffea',
                    letterSpacing: 1
                }}
                    onClick={isCampaign ? handleExitCampaign : undefined}
                    onKeyDown={isCampaign ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            handleExitCampaign();
                        }
                    } : undefined}
                    role={isCampaign ? 'button' : undefined}
                    tabIndex={isCampaign ? 0 : undefined}
                >
                    {isMazeMode ? 'MAZE RUNNERS' : isCampaign ? 'EXIT TRIALS' : 'SELF-DRIVEN'}
                </div>
            </div>
            {!isCampaign && (
                <div style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)' }}>
                    <button
                        type="button"
                        onClick={() => startCampaign(campaignConfig)}
                        style={ENTER_TRIALS_BUTTON_STYLE}
                    >
                        Enter the Trials
                    </button>
                </div>
            )}
            {/* Test confetti button */}
            {TEST_CONFETTI && (
                <button
                    type="button"
                    onClick={triggerConfetti}
                    style={TEST_CONFETTI_BUTTON_STYLE}
                >
                    Test Confetti
                </button>
            )}
        </div>
    );
};

export default RaceHeader;
