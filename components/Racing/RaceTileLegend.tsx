import React, { useState } from 'react';
import { WALL, START, FINISH, STUCK, BOOST } from './raceConstants';
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions';
import { TYPOGRAPHY } from '@/helpers/typography';

// no-many-boolean-props FP: isCampaign/hasPreview/showTraining are independent app-context flags,
// showLegend/showAdvancedParams are two unrelated, simultaneously-independent collapse toggles —
// none are mutually-exclusive variants of one state, so consolidating would hurt clarity.
interface RaceTileLegendProps {
    isCampaign: boolean;
    progress: any;
    hasPreview: boolean;
    showLegend: boolean;
    setShowLegend: React.Dispatch<React.SetStateAction<boolean>>;
    showTraining: boolean;
    showAdvancedParams: boolean;
    setShowAdvancedParams: React.Dispatch<React.SetStateAction<boolean>>;
    explorationRate: number;
    setExplorationRate: React.Dispatch<React.SetStateAction<number>>;
    maxRaceTicksInput: string;
    setMaxRaceTicksInput: React.Dispatch<React.SetStateAction<string>>;
    setMaxRaceTicks: React.Dispatch<React.SetStateAction<number>>;
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

const MAX_TICKS_INPUT_STYLE: React.CSSProperties = {
    width: '120px',
    background: '#0a0f1e',
    color: '#fff',
    border: '2px solid #0033ff',
    fontFamily: '"Press Start 2P", monospace',
    fontSize: TYPOGRAPHY.xs,
    padding: '6px 8px',
    boxShadow: '0 0 8px #0033ff inset',
    borderRadius: '3px',
};

const RaceTileLegend: React.FC<RaceTileLegendProps> = ({
    isCampaign,
    progress,
    hasPreview,
    showLegend,
    setShowLegend,
    showTraining,
    showAdvancedParams,
    setShowAdvancedParams,
    explorationRate,
    setExplorationRate,
    maxRaceTicksInput,
    setMaxRaceTicksInput,
    setMaxRaceTicks,
}) => {
    const [isExplorationFocused, setIsExplorationFocused] = useState(false);
    const toggleLegend = () => setShowLegend(!showLegend);
    const toggleAdvancedParams = () => setShowAdvancedParams(!showAdvancedParams);

    return (
        <>
            {/* Tile Legend Section */}
            {(!isCampaign || progress.unlocks.showTileLegend) && (
                <div style={{ opacity: hasPreview ? 1 : 0.5 }}>
                    <button
                        type="button"
                        onClick={toggleLegend}
                        aria-expanded={showLegend}
                        style={SECTION_HEADER_STYLE}
                        onMouseEnter={(e) => e.currentTarget.style.color = '#00ffff'}
                        onMouseLeave={(e) => e.currentTarget.style.color = '#00ffea'}
                    >
                        <span style={{ fontSize: 14, transition: 'transform 0.2s ease', transform: showLegend ? 'rotate(0deg)' : 'rotate(-90deg)' }}>▼</span>
                        <span>TILE LEGEND</span>
                    </button>
                    {showLegend && (
                        <div style={{ padding: '0 16px 16px 16px' }}>
                            <div style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'center' }}>
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><i style={{ width: 12, height: 12, background: WALL, display: 'inline-block', border: '1px solid #2a3550' }} /> Wall</span>
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><i style={{ width: 12, height: 12, background: START, display: 'inline-block', border: '1px solid #2a3550' }} /> Start</span>
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><i style={{ width: 12, height: 12, background: FINISH, display: 'inline-block', border: '1px solid #2a3550' }} /> Finish</span>
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><i style={{ width: 12, height: 12, background: STUCK, display: 'inline-block', border: '1px solid #2a3550' }} /> Sticky</span>
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><i style={{ width: 12, height: 12, background: BOOST, display: 'inline-block', border: '1px solid #2a3550' }} /> Boost</span>
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><i style={{ width: 12, height: 12, background: 'transparent', display: 'inline-block', border: '2px solid #ff0000' }} /> Collision</span>
                            </div>
                        </div>
                    )}
                    {/* Advanced Training Parameters - Collapsible, only visible when Training mode is selected */}
                    {(showTraining && (!isCampaign || progress.unlocks.showAdvancedParams)) && (
                        <div style={{ background: '#0a0f1e', borderBottom: '1px solid #2a3550' }}>
                            <button
                                type="button"
                                onClick={toggleAdvancedParams}
                                aria-expanded={showAdvancedParams}
                                style={SECTION_HEADER_STYLE}
                                onMouseEnter={(e) => e.currentTarget.style.color = '#00ffff'}
                                onMouseLeave={(e) => e.currentTarget.style.color = '#00ffea'}
                            >
                                <span style={{ fontSize: 14, transition: 'transform 0.2s ease', transform: showAdvancedParams ? 'rotate(0deg)' : 'rotate(-90deg)' }}>▼</span>
                                <span>ADVANCED TRAINING PARAMETERS</span>
                            </button>
                            {showAdvancedParams && (
                                <div style={{ padding: '0 16px 16px 16px' }}>
                                    <div style={{ display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap' }}>
                                        {/* Exploration Rate Slider */}
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                            <label htmlFor="race-exploration-rate" style={{ fontFamily: '"Press Start 2P", monospace', fontSize: 12, color: '#b8c1ff', minWidth: '120px' }}>
                                                Exploration Rate: {Math.round(explorationRate * 100)}%
                                            </label>
                                            <input
                                                id="race-exploration-rate"
                                                type="range"
                                                min="0"
                                                max="1"
                                                step="0.05"
                                                value={explorationRate}
                                                onChange={(e) => setExplorationRate(parseFloat(e.target.value))}
                                                onFocus={() => setIsExplorationFocused(true)}
                                                onBlur={() => setIsExplorationFocused(false)}
                                                style={{
                                                    width: '120px',
                                                    height: '6px',
                                                    background: '#0033ff',
                                                    outline: 'none',
                                                    borderRadius: '3px',
                                                    boxShadow: isExplorationFocused ? FOCUS_STYLES.ring.boxShadow : 'none',
                                                    transition: TRANSITIONS.shadow,
                                                }}
                                            />
                                        </div>

                                        {/* Max Ticks Input */}
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                            <label htmlFor="race-max-ticks" style={{ fontFamily: '"Press Start 2P", monospace', fontSize: TYPOGRAPHY.xs, color: '#b8c1ff', minWidth: '120px' }}>
                                                Max Ticks:
                                            </label>
                                            <input
                                                id="race-max-ticks"
                                                type="number"
                                                min={0}
                                                step={1}
                                                value={maxRaceTicksInput}
                                                onChange={(e) => {
                                                    let raw = e.target.value
                                                    if (raw === '') {
                                                        setMaxRaceTicksInput('')
                                                        return
                                                    }
                                                    raw = raw.replace(/[^0-9]/g, '')
                                                    raw = raw.replace(/^0+(?=\d)/, '')
                                                    if (raw === '') raw = '0'
                                                    setMaxRaceTicksInput(raw)
                                                    const num = parseInt(raw, 10)
                                                    if (Number.isFinite(num) && num >= 0) setMaxRaceTicks(num)
                                                }}
                                                onBlur={() => {
                                                    if (maxRaceTicksInput === '') {
                                                        setMaxRaceTicksInput('100')
                                                        setMaxRaceTicks(100)
                                                    }
                                                }}
                                                placeholder="0 = default"
                                                style={MAX_TICKS_INPUT_STYLE}
                                            />
                                            {/* removed trailing label */}
                                        </div>

                                        {/* Decay Checkbox */}
                                        {/* <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '10px', color: '#b8c1ff' }}>
                                            <input
                                                type="checkbox"
                                                checked={enableDecay}
                                                onChange={(e) => setEnableDecay(e.target.checked)}
                                            /> Enable Exploration Decay
                                        </label> */}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}
        </>
    );
};

export default RaceTileLegend;
