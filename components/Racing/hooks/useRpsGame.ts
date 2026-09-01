import { useEffect, useMemo, useRef, useState } from 'react'
import { useOwnedCars, useRpsTickHistory, useRpsHistory } from '@/hooks/useQRacing'
import useWallet from '@/hooks/useWallet'
import useAppState from '@/persisted-state/useAppState'
import { useAllCars } from '@/services/q-racing'
import usePlaySeries from '@/components/Racing/hooks/usePlaySeries'

const countInPhrases = ['Rock', 'Paper', 'Scissors', 'Shoot']

export function useRpsGame() {
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

    // Memoize so `ticks` keeps a stable identity across renders (the `?? []` fallback
    // otherwise builds a fresh array every render, re-running every ticks-dependent useMemo).
    const ticks = useMemo(() => tickHistory?.ticks ?? [], [tickHistory])

    const [playing, setPlaying] = useState(false)
    const [speed, setSpeed] = useState(1) // phases per second baseline
    const phaseTickRef = useRef(0)
    const [phaseTickDisplay, setPhaseTickDisplay] = useState(0) // 0..(ticks.length*4)

    // no-chain-state-updates FP: setPhaseTickDisplay/setPlaying are independent,
    // always-co-occurring resets (constants, not derived from each other or prior state)
    // that React 18 automatic batching already coalesces into a single render. Both
    // setters are also exposed and consumed independently as raw dispatch functions by
    // RpsControlPanels/RockPaperScissors (one is wired straight to a Slider's onChange),
    // so merging them into one state object would break that public API for no gain.
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

    return {
        ownedCars,
        selectedCarId,
        setSelectedCarId,
        opponentId,
        setOpponentId,
        opponentName,
        setOpponentName,
        isTraining,
        setIsTraining,
        mode,
        setMode,
        fixedTicks,
        setFixedTicks,
        bestOfWins,
        setBestOfWins,
        numberOfMatches,
        setNumberOfMatches,
        epsilon,
        setEpsilon,
        matchHistory,
        allCars,
        playSeries,
        ticks,
        playing,
        setPlaying,
        speed,
        setSpeed,
        phaseTickRef,
        phaseTickDisplay,
        setPhaseTickDisplay,
        maxPhaseTicks,
        clampedPhase,
        phase,
        currentRound,
        currentRecord,
        score,
        chant,
    }
}

export type RpsGame = ReturnType<typeof useRpsGame>

export default useRpsGame
