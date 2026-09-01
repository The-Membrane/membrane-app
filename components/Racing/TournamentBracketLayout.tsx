import React from 'react'
import { Box, Text } from '@chakra-ui/react'
import { CurrentBracket, TournamentState } from './hooks/useTournamentQueries'

// Component for individual bracket node
const BracketNode: React.FC<{
    carId?: number | null
    carName: string
    isWinner?: boolean
    isCompleted?: boolean
}> = ({ carId, carName, isWinner, isCompleted }) => {
    const bgColor = isCompleted
        ? (isWinner ? '#1a4d1a' : '#4d1a1a')
        : '#1a1f2e'
    const borderColor = isCompleted
        ? (isWinner ? '#7cffa0' : '#ff6b6b')
        : '#2a3550'

    return (
        <Box
            bg={bgColor}
            border="2px solid"
            borderColor={borderColor}
            borderRadius="md"
            p={3}
            minW="120px"
            textAlign="center"
            fontFamily='"Press Start 2P", monospace'
            fontSize="10px"
            color="#e6e6e6"
        >
            <Text noOfLines={1} title={carName}>
                {carName}
            </Text>
            {carId != null && (
                <Text fontSize="8px" color="#b8c1ff" mt={1}>
                    #{carId}
                </Text>
            )}
        </Box>
    )
}

// Component for bracket connector
const BracketConnector: React.FC<{
    direction: 'up' | 'down' | 'right'
}> = ({ direction }) => {
    const getConnectorStyle = () => {
        switch (direction) {
            case 'up':
                return {
                    width: '2px',
                    height: '20px',
                    bg: '#2a3550',
                    mx: 'auto',
                    mb: 1
                }
            case 'down':
                return {
                    width: '2px',
                    height: '20px',
                    bg: '#2a3550',
                    mx: 'auto',
                    mt: 1
                }
            case 'right':
                return {
                    width: '20px',
                    height: '2px',
                    bg: '#2a3550',
                    my: 'auto'
                }
            default:
                return {}
        }
    }

    return <Box {...getConnectorStyle()} />
}

// Component for horizontal connector
const HorizontalConnector: React.FC = () => (
    <Box
        width="40px"
        height="2px"
        bg="#2a3550"
        my="auto"
    />
)

// Component for vertical connector
const VerticalConnector: React.FC = () => (
    <Box
        width="2px"
        height="40px"
        bg="#2a3550"
        mx="auto"
    />
)

interface TournamentBracketLayoutProps {
    bracket: CurrentBracket | undefined
    tournamentState: TournamentState | undefined
    ownedCars: Array<{ id: string; name: string | null }> | undefined
    getCarName: (carId: number, ownedCars: any) => string
}

