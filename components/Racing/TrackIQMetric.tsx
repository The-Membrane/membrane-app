import React, { useMemo } from 'react'
import { Box, HStack, Text, VStack, Flex, Icon, Tooltip as ChakraTooltip } from '@chakra-ui/react'
import { BrainCircuit } from 'lucide-react'
import { Track, useCarQTable } from '@/services/q-racing'
import useAppState from '@/persisted-state/useAppState'

interface TrackIQMetricProps {
    track: Track
    carId?: string
}

// Tile types matching the race engine
enum TileFlag {
    Wall = 0,
    Sticky = 1,
    Boost = 2,
    Finish = 3,
    Normal = 4
}

// Directions: Up, Down, Left, Right
const DIRS = [[0, -1], [0, 1], [-1, 0], [1, 0]] as const

// Convert track tile character to TileFlag (matching race engine logic)
function getTileFlag(tile: string): TileFlag {
    switch (tile) {
        case 'W': return TileFlag.Wall      // blocks_movement = true
        case 'K': return TileFlag.Sticky    // skip_next_turn = true
        case 'B': return TileFlag.Boost     // speed_modifier > 1
        case 'F': return TileFlag.Finish    // is_finish = true
        case 'S': return TileFlag.Normal    // is_start = true (treated as normal)
        case 'E': return TileFlag.Normal    // default normal tile
        default: return TileFlag.Normal
    }
}

// Generate state hash for a position (matching race engine logic)
function generateStateHash(track: Track, x: number, y: number, speed: number = 1): number {
    let key = 0

    for (let i = 0; i < DIRS.length; i++) {
        const [dx, dy] = DIRS[i] as [number, number]
        const tx = x + dx * speed
        const ty = y + dy * speed

        let flag = TileFlag.Normal

        // Check bounds
        if (tx < 0 || ty < 0 || ty >= track.length || tx >= track[0].length) {
            flag = TileFlag.Wall
        } else {
            const tile = track[ty][tx]
            flag = getTileFlag(tile)
        }

        // Pack into 4 bits and shift into position
        key |= (flag << (i * 4))
    }

    return key
}

// Calculate all possible states for a track
function calculateTrackStates(track: Track): number[] {
    const states = new Set<number>()
    const stateDetails: Array<{ x: number, y: number, tile: string, stateHash: number }> = []

    // Count finish tiles to determine if we should include them
    let finishTileCount = 0
    for (let y = 0; y < track.length; y++) {
        for (let x = 0; x < track[y].length; x++) {
            if (track[y][x] === 'F') {
                finishTileCount++
            }
        }
    }

    console.log(`TrackIQMetric: Track analysis - ${track.length}x${track[0]?.length} grid, ${finishTileCount} finish tiles`)

    // Iterate through all positions on the track
    for (let y = 0; y < track.length; y++) {
        for (let x = 0; x < track[y].length; x++) {
            const tile = track[y][x]

            // Only consider non-wall positions
            if (tile !== 'W') {
                // Skip finish tiles unless there are multiple finish tiles
                if (tile === 'F' && finishTileCount <= 1) {
                    console.log(`TrackIQMetric: Skipping single finish tile at (${x}, ${y})`)
                    continue
                }

                // Generate state hash for this position
                const stateHash = generateStateHash(track, x, y, 1)
                states.add(stateHash)
                stateDetails.push({ x, y, tile, stateHash })
            }
        }
    }

    console.log('TrackIQMetric: Possible states for track:', stateDetails)
    console.log(`TrackIQMetric: Total possible states: ${states.size}`)

    return Array.from(states)
}

