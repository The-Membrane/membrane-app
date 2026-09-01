import React, { useState } from 'react'
import { Select } from '@chakra-ui/react'
import type { RpsGame } from '@/components/Racing/hooks/useRpsGame'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

type RpsMatchControlsProps = Pick<
    RpsGame,
    'playing' | 'setPlaying' | 'phaseTickRef' | 'setPhaseTickDisplay' | 'speed' | 'setSpeed'
>

const RPS_BUTTON_BASE_STYLE: React.CSSProperties = {
    padding: '10px 18px',
    color: '#fff',
    border: '2px solid #0033ff',
    cursor: 'pointer',
    boxShadow: '0 0 8px #0033ff',
    letterSpacing: 1,
    fontFamily: '"Press Start 2P", monospace',
    fontSize: '12px',
};

const RpsMatchControls: React.FC<RpsMatchControlsProps> = ({
    playing,
    setPlaying,
    phaseTickRef,
    setPhaseTickDisplay,
    speed,
    setSpeed,
}) => {
    return (
        <div style={{ padding: '0 16px 16px 16px' }}>
            <div style={{ display: 'flex', gap: 16, alignItems: 'center', justifyContent: 'center', color: '#fff', fontFamily: '"Press Start 2P", monospace', fontSize: 12 }}>
                <button
                    type="button"
                    onClick={() => setPlaying((p) => !p)}
                    style={{ ...RPS_BUTTON_BASE_STYLE, background: playing ? '#ff2d2d' : '#274bff' }}
                >
                    {playing ? 'PAUSE' : 'START'}
                </button>
                <button
                    type="button"
                    onClick={() => { phaseTickRef.current = 0; setPhaseTickDisplay(0); }}
                    style={{ ...RPS_BUTTON_BASE_STYLE, background: '#274bff' }}
                >
                    RESET
                </button>
                <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    Speed:
                    <select
                        value={speed}
                        onChange={e => setSpeed(parseFloat(e.target.value))}
                        style={{
                            background: '#0a0f1e',
                            color: '#fff',
                            border: '2px solid #0033ff',
                            fontFamily: 'inherit',
                            fontSize: 12,
                            padding: '6px 8px',
                            boxShadow: '0 0 8px #0033ff inset'
                        }}
                    >
                        {[0.25, 0.5, 1, 2, 4].map((s: number) => (
                            <option key={s} value={s} style={{ background: '#0a0f1e', color: '#fff' }}>{s}x</option>
                        ))}
                    </select>
                </label>
            </div>
        </div>
    )
}

type RpsTrainingParamsProps = Pick<
    RpsGame,
    | 'isTraining'
    | 'mode'
    | 'setMode'
    | 'fixedTicks'
    | 'setFixedTicks'
    | 'bestOfWins'
    | 'setBestOfWins'
    | 'epsilon'
    | 'setEpsilon'
>

const TRAINING_PARAMS_ROW_STYLE: React.CSSProperties = {
    display: 'flex',
    gap: 16,
    alignItems: 'center',
    justifyContent: 'center',
    color: '#fff',
    fontFamily: '"Press Start 2P", monospace',
    fontSize: 12,
    flexWrap: 'wrap',
};

const NUMBER_INPUT_STYLE: React.CSSProperties = {
    width: '80px',
    background: '#0a0f1e',
    color: '#fff',
    border: '2px solid #0033ff',
    fontFamily: '"Press Start 2P", monospace',
    fontSize: TYPOGRAPHY.xs,
    padding: '6px 8px',
    boxShadow: '0 0 8px #0033ff inset',
    borderRadius: '3px',
};