// Generate bracket layout in seed-tree style
const TournamentBracketLayout: React.FC<TournamentBracketLayoutProps> = ({
    bracket,
    tournamentState,
    ownedCars,
    getCarName
}) => {
    if (!bracket || !tournamentState) return null

    const totalRounds = tournamentState.total_rounds

    // Build rounds as arrays of nodes: each node is { id, leftId, rightId, winnerId }
    // For display, we simply show pairs per round stacked with vertical connectors
    const rounds: Array<Array<{
        id: string
        car1: number
        car2: number
        winner?: number
        completed: boolean
    }>> = []

    // Group incoming matches by round index 1..N (fallback to 1 for safety)
    const byRound: Record<number, typeof bracket.matches> = {}
    for (const m of bracket.matches) {
        const r: number = (m as any).round ?? tournamentState.current_round
        byRound[r] = byRound[r] || []
        byRound[r].push(m)
    }

    for (let r = 1; r <= totalRounds; r++) {
        const list = (byRound[r] || []).map(m => ({
            id: m.match_id,
            car1: m.car1,
            car2: m.car2,
            winner: m.winner,
            completed: m.completed,
        }))
        rounds.push(list)
    }

    // Convert rounds -> vertical pyramid positions
    const leafCount = 2 ** totalRounds
    const nodeW = 140
    const nodeH = 36
    const vGap = 90
    const vPadding = 20
    const width = Math.max(leafCount * (nodeW + 24) + 80, 900)
    const height = (totalRounds + 1) * vGap + vPadding * 2

    // Build names for leaves and up levels
    const leafNames: string[] = []
    const firstRound = rounds[0] || []
    for (const m of firstRound) {
        leafNames.push(getCarName(m.car1, ownedCars))
        leafNames.push(getCarName(m.car2, ownedCars))
    }
    // Upper levels (names optional until winners known)
    const upperNames: string[][] = []
    for (let lvl = 1; lvl <= totalRounds; lvl++) {
        const r = rounds[lvl] || []
        upperNames[lvl - 1] = r.map(m => (m.completed && m.winner != null) ? getCarName(m.winner, ownedCars) : '')
    }

    // positions per level
    const levels = totalRounds + 1
    const positions: { x: number, y: number }[][] = []
    for (let lvl = 0; lvl < levels; lvl++) {
        const count = 2 ** (totalRounds - lvl)
        const colWidth = width / count
        const y = height - vPadding - (lvl * vGap)
        const rowPositions = Array.from({ length: count }, (_, i) => ({
            x: Math.round((i + 0.5) * colWidth - nodeW / 2),
            y: Math.round(y - nodeH / 2),
        }))
        positions.push(rowPositions)
    }

    // SVG connectors
    const lines: { x1: number, y1: number, x2: number, y2: number }[] = []
    for (let lvl = 0; lvl < levels - 1; lvl++) {
        const parentCount = 2 ** (totalRounds - (lvl + 1))
        for (let i = 0; i < parentCount; i++) {
            const leftIdx = 2 * i
            const rightIdx = 2 * i + 1
            const parentPos = positions[lvl + 1][i]
            const leftPos = positions[lvl][leftIdx]
            const rightPos = positions[lvl][rightIdx]
            const parentX = parentPos.x + nodeW / 2
            const parentY = parentPos.y + nodeH
            const midY = parentY + (vGap - nodeH) / 2
            lines.push({ x1: leftPos.x + nodeW / 2, y1: leftPos.y, x2: leftPos.x + nodeW / 2, y2: midY })
            lines.push({ x1: rightPos.x + nodeW / 2, y1: rightPos.y, x2: rightPos.x + nodeW / 2, y2: midY })
            lines.push({ x1: leftPos.x + nodeW / 2, y1: midY, x2: rightPos.x + nodeW / 2, y2: midY })
            lines.push({ x1: parentX, y1: midY, x2: parentX, y2: parentY })
        }
    }

    return (
        <Box position="relative" width={`${width}px`} height={`${height}px`}>
            <svg width={width} height={height} style={{ position: 'absolute', top: 0, left: 0 }}>
                {lines.map((l, idx) => (
                    <line key={idx} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke="#2a3550" strokeWidth={2} />
                ))}
            </svg>
            {/* Leaves */}
            {positions[0].map((p, i) => (
                <Box key={`leaf-${firstRound[Math.floor(i / 2)]?.id ?? i}-${i % 2}`} position="absolute" left={`${p.x}px`} top={`${p.y}px`}>
                    <BracketNode carId={undefined} carName={leafNames[i] || ''} />
                </Box>
            ))}
            {/* Upper levels including champion */}
            {positions.slice(1).map((row, lvl) => (
                <React.Fragment key={`lvl-${lvl + 1}`}>
                    {row.map((p, i) => (
                        <Box key={`n-${lvl + 1}-${rounds[lvl + 1]?.[i]?.id ?? i}`} position="absolute" left={`${p.x}px`} top={`${p.y}px`}>
                            <BracketNode carId={undefined} carName={upperNames[lvl]?.[i] || ''} isWinner={lvl === levels - 2} isCompleted={upperNames[lvl]?.[i]?.length > 0} />
                        </Box>
                    ))}
                </React.Fragment>
            ))}
        </Box>
    )
}

export default TournamentBracketLayout