const TrackIQMetric: React.FC<TrackIQMetricProps> = ({ track, carId }) => {
    const { appState } = useAppState()
    const { data: qTableData, isLoading, error } = useCarQTable(carId, appState.rpcUrl)

    // Debug logging (disabled for production)
    // console.log('TrackIQMetric Debug:', {
    //     track: track ? `${track.length}x${track[0]?.length}` : 'null',
    //     carId,
    //     qTableData: qTableData ? `${qTableData.q_values.length} entries` : 'null',
    //     isLoading,
    //     error
    // })

    const trackIQ = useMemo(() => {
        if (!track || !qTableData) {
            // console.log('TrackIQMetric: Missing data', { track: !!track, qTableData: !!qTableData })
            return { percentage: 0, statesSeen: 0, totalStates: 0, wallCollisions: 0 }
        }

        // Calculate all possible states for this track
        const possibleStates = calculateTrackStates(track)
        const totalStates = possibleStates.length

        // console.log('TrackIQMetric: Track analysis', {
        //     possibleStates: possibleStates.length,
        //     trackSize: `${track.length}x${track[0]?.length}`,
        //     sampleStates: possibleStates.slice(0, 5)
        // })

        if (totalStates === 0) {
            // console.log('TrackIQMetric: No possible states found')
            return { percentage: 0, statesSeen: 0, totalStates: 0, wallCollisions: 0 }
        }

        // Create a map of state hash to Q-values for quick lookup
        const qValuesMap = new Map<number, [number, number, number, number]>()
        qTableData.q_values.forEach(q => {
            let stateHash: number
            if (typeof q.state_hash === 'string') {
                stateHash = parseInt(q.state_hash)
            } else if (Array.isArray(q.state_hash)) {
                // Convert byte array to number (simple hash)
                stateHash = q.state_hash.reduce((acc, byte, index) => acc + (byte << (index * 8)), 0)
            } else {
                stateHash = q.state_hash
            }
            qValuesMap.set(stateHash, q.action_values)
        })

        // console.log('TrackIQMetric: Q-values analysis', {
        //     qValuesCount: qTableData.q_values.length,
        //     qValuesMapSize: qValuesMap.size,
        //     sampleQValues: Array.from(qValuesMap.entries()).slice(0, 3)
        // })

        let statesSeen = 0
        let wallCollisions = 0

        // Check each possible state
        const matchedStates: number[] = []
        const unmatchedStates: number[] = []

        console.log('TrackIQMetric: Checking states against QTable...')

        possibleStates.forEach(stateHash => {
            const qValues = qValuesMap.get(stateHash)
            if (qValues) {
                statesSeen++
                matchedStates.push(stateHash)
                console.log(`TrackIQMetric: ✓ State ${stateHash} found in QTable with values: [${qValues.join(', ')}]`)

                // Check if the preferred action leads to a wall
                const maxQ = Math.max(...qValues)
                const preferredAction = qValues.indexOf(maxQ)

                // Decode state hash to check if preferred action leads to wall
                const tileUp = (stateHash & 0xF) as TileFlag
                const tileDown = ((stateHash >> 4) & 0xF) as TileFlag
                const tileLeft = ((stateHash >> 8) & 0xF) as TileFlag
                const tileRight = ((stateHash >> 12) & 0xF) as TileFlag

                const tiles = [tileUp, tileDown, tileLeft, tileRight]
                if (tiles[preferredAction] === TileFlag.Wall) {
                    wallCollisions++
                    console.log(`TrackIQMetric: ⚠️ Wall collision detected: stateHash=${stateHash}, preferredAction=${preferredAction}, tiles=[${tiles.join(',')}]`)
                }
            } else {
                unmatchedStates.push(stateHash)
                console.log(`TrackIQMetric: ✗ State ${stateHash} NOT found in QTable`)
            }
        })

        console.log('TrackIQMetric: State matching summary:', {
            totalPossibleStates: possibleStates.length,
            matchedStates: matchedStates.length,
            unmatchedStates: unmatchedStates.length,
            wallCollisions,
            matchedStateHashes: matchedStates,
            unmatchedStateHashes: unmatchedStates
        })

        // Calculate effective states seen (subtract wall collisions)
        const effectiveStatesSeen = Math.max(0, statesSeen - wallCollisions)
        const percentage = (effectiveStatesSeen / totalStates) * 100

        const result = {
            percentage: Math.max(0, Math.min(100, percentage)),
            statesSeen,
            totalStates,
            wallCollisions
        }

        // console.log('TrackIQMetric: Final calculation', result)

        return result
    }, [track, qTableData])

    const brainFillPercentage = trackIQ.percentage / 100

    // Show loading or error state
    if (isLoading) {
        return (
            <HStack spacing={2} align="center">
                <Text fontFamily='"Press Start 2P", monospace' fontSize="18px" color="#666">
                    Track IQ: Loading...
                </Text>
            </HStack>
        )
    }

    if (error) {
        return (
            <HStack spacing={2} align="center">
                <Text fontFamily='"Press Start 2P", monospace' fontSize="18px" color="#ff6b6b">
                    Track IQ: Error
                </Text>
            </HStack>
        )
    }

    return (
        <HStack spacing={2} align="center">
            <Text
                fontFamily='"Press Start 2P", monospace'
                fontSize="18px"
                color="#b8c1ff"
            >
                Track IQ
            </Text>
            <Text
                fontFamily='"Press Start 2P", monospace'
                fontSize="18px"
                color="#b8c1ff"
            >
                {trackIQ.percentage.toFixed(1)}%
            </Text>
            <ChakraTooltip
                label={`${trackIQ.statesSeen - trackIQ.wallCollisions} / ${trackIQ.totalStates} states learned`}
                placement="top"
                hasArrow
                bg="#0a0f1e"
                color="#00ffea"
                border="1px solid #2a3550"
                borderRadius="4px"
                fontFamily='"Press Start 2P", monospace'
                fontSize="10px"
                px={2}
                py={1}
            >
                <Box position="relative" w="20px" h="20px" cursor="pointer">
                    <Icon
                        as={BrainCircuit}
                        w="20px"
                        h="20px"
                        color="#2a3550"
                    />
                    <Box
                        position="absolute"
                        top="0"
                        left="0"
                        w="20px"
                        h="20px"
                        overflow="hidden"
                        style={{
                            clipPath: `inset(${100 - (brainFillPercentage * 100)}% 0 0 0)`
                        }}
                    >
                        <Icon
                            as={BrainCircuit}
                            w="20px"
                            h="20px"
                            color="#00ffea"
                        />
                    </Box>
                </Box>
            </ChakraTooltip>
        </HStack>
    )
}

export default TrackIQMetric
