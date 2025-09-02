import React, { useEffect, useMemo, useRef, useState } from 'react'
import { HStack, Text, Button, Flex } from '@chakra-ui/react'
import { formatCountdown, useSecondsUntilOpen, getAllTrackTrainingStats, JsonGetTrackTrainingStatsResponse, useValidMazeId, useWindowStatus } from '@/services/q-racing'
import { useRouter } from 'next/router'
import useRacingState from './hooks/useRacingState'
import { shiftDigits } from '@/helpers/math'
import useGenerateMaze from './hooks/useGenerateMaze'
import ConfirmModal from '@/components/ConfirmModal'
import { useByteMinterConfig } from '@/hooks/useQRacing'
import useStartWindow from './hooks/useStartWindow'

const QRacerTicker: React.FC<{ rpc?: string }> = ({ rpc }) => {
    const { data: maze } = useSecondsUntilOpen('maze', rpc)
    // PvP countdown disabled (tabled until v2)
    // const { data: pvp } = useSecondsUntilOpen('pvp', rpc)
    const { racingState, initializeSingularityTrainingSessions, setRacingState } = useRacingState()

    // Check if byte-minter has a valid maze ID
    const { data: validMazeId } = useValidMazeId(rpc)

    // Check if maze window is currently active
    const { data: windowStatus } = useWindowStatus('maze', rpc)

    // Generate maze hook
    const generateMaze = useGenerateMaze({
        onSuccess: () => {
            // Refresh the valid maze ID query after generation
            // The query will automatically refetch
        },
        setRacingState,
        validMazeId
    })

    const startWindow = useStartWindow({
        onSuccess: () => {
            // Refresh the valid maze ID query after generation
            // The query will automatically refetch
        },
        setRacingState,
        validMazeId
    })

    const router = useRouter()
    const chainName = router.query.chainName as string

    const [remaining, setRemaining] = useState<number | null>(null)
    const endAtMsRef = useRef<number | null>(null)
    const [isInitialized, setIsInitialized] = useState(false)

    // Load initial training stats for car_id 0 (The Singularity) across all tracks
    useEffect(() => {
        if (!rpc || isInitialized) return

        const loadInitialTrainingStats = async () => {
            try {
                // Training steals display disabled; keep code for later use
                // const allTrainingStats = await getAllTrackTrainingStats('0', rpc)
                // if (allTrainingStats && allTrainingStats.length > 0) {
                //     const totalCount = allTrainingStats.reduce((total: number, trackStats: JsonGetTrackTrainingStatsResponse) => {
                //         // Sum both solo and PvP training sessions
                //         return total + trackStats.stats.solo.tally + trackStats.stats.pvp.tally
                //     }, 0)
                //
                //     initializeSingularityTrainingSessions(totalCount)
                //     setIsInitialized(true)
                // }
            } catch (error) {
                console.error('Error loading initial training stats:', error)
            }
        }

        loadInitialTrainingStats()
    }, [rpc, isInitialized, initializeSingularityTrainingSessions])

    // When fresh values arrive, set a target time and start ticking locally
    useEffect(() => {
        // Use window status if available, otherwise fall back to maze countdown
        const countdownSeconds = windowStatus?.is_active
            ? windowStatus.seconds_until_close
            : (maze ?? Number.POSITIVE_INFINITY)

        if (!isFinite(countdownSeconds)) {
            endAtMsRef.current = null
            setRemaining(null)
            return
        }

        const now = Date.now()
        endAtMsRef.current = now + countdownSeconds * 1000
        setRemaining(Math.max(0, Math.ceil((endAtMsRef.current - now) / 1000)))

        const id = setInterval(() => {
            const end = endAtMsRef.current
            if (!end) return
            const left = Math.max(0, Math.ceil((end - Date.now()) / 1000))
            setRemaining(left)
        }, 1000)

        return () => clearInterval(id)
    }, [maze, windowStatus])

    const label = windowStatus?.is_active ? 'Maze window closes in' : 'Construct the Maze'
    const countdown = formatCountdown(remaining)
    const display = `${label}: ${countdown}`
    // const display2 = `${'Training Sessions Stolen by The Singularity'}: ${racingState.singularityTrainingSessions}`

    // Byte-minter config: mint amount and default difficulty
    const { data: byteMinterConfig } = useByteMinterConfig(rpc)

    return (
        <Flex
            direction={{ base: 'column', md: 'row' }}
            overflow="hidden"
            w="100%"
            bg="#071022"
            borderLeft="2px solid #0033ff"
            borderRight="2px solid #0033ff"
            justifyContent="space-between"
            gap={{ base: 1, md: 0 }}
            py={{ base: 1, md: 0 }}
        >
            {/* Left-aligned: Maze timer */}
            <Flex flex={1} justifyContent="flex-start" align="center">
                <Text
                    px={{ base: 2, md: 4 }}
                    py={1}
                    ml={{ base: 2, md: 8 }}
                    fontFamily="'Press Start 2P', monospace"
                    fontSize={{ base: '8px', sm: '10px', md: '14px' }}
                    color="#b8c1ff"
                    textAlign={{ base: 'center', md: 'left' }}
                >
                    {display}
                </Text>
            </Flex>
            {/* Center: Solve/Generate Maze button */}
            {windowStatus?.is_active ? (
                <Flex flex={1} justifyContent="center" align="center">

                    {validMazeId ? (
                        <Button
                            size={{ base: "xs", md: "sm" }}
                            fontSize={{ base: "8px", sm: "10px", md: "12px" }}
                            minH={{ base: "32px", md: "auto" }}
                            onClick={() => {
                                // Set the maze track as selected and switch to showcase mode
                                setRacingState({
                                    selectedTrackId: validMazeId,
                                    showTraining: false,
                                    showPvp: false
                                })
                            }}
                        >
                            Solve
                        </Button>
                    ) : (
                        <ConfirmModal
                            executeDirectly={true}
                            label="Construct Maze"
                            action={generateMaze.action}
                            isDisabled={false}
                            isLoading={generateMaze.action.simulate.isPending}
                            buttonProps={{
                                size: { base: "xs", md: "sm" },
                                fontSize: { base: "8px", sm: "10px", md: "12px" },
                                minH: { base: "32px", md: "auto" },
                                colorScheme: 'blue',
                                bg: '#274bff',
                                _hover: { bg: '#1f3bd9' },
                            }}
                        />
                    )}

                </Flex>) : (
                <ConfirmModal
                    executeDirectly={true}
                    label="Construct Maze"
                    action={startWindow.action}
                    isDisabled={false}
                    isLoading={startWindow.action.simulate.isPending}
                    buttonProps={{
                        size: { base: "xs", md: "sm" },
                        fontSize: { base: "8px", sm: "10px", md: "12px" },
                        minH: { base: "32px", md: "auto" },
                        colorScheme: 'blue',
                        bg: '#274bff',
                        _hover: { bg: '#1f3bd9' },
                    }}
                />
            )}
            {/* Right-aligned: _ BYTE | Difficulty _ */}
            <Flex flex={1} justifyContent="flex-end" align="center">
                <Text
                    px={{ base: 2, md: 4 }}
                    py={1}
                    mr={{ base: 2, md: 8 }}
                    fontFamily="'Press Start 2P', monospace"
                    fontSize={{ base: '8px', sm: '10px', md: '14px' }}
                    color="#b8c1ff"
                    textAlign={{ base: 'center', md: 'right' }}
                >
                    {(() => {
                        const amt = byteMinterConfig?.mintAmount ? shiftDigits(byteMinterConfig.mintAmount, -6).toNumber() : null
                        const amtDisplay = amt != null && !Number.isNaN(amt) ? `${amt} BYTE` : '— BYTE'
                        const diffDisplay = byteMinterConfig?.difficulty != null && !Number.isNaN(byteMinterConfig.difficulty) ? `Difficulty ${byteMinterConfig.difficulty}` : 'Difficulty —'
                        return `${amtDisplay} | ${diffDisplay}`
                    })()}
                </Text>
            </Flex>
        </Flex>
    )
}

export default QRacerTicker
