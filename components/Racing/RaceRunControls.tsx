import React from 'react';
import { Tooltip } from '@chakra-ui/react';
import ConfirmModal from '@/components/ConfirmModal';
import { MAX_RACE_TICKS } from './raceConstants';

interface RaceRunControlsProps {
    showTraining: boolean;
    racingState: any;
    isCampaign: boolean;
    progress: any;
    isMazeMode: boolean | '' | undefined;
    numberOfRaces: number;
    setNumberOfRaces: React.Dispatch<React.SetStateAction<number>>;
    runRace: any;
    selectedTrackId: string | undefined;
    selectedCarId: string;
    filteredTracks: any[];
}

const RACE_COUNT_BUTTON_STYLE: React.CSSProperties = {
    width: '32px',
    flex: '1',
    color: '#fff',
    border: '1px solid #0033ff',
    fontFamily: '"Press Start 2P", monospace',
    fontSize: '8px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'background-color 0.2s ease, transform 0.2s ease',
    minHeight: 0,
};

const RACE_COUNT_DISPLAY_STYLE: React.CSSProperties = {
    width: '32px',
    flex: '1',
    background: '#0a0f1e',
    color: '#00ffea',
    border: '1px solid #0033ff',
    borderRadius: '0',
    fontFamily: '"Press Start 2P", monospace',
    fontSize: '12px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: 'bold',
    minHeight: 0,
};

const RaceRunControls: React.FC<RaceRunControlsProps> = ({
    showTraining,
    racingState,
    isCampaign,
    progress,
    isMazeMode,
    numberOfRaces,
    setNumberOfRaces,
    runRace,
    selectedTrackId,
    selectedCarId,
    filteredTracks,
}) => {
    return (
        <div className="race-controls-button" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Tooltip label={showTraining && racingState.energy < 10 ? 'Not enough energy for training. Switch to Showcase or gain energy.' : ''} isDisabled={!(showTraining && racingState.energy < 10)} hasArrow placement="top" openDelay={200}>
                <span>
                    <ConfirmModal
                        executeDirectly={true}
                        label={isCampaign ? (progress.hasStartedTrial ? 'Continue Trial' : 'Begin Trial') : (isMazeMode ? `Traverse (${numberOfRaces})` : `Run Race (${numberOfRaces})`)}
                        action={runRace.action}
                        isDisabled={!selectedTrackId || !selectedCarId || (showTraining && racingState.energy < 10) || filteredTracks.length === 0}
                        isLoading={runRace.action.simulate.isPending || runRace.action.tx.isPending}
                        buttonProps={{
                            colorScheme: 'blue',
                            bg: '#274bff',
                            _hover: { bg: '#1f3bd9' },
                            fontFamily: '"Press Start 2P", monospace',
                            fontSize: { base: '12px', md: '14px' },
                            padding: { base: '12px 16px', md: '12px 24px' },
                            fontWeight: 'bold',
                            boxShadow: '0 0 12px #0033ff',
                            minH: { base: '44px', md: 'auto' },
                            w: { base: '100%', md: 'auto' }
                        }}
                    />
                </span>
            </Tooltip>

            {/* Race Count Controls */}
            {(!isCampaign || progress.unlocks.showRaceCountControl) && (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', height: '44px', justifyContent: 'stretch' }}>
                    <button
                        type="button"
                        onClick={() => setNumberOfRaces(prev => Math.min(prev + 1, MAX_RACE_TICKS))}
                        disabled={numberOfRaces >= MAX_RACE_TICKS}
                        style={{
                            ...RACE_COUNT_BUTTON_STYLE,
                            borderRadius: '4px 4px 0 0',
                            background: numberOfRaces >= MAX_RACE_TICKS ? '#333' : '#274bff',
                            cursor: numberOfRaces >= MAX_RACE_TICKS ? 'not-allowed' : 'pointer',
                            opacity: numberOfRaces >= MAX_RACE_TICKS ? 0.5 : 1,
                        }}
                        onMouseEnter={(e) => {
                            if (numberOfRaces < MAX_RACE_TICKS) {
                                e.currentTarget.style.background = '#1f3bd9';
                                e.currentTarget.style.transform = 'scale(1.05)';
                            }
                        }}
                        onMouseLeave={(e) => {
                            if (numberOfRaces < MAX_RACE_TICKS) {
                                e.currentTarget.style.background = '#274bff';
                                e.currentTarget.style.transform = 'scale(1)';
                            }
                        }}
                    >
                        ▲
                    </button>

                    <div style={RACE_COUNT_DISPLAY_STYLE}>
                        {numberOfRaces}
                    </div>

                    <button
                        type="button"
                        onClick={() => setNumberOfRaces(prev => Math.max(prev - 1, 1))}
                        disabled={numberOfRaces <= 1}
                        style={{
                            ...RACE_COUNT_BUTTON_STYLE,
                            borderRadius: '0 0 4px 4px',
                            background: numberOfRaces <= 1 ? '#333' : '#274bff',
                            cursor: numberOfRaces <= 1 ? 'not-allowed' : 'pointer',
                            opacity: numberOfRaces <= 1 ? 0.5 : 1,
                        }}
                        onMouseEnter={(e) => {
                            if (numberOfRaces > 1) {
                                e.currentTarget.style.background = '#1f3bd9';
                                e.currentTarget.style.transform = 'scale(1.05)';
                            }
                        }}
                        onMouseLeave={(e) => {
                            if (numberOfRaces > 1) {
                                e.currentTarget.style.background = '#274bff';
                                e.currentTarget.style.transform = 'scale(1)';
                            }
                        }}
                    >
                        ▼
                    </button>
                </div>
            )}
        </div>
    );
};

export default RaceRunControls;
