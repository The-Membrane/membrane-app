import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Button, Flex, HStack, Text, VStack, Select, Slider, SliderTrack, SliderFilledTrack, SliderThumb, Input } from '@chakra-ui/react'
import { useOwnedCars, useRpsTickHistory, useRpsHistory } from '@/hooks/useQRacing'
import useWallet from '@/hooks/useWallet'
import useAppState from '@/persisted-state/useAppState'
import { rpsActionToEmoji, rpsActionToLabel, useAllCars } from '@/services/q-racing'
import ConfirmModal from '@/components/ConfirmModal'
import usePlaySeries from '@/components/Racing/hooks/usePlaySeries'

const MAX_MATCH_TICKS = 10

const countInPhrases = ['Rock', 'Paper', 'Scissors', 'Shoot']

const RockPaperScissors: React.FC = () => {
    const { address } = useWallet()
    const { data: ownedCars } = useOwnedCars(address)
    const { appState } = useAppState()

    const [selectedCarId, setSelectedCarId] = useState<string | undefined>(undefined)
    const [opponentId, setOpponentId] = useState<string>('0')
    const [opponentName, setOpponentName] = useState<string>('The Singularity')
    const [isTraining, setIsTraining] = useState<boolean>(true)
    const [mode, setMode] = useState<'fixed' | 'bestOf'>('fixed')
    const [fixedTicks, setFixedTicks] = useState<number>(100)
    const [bestOfWins, setBestOfWins] = useState<number>(3)
    const [numberOfMatches, setNumberOfMatches] = useState<number>(1)
    const [epsilon, setEpsilon] = useState<number>(0.6)

    const { data: tickHistory } = useRpsTickHistory(selectedCarId)
    const { data: matchHistory } = useRpsHistory(selectedCarId)
    console.log('tickHistory', tickHistory)
    console.log('matchHistory', matchHistory)
    const { data: allCars } = useAllCars()
    const playSeries = usePlaySeries({
        carId: selectedCarId,
        opponentId,
        train: isTraining,
        numberOfMatches,
        mode: mode === 'bestOf' ? { type: 'bestOf', winsTarget: bestOfWins } : { type: 'fixed', ticks: fixedTicks },
        epsilon: epsilon.toString(),
        temperature: '0.0', // Static default
        enableDecay: true, // Static default
    })

    useEffect(() => {
        if (!selectedCarId && ownedCars && ownedCars.length > 0) {
            setSelectedCarId(ownedCars[0]?.id)
        }
    }, [ownedCars, selectedCarId])

    const ticks = tickHistory?.ticks ?? []

    const [playing, setPlaying] = useState(false)
    const [speed, setSpeed] = useState(1) // phases per second baseline
    const phaseTickRef = useRef(0)
    const [phaseTickDisplay, setPhaseTickDisplay] = useState(0) // 0..(ticks.length*4)

    useEffect(() => {
        phaseTickRef.current = 0
        setPhaseTickDisplay(0)
        setPlaying(false)
    }, [selectedCarId, ticks.length])

    useEffect(() => {
        let raf: number | null = null
        let last = performance.now()
        const loop = (now: number) => {
            const interval = 1000 / Math.max(0.25, speed)
            if (playing && now - last >= interval) {
                const maxPhaseTicks = Math.max(0, ticks.length * 5) // 4 phases + 1 extra for shoot
                if (phaseTickRef.current < maxPhaseTicks) {
                    phaseTickRef.current += 1
                    setPhaseTickDisplay(phaseTickRef.current)
                } else {
                    setPlaying(false)
                }
                last = now
            }
            raf = requestAnimationFrame(loop)
        }
        raf = requestAnimationFrame(loop)
        return () => { if (raf) cancelAnimationFrame(raf) }
    }, [playing, speed, ticks.length])

    const maxPhaseTicks = Math.max(0, ticks.length * 5) // 4 phases + 1 extra for shoot
    const clampedPhase = Math.min(Math.max(0, phaseTickDisplay), maxPhaseTicks)

    // Calculate phase with shoot getting 2 ticks
    let phase: number
    let currentRound: number
    if (clampedPhase < ticks.length * 4) {
        // Normal phases (Rock, Paper, Scissors) - 1 tick each
        phase = clampedPhase % 4
        currentRound = Math.floor(clampedPhase / 4)
    } else {
        // Shoot phase - 2 ticks
        phase = 3 // Shoot phase
        currentRound = Math.floor((clampedPhase - ticks.length * 4) / 2) + Math.floor(ticks.length * 4 / 4)
    }

    // Ensure currentRound doesn't exceed available ticks
    currentRound = Math.min(ticks.length - 1, currentRound)
    const currentRecord = currentRound >= 0 && currentRound < ticks.length ? ticks[currentRound] : undefined

    // Compute score on the fly - updates during shoot phase
    const score = useMemo(() => {
        // Calculate rounds to include in score
        let roundsToScore: number

        if (clampedPhase < ticks.length * 4) {
            // Normal phases - only count completed rounds (4 ticks each)
            roundsToScore = Math.floor(clampedPhase / 4)
        } else {
            // Shoot phase - include the current round being shot
            const normalPhaseRounds = Math.floor(ticks.length * 4 / 4)
            const shootPhaseProgress = Math.floor((clampedPhase - ticks.length * 4) / 2)
            roundsToScore = normalPhaseRounds + shootPhaseProgress
        }

        roundsToScore = Math.min(ticks.length, roundsToScore)

        let win = 0, loss = 0, draw = 0
        for (let i = 0; i < roundsToScore; i++) {
            const t = ticks[i]
            if (!t) continue
            if (t.my_action === t.opp_action) {
                console.log('draw', t)
                draw++
            } else if (
                (t.my_action === 0 && t.opp_action === 2) ||  // Rock beats Scissors
                (t.my_action === 1 && t.opp_action === 0) ||  // Paper beats Rock
                (t.my_action === 2 && t.opp_action === 1)     // Scissors beats Paper
            ) {
                console.log('win', t)
                win++
            } else {
                console.log('loss', t)
                loss++
            }
        }
        return { win, loss, draw }
    }, [ticks, clampedPhase])

    // Build the chant sequence visualization
    const chant = useMemo(() => {
        return countInPhrases.map((p, i) => ({ label: p, active: i === phase }))
    }, [phase])

    return (
        <Flex direction="column" h="100%">
            {/* Primary Controls - Responsive Layout */}
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
                                {(allCars ?? []).filter(c => c.id !== "0").map((c) => (
                                    <option key={c.id} value={c.id}>{c.name ?? `#${c.id}`}</option>
                                ))}
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
                                onClick={() => setNumberOfMatches(prev => Math.min(prev + 1, 10))}
                                disabled={numberOfMatches >= 10}
                                style={{
                                    width: '32px',
                                    flex: '1',
                                    background: numberOfMatches >= MAX_MATCH_TICKS ? '#333' : '#274bff',
                                    color: '#fff',
                                    border: '1px solid #0033ff',
                                    borderRadius: '4px 4px 0 0',
                                    cursor: numberOfMatches >= MAX_MATCH_TICKS ? 'not-allowed' : 'pointer',
                                    fontFamily: '"Press Start 2P", monospace',
                                    fontSize: '8px',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    opacity: numberOfMatches >= MAX_MATCH_TICKS ? 0.5 : 1,
                                    transition: 'all 0.2s ease',
                                    minHeight: 0
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
                            <div style={{
                                width: '32px',
                                flex: '1',
                                background: '#0a0f1e',
                                color: '#00ffea',
                                border: '1px solid #0033ff',
                                borderRadius: '0',
                                fontFamily: '"Press Start 2P", monospace',
                                fontSize: '8px',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontWeight: 'bold',
                                minHeight: 0
                            }}>
                                {numberOfMatches}
                            </div>
                            <button
                                onClick={() => setNumberOfMatches(prev => Math.max(prev - 1, 1))}
                                disabled={numberOfMatches <= 1}
                                style={{
                                    width: '32px',
                                    flex: '1',
                                    background: numberOfMatches <= 1 ? '#333' : '#274bff',
                                    color: '#fff',
                                    border: '1px solid #0033ff',
                                    borderRadius: '0 0 4px 4px',
                                    cursor: numberOfMatches <= 1 ? 'not-allowed' : 'pointer',
                                    fontFamily: '"Press Start 2P", monospace',
                                    fontSize: '8px',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    opacity: numberOfMatches <= 1 ? 0.5 : 1,
                                    transition: 'all 0.2s ease',
                                    minHeight: 0
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

            {/* Collapsible sections for controls */}
            <div style={{ background: '#0a0f1e', borderBottom: '1px solid #2a3550' }}>
                <CollapsibleSection title="MATCH CONTROLS">
                    <div style={{ padding: '0 16px 16px 16px' }}>
                        <div style={{ display: 'flex', gap: 16, alignItems: 'center', justifyContent: 'center', color: '#fff', fontFamily: '"Press Start 2P", monospace', fontSize: 12 }}>
                            <button
                                onClick={() => setPlaying((p) => !p)}
                                style={{
                                    padding: '10px 18px',
                                    background: playing ? '#ff2d2d' : '#274bff',
                                    color: '#fff',
                                    border: '2px solid #0033ff',
                                    cursor: 'pointer',
                                    boxShadow: '0 0 8px #0033ff',
                                    letterSpacing: 1,
                                    fontFamily: '"Press Start 2P", monospace',
                                    fontSize: '12px'
                                }}
                            >
                                {playing ? 'PAUSE' : 'START'}
                            </button>
                            <button
                                onClick={() => { phaseTickRef.current = 0; setPhaseTickDisplay(0); }}
                                style={{
                                    padding: '10px 18px',
                                    background: '#274bff',
                                    color: '#fff',
                                    border: '2px solid #0033ff',
                                    cursor: 'pointer',
                                    boxShadow: '0 0 8px #0033ff',
                                    letterSpacing: 1,
                                    fontFamily: '"Press Start 2P", monospace',
                                    fontSize: '12px'
                                }}
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
                </CollapsibleSection>

                <CollapsibleSection title="ADVANCED TRAINING PARAMETERS">
                    <div style={{ padding: '0 16px 16px 16px' }}>
                        <div style={{ display: 'flex', gap: 16, alignItems: 'center', justifyContent: 'center', color: '#fff', fontFamily: '"Press Start 2P", monospace', fontSize: 10, flexWrap: 'wrap' }}>
                            {!isTraining && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <label style={{ fontFamily: '"Press Start 2P", monospace', fontSize: 10, color: '#b8c1ff', minWidth: '60px' }}>
                                        Series:
                                    </label>
                                    <Select value={mode} onChange={(e) => setMode(e.target.value as any)} size="sm" bg="#0a0f1e" borderColor="#0033ff" color="#e6e6e6" fontFamily='"Press Start 2P", monospace' fontSize="10px" minW="120px">
                                        <option value="fixed">Fixed Ticks</option>
                                        <option value="bestOf">Best of</option>
                                    </Select>
                                </div>
                            )}
                            {mode === 'fixed' ? (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <label style={{ fontFamily: '"Press Start 2P", monospace', fontSize: 10, color: '#b8c1ff', minWidth: '80px' }}>
                                        Ticks:
                                    </label>
                                    <input
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
                                        style={{
                                            width: '80px',
                                            background: '#0a0f1e',
                                            color: '#fff',
                                            border: '2px solid #0033ff',
                                            fontFamily: '"Press Start 2P", monospace',
                                            fontSize: 10,
                                            padding: '6px 8px',
                                            boxShadow: '0 0 8px #0033ff inset',
                                            borderRadius: '3px'
                                        }}
                                    />
                                </div>
                            ) : (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <label style={{ fontFamily: '"Press Start 2P", monospace', fontSize: 10, color: '#b8c1ff', minWidth: '80px' }}>
                                        Wins Target:
                                    </label>
                                    <input
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
                                        style={{
                                            width: '80px',
                                            background: '#0a0f1e',
                                            color: '#fff',
                                            border: '2px solid #0033ff',
                                            fontFamily: '"Press Start 2P", monospace',
                                            fontSize: 10,
                                            padding: '6px 8px',
                                            boxShadow: '0 0 8px #0033ff inset',
                                            borderRadius: '3px'
                                        }}
                                    />
                                </div>
                            )}
                            {/* Epsilon Slider */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <label style={{ fontFamily: '"Press Start 2P", monospace', fontSize: 10, color: '#b8c1ff', minWidth: '100px' }}>
                                    Epsilon: {Math.round(epsilon * 100)}%
                                </label>
                                <input
                                    type="range"
                                    min="0"
                                    max="1"
                                    step="0.05"
                                    value={epsilon}
                                    onChange={(e) => setEpsilon(parseFloat(e.target.value))}
                                    style={{
                                        width: '100px',
                                        height: '6px',
                                        background: '#0033ff',
                                        outline: 'none',
                                        borderRadius: '3px'
                                    }}
                                />
                            </div>
                        </div>
                    </div>
                </CollapsibleSection>
            </div>

            {/* Info Section - Performance Stats */}
            <div style={{ background: '#0a0f1e', borderBottom: '1px solid #2a3550', padding: '12px 18px' }}>
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '32px' }}>
                    {/* Win Rate in Last N Ticks */}
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                        <Text fontFamily='"Press Start 2P", monospace' fontSize="12px" color="#b8c1ff">
                            Win Rate (Last {matchHistory?.history?.length || 0} ticks)
                        </Text>
                        <Text fontFamily='"Press Start 2P", monospace' fontSize="24px" color="#00ffea">
                            {matchHistory?.history && matchHistory.history.length > 0 ?
                                ((matchHistory.history.filter(outcome => outcome === 2).length / matchHistory.history.length) * 100).toFixed(1) : '0.0'}%
                        </Text>
                    </div>

                    {/* Current Score */}
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                        <Text fontFamily='"Press Start 2P", monospace' fontSize="12px" color="#b8c1ff">
                            Win - Loss - Draw
                        </Text>
                        <Text fontFamily='"Press Start 2P", monospace' fontSize="24px" color="#e6e6e6">
                            {score.win}-{score.loss}-{score.draw}
                        </Text>
                    </div>
                </div>
            </div>

            {/* Main Game Area */}
            <Flex gap={4} p={3} flex="1">
                <VStack align="stretch" flex={1} spacing={3}>
                    <Box border="1px solid #2a3550" p={4} bg="#0a0f1e">
                        <HStack justify="center" spacing={6}>
                            {chant.map((c, idx) => (
                                <Text key={idx} fontFamily='"Press Start 2P", monospace' fontSize="18px" color="#00ffea" style={{ opacity: c.active ? 1 : 0.2 }}>
                                    {c.label}
                                </Text>
                            ))}
                        </HStack>
                    </Box>

                    <Box border="1px solid #2a3550" p={6} bg="#070b15">
                        <HStack justify="center" spacing={16}>
                            <VStack>
                                <Text fontFamily='"Press Start 2P", monospace' fontSize="12px" color="#b8c1ff">You</Text>
                                <Text fontFamily='"Press Start 2P", monospace' fontSize="48px">{phase === 3 ? rpsActionToEmoji(currentRecord?.my_action) : '❓'}</Text>
                                <Text fontFamily='"Press Start 2P", monospace' fontSize="10px" color="#b8c1ff">{phase === 3 ? rpsActionToLabel(currentRecord?.my_action) : ''}</Text>
                            </VStack>
                            <VStack>
                                <Text fontFamily='"Press Start 2P", monospace' fontSize="12px" color="#b8c1ff">{opponentName}</Text>
                                <Text fontFamily='"Press Start 2P", monospace' fontSize="48px">{phase === 3 ? rpsActionToEmoji(currentRecord?.opp_action) : '❓'}</Text>
                                <Text fontFamily='"Press Start 2P", monospace' fontSize="10px" color="#b8c1ff">{phase === 3 ? rpsActionToLabel(currentRecord?.opp_action) : ''}</Text>
                            </VStack>
                        </HStack>
                    </Box>

                    <VStack align="stretch" spacing={2}>
                        <HStack justify="space-between">
                            <Text fontFamily='"Press Start 2P", monospace' fontSize="10px" color="#b8c1ff">Round: {ticks.length === 0 ? 0 : currentRound + 1} / {Math.max(0, ticks.length)}</Text>
                            <Text fontFamily='"Press Start 2P", monospace' fontSize="10px" color="#b8c1ff">Speed: {speed.toFixed(2)}x</Text>
                        </HStack>
                        <Slider min={0} max={maxPhaseTicks} step={1} value={clampedPhase} onChange={setPhaseTickDisplay}>
                            <SliderTrack bg="#1a2340">
                                <SliderFilledTrack bg="#0033ff" />
                            </SliderTrack>
                            <SliderThumb />
                        </Slider>
                    </VStack>
                </VStack>
            </Flex>
        </Flex>
    )
}

function CollapsibleSection({ title, children }: { title: string; children: React.ReactNode }) {
    const [open, setOpen] = useState(false)
    return (
        <div style={{ opacity: 1 }}>
            <div
                onClick={() => setOpen(!open)}
                style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, color: '#00ffea', padding: '12px 16px', fontFamily: '"Press Start 2P", monospace', fontSize: 12, userSelect: 'none', transition: 'color 0.2s ease' }}
                onMouseEnter={(e) => (e.currentTarget.style.color = '#00ffff')}
                onMouseLeave={(e) => (e.currentTarget.style.color = '#00ffea')}
            >
                <span style={{ fontSize: 14, transition: 'transform 0.2s ease', transform: open ? 'rotate(0deg)' : 'rotate(-90deg)' }}>▼</span>
                <span>{title}</span>
            </div>
            {open && <div>{children}</div>}
        </div>
    )
}
export default RockPaperScissors