const RpsTrainingParams: React.FC<RpsTrainingParamsProps> = ({
    isTraining,
    mode,
    setMode,
    fixedTicks,
    setFixedTicks,
    bestOfWins,
    setBestOfWins,
    epsilon,
    setEpsilon,
}) => {
    const [isEpsilonFocused, setIsEpsilonFocused] = useState(false)
    return (
        <div style={{ padding: '0 16px 16px 16px' }}>
            <div style={TRAINING_PARAMS_ROW_STYLE}>
                {!isTraining && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <label htmlFor="rps-series" style={{ fontFamily: '"Press Start 2P", monospace', fontSize: TYPOGRAPHY.xs, color: '#b8c1ff', minWidth: '60px' }}>
                            Series:
                        </label>
                        <Select id="rps-series" value={mode} onChange={(e) => setMode(e.target.value as any)} size="sm" bg="#0a0f1e" borderColor="#0033ff" color="#e6e6e6" fontFamily='"Press Start 2P", monospace' fontSize={TYPOGRAPHY.xs} minW="120px">
                            <option value="fixed">Fixed Ticks</option>
                            <option value="bestOf">Best of</option>
                        </Select>
                    </div>
                )}
                {mode === 'fixed' ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <label htmlFor="rps-fixed-ticks" style={{ fontFamily: '"Press Start 2P", monospace', fontSize: TYPOGRAPHY.xs, color: '#b8c1ff', minWidth: '80px' }}>
                            Ticks:
                        </label>
                        <input
                            id="rps-fixed-ticks"
                            type="number"
                            min={1}
                            step={1}
                            value={fixedTicks}
                            onChange={(e) => {
                                let raw = e.target.value
                                if (raw === '') {
                                    setFixedTicks(1)
                                    return
                                }
                                raw = raw.replace(/[^0-9]/g, '')
                                raw = raw.replace(/^0+(?=\d)/, '')
                                if (raw === '') raw = '1'
                                const num = parseInt(raw, 10)
                                if (Number.isFinite(num) && num >= 1) setFixedTicks(num)
                            }}
                            onBlur={() => {
                                if (fixedTicks < 1) {
                                    setFixedTicks(1)
                                }
                            }}
                            style={NUMBER_INPUT_STYLE}
                        />
                    </div>
                ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <label htmlFor="rps-best-of-wins" style={{ fontFamily: '"Press Start 2P", monospace', fontSize: TYPOGRAPHY.xs, color: '#b8c1ff', minWidth: '80px' }}>
                            Wins Target:
                        </label>
                        <input
                            id="rps-best-of-wins"
                            type="number"
                            min={1}
                            step={1}
                            value={bestOfWins}
                            onChange={(e) => {
                                let raw = e.target.value
                                if (raw === '') {
                                    setBestOfWins(1)
                                    return
                                }
                                raw = raw.replace(/[^0-9]/g, '')
                                raw = raw.replace(/^0+(?=\d)/, '')
                                if (raw === '') raw = '1'
                                const num = parseInt(raw, 10)
                                if (Number.isFinite(num) && num >= 1) setBestOfWins(num)
                            }}
                            onBlur={() => {
                                if (bestOfWins < 1) {
                                    setBestOfWins(1)
                                }
                            }}
                            style={NUMBER_INPUT_STYLE}
                        />
                    </div>
                )}
                {/* Epsilon Slider */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <label htmlFor="rps-epsilon" style={{ fontFamily: '"Press Start 2P", monospace', fontSize: TYPOGRAPHY.xs, color: '#b8c1ff', minWidth: '100px' }}>
                        Epsilon: {Math.round(epsilon * 100)}%
                    </label>
                    <input
                        id="rps-epsilon"
                        type="range"
                        min="0"
                        max="1"
                        step="0.05"
                        value={epsilon}
                        onChange={(e) => setEpsilon(parseFloat(e.target.value))}
                        onFocus={() => setIsEpsilonFocused(true)}
                        onBlur={() => setIsEpsilonFocused(false)}
                        style={{
                            width: '100px',
                            height: '6px',
                            background: '#0033ff',
                            outline: 'none',
                            borderRadius: '3px',
                            boxShadow: isEpsilonFocused ? FOCUS_STYLES.ring.boxShadow : 'none',
                            transition: TRANSITIONS.shadow,
                        }}
                    />
                </div>
            </div>
        </div>
    )
}

const COLLAPSIBLE_HEADER_STYLE: React.CSSProperties = {
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    color: '#00ffea',
    padding: '12px 16px',
    fontFamily: '"Press Start 2P", monospace',
    fontSize: 12,
    userSelect: 'none',
    transition: 'color 0.2s ease',
};

function CollapsibleSection({ title, children }: { title: string; children: React.ReactNode }) {
    const [open, setOpen] = useState(false)
    const toggleOpen = () => setOpen(!open)
    return (
        <div style={{ opacity: 1 }}>
            <button
                type="button"
                onClick={toggleOpen}
                aria-expanded={open}
                style={COLLAPSIBLE_HEADER_STYLE}
                onMouseEnter={(e) => (e.currentTarget.style.color = '#00ffff')}
                onMouseLeave={(e) => (e.currentTarget.style.color = '#00ffea')}
            >
                <span style={{ fontSize: 14, transition: 'transform 0.2s ease', transform: open ? 'rotate(0deg)' : 'rotate(-90deg)' }}>▼</span>
                <span>{title}</span>
            </button>
            {open && <div>{children}</div>}
        </div>
    )
}

type RpsControlPanelsProps = Pick<
    RpsGame,
    | 'playing'
    | 'setPlaying'
    | 'phaseTickRef'
    | 'setPhaseTickDisplay'
    | 'speed'
    | 'setSpeed'
    | 'isTraining'
    | 'mode'
    | 'setMode'
    | 'fixedTicks'
    | 'setFixedTicks'
    | 'bestOfWins'
    | 'setBestOfWins'
    | 'epsilon'
    | 'setEpsilon'
>

const RpsControlPanels: React.FC<RpsControlPanelsProps> = (props) => {
    return (
        // Collapsible sections for controls
        <div style={{ background: '#0a0f1e', borderBottom: '1px solid #2a3550' }}>
            <CollapsibleSection title="MATCH CONTROLS">
                <RpsMatchControls
                    playing={props.playing}
                    setPlaying={props.setPlaying}
                    phaseTickRef={props.phaseTickRef}
                    setPhaseTickDisplay={props.setPhaseTickDisplay}
                    speed={props.speed}
                    setSpeed={props.setSpeed}
                />
            </CollapsibleSection>

            <CollapsibleSection title="ADVANCED TRAINING PARAMETERS">
                <RpsTrainingParams
                    isTraining={props.isTraining}
                    mode={props.mode}
                    setMode={props.setMode}
                    fixedTicks={props.fixedTicks}
                    setFixedTicks={props.setFixedTicks}
                    bestOfWins={props.bestOfWins}
                    setBestOfWins={props.setBestOfWins}
                    epsilon={props.epsilon}
                    setEpsilon={props.setEpsilon}
                />
            </CollapsibleSection>
        </div>
    )
}

export default RpsControlPanels
