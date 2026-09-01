import React from 'react'
import { Select, Text } from '@chakra-ui/react'
import ConfirmModal from '@/components/ConfirmModal'
import type { RpsGame } from '@/components/Racing/hooks/useRpsGame'

const MAX_MATCH_TICKS = 10

type RpsControlBarProps = Pick<
    RpsGame,
    | 'ownedCars'
    | 'selectedCarId'
    | 'setSelectedCarId'
    | 'isTraining'
    | 'setIsTraining'
    | 'opponentId'
    | 'setOpponentId'
    | 'setOpponentName'
    | 'allCars'
    | 'numberOfMatches'
    | 'setNumberOfMatches'
    | 'playSeries'
>

const MATCH_COUNT_BUTTON_STYLE: React.CSSProperties = {
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

const MATCH_COUNT_DISPLAY_STYLE: React.CSSProperties = {
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

const RpsControlBar: React.FC<RpsControlBarProps> = ({
    ownedCars,
    selectedCarId,
    setSelectedCarId,
    isTraining,
    setIsTraining,
    opponentId,
    setOpponentId,
    setOpponentName,
    allCars,
    numberOfMatches,
    setNumberOfMatches,
    playSeries,
}) => {
    return (
        // Primary Controls - Responsive Layout
        <div style={{ padding: '16px 18px', borderBottom: '1px solid #2a3550', background: '#0a0f1e' }}>
            <div className="race-controls-container">
                {/* Left: Car, Mode, Opponent dropdowns */}
                <div className="race-controls-dropdowns">
                    {/* Car Selection */}
                    <div className="race-control-item">
                        <Text fontFamily='"Press Start 2P", monospace' fontSize="12px" color="#b8c1ff">CAR:</Text>
                        <Select
                            value={selectedCarId ?? ''}
                            onChange={(e) => setSelectedCarId(e.target.value || undefined)}
                            placeholder={ownedCars && ownedCars.length > 0 ? 'Select car' : 'No cars'}
                            size="sm"
                            bg="#070b15"
                            borderColor="#0033ff"
                            color="#e6e6e6"
                            fontFamily='"Press Start 2P", monospace'
                            minW="140px"
                        >
                            {ownedCars?.map((c) => (
                                <option key={c.id} value={c.id}>{c.name ?? `#${c.id}`}</option>
                            ))}
                        </Select>
                    </div>

                    {/* Mode Selection */}
                    <div className="race-control-item">
                        <Text fontFamily='"Press Start 2P", monospace' fontSize="12px" color="#b8c1ff">MODE:</Text>
                        <Select
                            value={isTraining ? 'training' : 'showcase'}
                            onChange={(e) => setIsTraining(e.target.value === 'training')}
                            size="sm"
                            bg="#070b15"
                            borderColor="#0033ff"
                            color="#e6e6e6"
                            fontFamily='"Press Start 2P", monospace'
                            minW="120px"
                        >
                            <option value="training">Training</option>
                            <option value="showcase">Showcase</option>
                        </Select>
                    </div>

                    {/* Opponent Selection */}
                    <div className="race-control-item">
                        <Text fontFamily='"Press Start 2P", monospace' fontSize="12px" color="#b8c1ff">OPPONENT:</Text>
                        <Select value={opponentId} onChange={(e) => {
                            const newOpponentId = e.target.value;
                            setOpponentId(newOpponentId);
                            setOpponentName(e.target.selectedOptions[0]?.label || 'Opponent');

                            // Auto-switch to training mode if selecting The Singularity (id "0")
                            if (newOpponentId === "0") {
                                setIsTraining(true);
                            } else {
                                // Auto-switch to showcase mode for real opponents
                                setIsTraining(false);
                            }
                        }} size="sm" bg="#070b15" borderColor="#0033ff" color="#e6e6e6" fontFamily='"Press Start 2P", monospace' minW="140px">
                            <option value="0">The Singularity</option>
                            {(allCars ?? []).flatMap((c) => c.id !== "0" ? [(
                                <option key={c.id} value={c.id}>{c.name ?? `#${c.id}`}</option>
                            )] : [])}
                        </Select>
                    </div>
                </div>

                {/* Right: Start Match Button with Match Count Controls */}
                <div className="race-controls-button" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <ConfirmModal
                        executeDirectly={true}
                        label={`Start Match (${numberOfMatches})`}
                        action={playSeries.action}
                        buttonProps={{
                            size: 'sm',
                            background: '#274bff',
                            color: '#fff',
                            border: '2px solid #0033ff',
                            cursor: 'pointer',
                            boxShadow: '0 0 8px #0033ff',
                            letterSpacing: 1,
                            fontFamily: '"Press Start 2P", monospace',
                            fontSize: '12px',
                            padding: '10px 18px',
                            minW: '140px',
                            _hover: { background: '#1a3dff' }
                        }}
                    />

                    {/* Match Count Controls */}
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', height: '44px', justifyContent: 'stretch' }}>
                        <button
                            type="button"
                            onClick={() => setNumberOfMatches(prev => Math.min(prev + 1, 10))}
                            disabled={numberOfMatches >= 10}
                            style={{
                                ...MATCH_COUNT_BUTTON_STYLE,
                                borderRadius: '4px 4px 0 0',
                                background: numberOfMatches >= MAX_MATCH_TICKS ? '#333' : '#274bff',
                                cursor: numberOfMatches >= MAX_MATCH_TICKS ? 'not-allowed' : 'pointer',
                                opacity: numberOfMatches >= MAX_MATCH_TICKS ? 0.5 : 1,
                            }}
                            onMouseEnter={(e) => {
                                if (numberOfMatches < MAX_MATCH_TICKS) {
                                    e.currentTarget.style.background = '#1f3bd9';
                                    e.currentTarget.style.transform = 'scale(1.05)';
                                }
                            }}
                            onMouseLeave={(e) => {
                                if (numberOfMatches < MAX_MATCH_TICKS) {
                                    e.currentTarget.style.background = '#274bff';
                                    e.currentTarget.style.transform = 'scale(1)';
                                }
                            }}
                        >
                            ▲
                        </button>
                        <div style={MATCH_COUNT_DISPLAY_STYLE}>
                            {numberOfMatches}
                        </div>
                        <button
                            type="button"
                            onClick={() => setNumberOfMatches(prev => Math.max(prev - 1, 1))}
                            disabled={numberOfMatches <= 1}
                            style={{
                                ...MATCH_COUNT_BUTTON_STYLE,
                                borderRadius: '0 0 4px 4px',
                                background: numberOfMatches <= 1 ? '#333' : '#274bff',
                                cursor: numberOfMatches <= 1 ? 'not-allowed' : 'pointer',
                                opacity: numberOfMatches <= 1 ? 0.5 : 1,
                            }}
                            onMouseEnter={(e) => {
                                if (numberOfMatches > 1) {
                                    e.currentTarget.style.background = '#1f3bd9';
                                    e.currentTarget.style.transform = 'scale(1.05)';
                                }
                            }}
                            onMouseLeave={(e) => {
                                if (numberOfMatches > 1) {
                                    e.currentTarget.style.background = '#274bff';
                                    e.currentTarget.style.transform = 'scale(1)';
                                }
                            }}
                        >
                            ▼
                        </button>
                    </div>
                </div>
            </div>
        </div>
    )
}

export default RpsControlBar
