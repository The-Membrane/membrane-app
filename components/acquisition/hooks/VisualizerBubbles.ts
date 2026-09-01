import { useEffect, useMemo, MutableRefObject, RefObject } from 'react'
import { calculatePoints } from '@/hooks/useAcquisition'
import {
    PhysicsBubble,
    VisualizerAllocation,
    VisualizerCalculatedData,
    simulateFluidLayout,
    generateCyberpunkColorPalette,
    getColorFromPalette,
} from '../VisualizerPhysics'

interface UseVisualizerBubblesParams {
    allocations: VisualizerAllocation[]
    debouncedDeposit: number
    debouncedLockDays: number
    previousBubblePositions: MutableRefObject<Map<string, { x: number; y: number }>>
    canvasRef: RefObject<HTMLCanvasElement>
}

/**
 * Owns the visualizer's derived allocation data, the force-directed bubble
 * layout, and the canvas draw effect. Canvas ref + effect lifecycles are kept
 * exactly as they were inline in AcquisitionVisualizer.
 */
export const useVisualizerBubbles = ({
    allocations,
    debouncedDeposit,
    debouncedLockDays,
    previousBubblePositions,
    canvasRef,
}: UseVisualizerBubblesParams): { calculatedData: VisualizerCalculatedData } => {
    // Calculate allocations including hypothetical user
    const calculatedData = useMemo(() => {
        // Only add hypothetical user if deposit amount is greater than 0
        const allAllocations = [...allocations]

        if (debouncedDeposit > 0) {
            // Add hypothetical user's deposit
            const hypotheticalPoints = calculatePoints(debouncedDeposit, debouncedLockDays)
            const hypotheticalAllocation = {
                user: 'hypothetical',
                amount: debouncedDeposit.toString(),
                lockDays: debouncedLockDays,
                points: hypotheticalPoints,
                allocation: 0, // Will be calculated after total
            }
            allAllocations.push(hypotheticalAllocation)
        }

        // Recalculate total points
        const newTotalPoints = allAllocations.reduce((sum, a) => sum + a.points, 0)

        // Recalculate allocations
        const recalculated = allAllocations.map(a => ({
            ...a,
            allocation: newTotalPoints > 0 ? a.points / newTotalPoints : 0,
        }))

        // Regroup by lock days
        const newGrouped: Record<number, typeof recalculated> = {}
        recalculated.forEach(allocation => {
            const lockDays = allocation.lockDays
            if (!newGrouped[lockDays]) {
                newGrouped[lockDays] = []
            }
            newGrouped[lockDays].push(allocation)
        })

        return {
            allocations: recalculated,
            totalPoints: newTotalPoints,
            groupedByLockDays: newGrouped,
        }
    }, [allocations, debouncedDeposit, debouncedLockDays])

    // Calculate bubble layout - all bubbles directly, no parents
    const bubbleLayout = useMemo(() => {
        const canvasWidth = 1200
        const canvasHeight = 800
        const centerX = canvasWidth / 2
        const centerY = canvasHeight / 2

        // Get all allocations (flatten all groups)
        const allAllocations = calculatedData.allocations

        if (allAllocations.length === 0) {
            return []
        }

        // Create a stable key for each bubble (user + lockDays for hypothetical, just user for real)
        const getBubbleKey = (alloc: typeof allAllocations[0]) => {
            if (alloc.user === 'hypothetical') {
                return `hypothetical_${alloc.lockDays}`
            }
            return alloc.user || `unknown_${Math.random()}`
        }

        // Calculate bubble radii (proportional to allocation)
        const physicsBubbles: PhysicsBubble[] = allAllocations.map((alloc, index) => {
            const radius = Math.sqrt(alloc.allocation) * 150 + 15 // Min 15px, scaled for visibility
            const key = getBubbleKey(alloc)

            // Try to use previous position if available
            const previousPos = previousBubblePositions.current.get(key)
            let startX: number
            let startY: number

            if (previousPos) {
                // Use previous position as starting point for stability
                startX = previousPos.x
                startY = previousPos.y
            } else {
                // Start in a rough spiral pattern for new bubbles
                const angle = (index / allAllocations.length) * Math.PI * 2
                const distance = Math.min(canvasWidth, canvasHeight) * 0.2
                startX = centerX + Math.cos(angle) * distance
                startY = centerY + Math.sin(angle) * distance
            }

            return {
                x: startX,
                y: startY,
                vx: 0,
                vy: 0,
                radius,
                allocation: alloc.allocation,
                lockDays: alloc.lockDays,
                user: alloc.user,
                isParent: false,
                _key: key, // Store key for later
            } as PhysicsBubble & { _key: string }
        })

        // Use fewer iterations for incremental updates (more stable)
        // Only do full simulation if we have many new bubbles
        const hasNewBubbles = physicsBubbles.some(b => {
            const key = (b as any)._key
            return !previousBubblePositions.current.has(key)
        })
        const iterations = hasNewBubbles ? 300 : 50 // Fewer iterations for updates

        // Simulate all bubbles with fluid physics - edges touching, no overlap
        const simulatedBubbles = simulateFluidLayout(
            physicsBubbles,
            canvasWidth,
            canvasHeight,
            iterations,
            {
                repulsionStrength: 3.0, // Very strong repulsion to prevent overlap
                attractionStrength: 0.02, // Keep them together
            }
        )

        // Store positions for next render
        simulatedBubbles.forEach(b => {
            const key = (b as any)._key
            if (key) {
                previousBubblePositions.current.set(key, { x: b.x, y: b.y })
            }
        })

        // Convert to Bubble format
        return simulatedBubbles.map(b => ({
            x: b.x,
            y: b.y,
            radius: b.radius,
            allocation: b.allocation,
            lockDays: b.lockDays,
            user: b.user,
            isParent: false,
        }))
    }, [calculatedData])

    // Render canvas
    useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return

        const ctx = canvas.getContext('2d')
        if (!ctx) return

        // Set canvas size
        canvas.width = 1200
        canvas.height = 800

        // Clear canvas
        ctx.clearRect(0, 0, canvas.width, canvas.height)

        // Generate color palette (use a good number of colors for variety)
        const colorPalette = generateCyberpunkColorPalette(12) // 12 colors in the gradient

        // Draw all bubbles directly
        bubbleLayout.forEach((bubble, index) => {
            const isHypothetical = bubble.user === 'hypothetical'

            // Use golden color for hypothetical bubble, otherwise cycle through palette
            const GOLD_COLOR = '#d4af37'
            const color = isHypothetical ? GOLD_COLOR : getColorFromPalette(index, colorPalette)

            // Draw bubble
            ctx.beginPath()
            ctx.arc(bubble.x, bubble.y, bubble.radius, 0, 2 * Math.PI)

            // Fill with fully opaque color
            ctx.fillStyle = color
            ctx.fill()

            // Stroke with glow effect (much stronger glow for golden bubble)
            ctx.shadowBlur = isHypothetical ? 40 : 15 // Much stronger glow for golden bubble
            ctx.shadowColor = color
            ctx.strokeStyle = color
            ctx.lineWidth = isHypothetical ? 4 : 2 // Thicker border for golden bubble
            ctx.stroke()
            ctx.shadowBlur = 0
        })
    }, [bubbleLayout])

    return { calculatedData }
}
