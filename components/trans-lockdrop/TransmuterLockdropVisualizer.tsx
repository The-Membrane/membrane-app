import React, { useRef, useEffect, useMemo, useState, memo } from 'react'
import { Box, VStack, HStack, Text, Slider, SliderTrack, SliderFilledTrack, SliderThumb, Button } from '@chakra-ui/react'
import { useTransmuterLockdrop, calculatePoints, useCurrentLockdrop } from '@/hooks/useTransmuterLockdrop'
import useDebounce from '@/hooks/useDebounce'
import { LockdropProgressBar } from './LockdropProgressBar'
import { useTransmuterVolumeHistory } from '@/hooks/useTransmuterData'
import { transformVolumeHistoryToChartData } from '@/services/transmuter'
import { CumulativeChart } from '@/components/DittoSpeechBox/sections/CumulativeChart'
import useTransLockdropLock from './hooks/useTransLockdropLock'
import { LockdropClaimCard } from './LockdropClaimCard'
import { useLockdropClaimsReady } from '@/components/DittoSpeechBox/hooks/useLockdropNotifications'
import { useDittoPage } from '@/components/DittoSpeechBox/hooks/useDittoPage'
import { transmuterContract } from '@/contracts/transmuterContract'
import useWallet from '@/hooks/useWallet'
import { useTransmuterData } from '@/hooks/useTransmuterData'
import { useBalanceByAsset } from '@/hooks/useBalance'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useChainRoute } from '@/hooks/useChainRoute'

const LOCK_CEILING = 365
const DEPOSIT_MIN = 0
const DEPOSIT_MAX = 10_000_000
const LOCK_DAYS_MIN = 3
const LOCK_DAYS_MAX = 365
const DEBOUNCE_DELAY = 200 // ms

interface Bubble {
    x: number
    y: number
    radius: number
    allocation: number
    lockDays: number
    user?: string
    isParent: boolean
    children?: Bubble[]
}

/**
 * Force-directed physics simulation for fluid-like bubble layout
 */
interface PhysicsBubble {
    x: number
    y: number
    vx: number // velocity x
    vy: number // velocity y
    radius: number
    allocation: number
    lockDays: number
    user?: string
    isParent: boolean
    children?: PhysicsBubble[]
}

/**
 * Simulate bubbles in fluid with force-directed layout
 * Bubbles edges are in contact (touching) but NOT overlapping
 */
const simulateFluidLayout = (
    bubbles: PhysicsBubble[],
    width: number,
    height: number,
    iterations: number = 100,
    options?: {
        attractionStrength?: number
        repulsionStrength?: number
    }
): PhysicsBubble[] => {
    const centerX = width / 2
    const centerY = height / 2
    const damping = 0.85 // Fluid damping
    const repulsionStrength = options?.repulsionStrength ?? 2.0 // Strong repulsion to prevent overlap
    const attractionStrength = options?.attractionStrength ?? 0.01 // How much bubbles are attracted to center

    // Initialize velocities if not present
    bubbles.forEach(b => {
        if (b.vx === undefined) b.vx = 0
        if (b.vy === undefined) b.vy = 0
    })

    for (let iter = 0; iter < iterations; iter++) {
        // Multiple passes: resolve overlaps by directly moving bubbles apart
        // Run overlap resolution multiple times per iteration for better convergence
        for (let pass = 0; pass < 3; pass++) {
            for (let i = 0; i < bubbles.length; i++) {
                const bubble = bubbles[i]

                for (let j = i + 1; j < bubbles.length; j++) {
                    const other = bubbles[j]
                    const dx = bubble.x - other.x
                    const dy = bubble.y - other.y
                    const distance = Math.sqrt(dx * dx + dy * dy)

                    // Avoid division by zero
                    if (distance < 0.01) {
                        // Bubbles are on top of each other - separate them
                        const angle = Math.random() * Math.PI * 2
                        const separation = (bubble.radius + other.radius) * 1.1
                        bubble.x = other.x + Math.cos(angle) * separation
                        bubble.y = other.y + Math.sin(angle) * separation
                        continue
                    }

                    const minDistance = bubble.radius + other.radius // Exact touching distance (no gap, no overlap)

                    if (distance < minDistance) {
                        // Overlap detected - push bubbles apart directly
                        const overlap = minDistance - distance
                        const angle = Math.atan2(dy, dx)
                        // Move proportionally based on bubble sizes (larger bubble moves less)
                        const totalRadius = bubble.radius + other.radius
                        const bubbleMoveRatio = other.radius / totalRadius
                        const otherMoveRatio = bubble.radius / totalRadius

                        const moveX = Math.cos(angle) * overlap
                        const moveY = Math.sin(angle) * overlap

                        // Move both bubbles apart proportionally
                        bubble.x += moveX * bubbleMoveRatio
                        bubble.y += moveY * bubbleMoveRatio
                        other.x -= moveX * otherMoveRatio
                        other.y -= moveY * otherMoveRatio
                    }
                }
            }
        }

        // Second pass: apply forces for fluid-like motion
        for (let i = 0; i < bubbles.length; i++) {
            const bubble = bubbles[i]
            let fx = 0 // force x
            let fy = 0 // force y

            // Repulsion from other bubbles (when too close)
            for (let j = 0; j < bubbles.length; j++) {
                if (i === j) continue

                const other = bubbles[j]
                const dx = bubble.x - other.x
                const dy = bubble.y - other.y
                const distance = Math.sqrt(dx * dx + dy * dy) || 0.01
                const targetDistance = bubble.radius + other.radius // Exact touching distance

                if (distance < targetDistance) {
                    // Strong repulsion when overlapping
                    const overlap = targetDistance - distance
                    const force = (overlap / targetDistance) * repulsionStrength
                    const angle = Math.atan2(dy, dx)
                    fx += Math.cos(angle) * force
                    fy += Math.sin(angle) * force
                } else if (distance > targetDistance * 1.05) {
                    // Weak attraction when slightly too far (keeps them in contact)
                    const gap = distance - targetDistance
                    const force = (gap / targetDistance) * 0.15 // Weak attraction
                    const angle = Math.atan2(dy, dx)
                    fx -= Math.cos(angle) * force
                    fy -= Math.sin(angle) * force
                }
            }

            // Attraction to center (keeps bubbles together)
            const dxCenter = centerX - bubble.x
            const dyCenter = centerY - bubble.y
            const distToCenter = Math.sqrt(dxCenter * dxCenter + dyCenter * dyCenter)
            if (distToCenter > 0) {
                fx += (dxCenter / distToCenter) * attractionStrength * 100
                fy += (dyCenter / distToCenter) * attractionStrength * 100
            }

            // Update velocity (fluid-like motion)
            bubble.vx = (bubble.vx + fx) * damping
            bubble.vy = (bubble.vy + fy) * damping

            // Limit velocity to prevent instability
            const maxVel = 5
            const vel = Math.sqrt(bubble.vx * bubble.vx + bubble.vy * bubble.vy)
            if (vel > maxVel) {
                bubble.vx = (bubble.vx / vel) * maxVel
                bubble.vy = (bubble.vy / vel) * maxVel
            }

            // Update position
            bubble.x += bubble.vx
            bubble.y += bubble.vy

            // Boundary constraints (bounce off walls)
            const margin = bubble.radius
            if (bubble.x < margin) {
                bubble.x = margin
                bubble.vx *= -0.5
            }
            if (bubble.x > width - margin) {
                bubble.x = width - margin
                bubble.vx *= -0.5
            }
            if (bubble.y < margin) {
                bubble.y = margin
                bubble.vy *= -0.5
            }
            if (bubble.y > height - margin) {
                bubble.y = height - margin
                bubble.vy *= -0.5
            }
        }
    }

    // Final pass: ensure no overlaps remain - run multiple times
    for (let finalPass = 0; finalPass < 10; finalPass++) {
        let hasOverlap = false
        for (let i = 0; i < bubbles.length; i++) {
            const bubble = bubbles[i]
            for (let j = i + 1; j < bubbles.length; j++) {
                const other = bubbles[j]
                const dx = bubble.x - other.x
                const dy = bubble.y - other.y
                const distance = Math.sqrt(dx * dx + dy * dy)

                if (distance < 0.01) {
                    // Bubbles are on top of each other - separate them
                    const angle = Math.random() * Math.PI * 2
                    const separation = (bubble.radius + other.radius) * 1.1
                    bubble.x = other.x + Math.cos(angle) * separation
                    bubble.y = other.y + Math.sin(angle) * separation
                    hasOverlap = true
                    continue
                }

                const minDistance = bubble.radius + other.radius

                if (distance < minDistance) {
                    // Final correction - push apart
                    const overlap = minDistance - distance
                    const angle = Math.atan2(dy, dx)
                    // Move proportionally based on bubble sizes
                    const totalRadius = bubble.radius + other.radius
                    const bubbleMoveRatio = other.radius / totalRadius
                    const otherMoveRatio = bubble.radius / totalRadius

                    const moveX = Math.cos(angle) * overlap
                    const moveY = Math.sin(angle) * overlap

                    bubble.x += moveX * bubbleMoveRatio
                    bubble.y += moveY * bubbleMoveRatio
                    other.x -= moveX * otherMoveRatio
                    other.y -= moveY * otherMoveRatio
                    hasOverlap = true
                }
            }
        }
        // If no overlaps found, we're done
        if (!hasOverlap) break
    }

    return bubbles
}

/**
 * Pack child bubbles inside parent using force-directed layout
 */
const packCircles = (
    parentRadius: number,
    children: Array<{ radius: number; allocation: number; lockDays: number; user?: string }>
): Bubble[] => {
    if (children.length === 0) return []

    // Sort by radius (largest first) for better packing
    const sorted = [...children].sort((a, b) => b.radius - a.radius)

    // Initialize physics bubbles in a rough circle
    const physicsBubbles: PhysicsBubble[] = sorted.map((child, i) => {
        const angle = (i / sorted.length) * Math.PI * 2
        const distance = parentRadius * 0.3
        return {
            x: Math.cos(angle) * distance,
            y: Math.sin(angle) * distance,
            vx: 0,
            vy: 0,
            radius: child.radius,
            allocation: child.allocation,
            lockDays: child.lockDays,
            user: child.user,
            isParent: false,
        }
    })

    // Simulate physics within parent bounds - children should be in contact
    const simulated = simulateFluidLayout(
        physicsBubbles,
        parentRadius * 2,
        parentRadius * 2,
        300,
        {
            repulsionStrength: 3.0, // Very strong repulsion to prevent overlap
            attractionStrength: 0.02, // Keep them together within parent
        }
    )

    // Constrain to parent radius
    simulated.forEach(bubble => {
        const dist = Math.sqrt(bubble.x * bubble.x + bubble.y * bubble.y)
        const maxDist = parentRadius - bubble.radius - 2
        if (dist > maxDist) {
            const angle = Math.atan2(bubble.y, bubble.x)
            bubble.x = Math.cos(angle) * maxDist
            bubble.y = Math.sin(angle) * maxDist
        }
    })

    // Convert to Bubble format
    return simulated.map(b => ({
        x: b.x,
        y: b.y,
        radius: b.radius,
        allocation: b.allocation,
        lockDays: b.lockDays,
        user: b.user,
        isParent: false,
    }))
}

/**
 * Generate a set of cyberpunk colors from the bluish purple gradient
 */
const generateCyberpunkColorPalette = (numColors: number): string[] => {
    const colors: string[] = []
    // Gradient from blue-cyan to purple (bluish purple cyberpunk scheme)
    // Blue-cyan: rgb(0, 191, 255) -> Purple: rgb(166, 146, 255)
    for (let i = 0; i < numColors; i++) {
        const ratio = i / (numColors - 1 || 1) // Avoid division by zero
        const r = Math.floor(0 + ratio * 166)
        const g = Math.floor(191 + ratio * (146 - 191))
        const b = Math.floor(255 + ratio * (255 - 255))
        colors.push(`rgb(${r}, ${g}, ${b})`)
    }
    return colors
}

/**
 * Get color from palette by cycling through available colors
 */
const getColorFromPalette = (index: number, palette: string[]): string => {
    return palette[index % palette.length]
}

export const TransmuterLockdropVisualizer: React.FC = () => {
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const [depositAmount, setDepositAmount] = useState(1_000_000)
    const [lockDays, setLockDays] = useState(180)
    const { allocations, totalPoints, groupedByLockDays, isLoading } = useTransmuterLockdrop()
    const { data: currentLockdrop } = useCurrentLockdrop()
    const { data: volumeHistory } = useTransmuterVolumeHistory(100)
    const { claimsReady, claimableAmount } = useLockdropClaimsReady()
    const { address } = useWallet()
    const { chainName } = useChainRoute()
    const { tvl: transmuterTVL } = useTransmuterData()
    
    // Get balance for Ditto facts
    const usdcAsset = useAssetBySymbol('USDC', chainName)
    const cdtAsset = useAssetBySymbol('CDT', chainName)
    const usdcBalance = useBalanceByAsset(usdcAsset)
    const cdtBalance = useBalanceByAsset(cdtAsset)

    // Lock hook - use debounced values for amount and lock days
    const debouncedDepositForHook = useDebounce(depositAmount, 300)
    const debouncedLockDaysForHook = useDebounce(lockDays, 300)

    const lockHook = useTransLockdropLock({
        lockDays: debouncedLockDaysForHook,
        amount: debouncedDepositForHook.toString(),
        txSuccess: () => {
            console.log('Lock successful!')
        },
    })

    const handleLock = async () => {
        if (!lockHook.action?.simulate?.data) return
        await lockHook.action.tx.mutateAsync()
    }
    const volumeChartData = useMemo(() => {
        if (!volumeHistory?.records) return []
        return transformVolumeHistoryToChartData(volumeHistory.records)
    }, [volumeHistory])

    // Store previous bubble positions for stability
    const previousBubblePositions = useRef<Map<string, { x: number; y: number }>>(new Map())
    
    // =====================
    // DITTO INTEGRATION
    // =====================
    
    // Calculate user's lockdrop position
    const userLockdropPosition = useMemo(() => {
        const userAllocation = allocations.find(a => a.user === address)
        if (!userAllocation) return null
        return {
            amount: userAllocation.allocation || 0,
            lockDays: userAllocation.lockDays || 0,
            mbrnAllocation: userAllocation.allocation || 0,
        }
    }, [allocations, address])
    
    // Calculate swap capacities (simplified - would need actual transmuter data)
    const swapCapacity = useMemo(() => {
        const tvl = transmuterTVL || 0
        return {
            cdtToUsdc: tvl * 0.5, // Simplified estimate
            usdcToCdt: tvl * 0.5,
            utilization: 50, // Would need actual calculation
        }
    }, [transmuterTVL])
    
    // Ditto page integration
    const ditto = useDittoPage({
        contract: transmuterContract,
        facts: {
            // Capacity facts
            cdtToUsdcCapacity: swapCapacity.cdtToUsdc,
            usdcToCdtCapacity: swapCapacity.usdcToCdt,
            totalCapacity: transmuterTVL || 0,
            capacityUtilization: swapCapacity.utilization,
            
            // Swap facts
            swapAmount: 0, // Would be set when user inputs swap amount
            swapDirection: 'cdt-to-usdc',
            canSwap: swapCapacity.cdtToUsdc > 0,
            swapRate: 1.0, // Would need actual rate
            
            // Balance facts
            cdtBalance: parseFloat(cdtBalance || '0') / 1e6,
            usdcBalance: parseFloat(usdcBalance || '0') / 1e6,
            hasBalance: parseFloat(cdtBalance || '0') > 0 || parseFloat(usdcBalance || '0') > 0,
            
            // Lockdrop facts
            hasLockdrop: !!userLockdropPosition,
            lockdropAmount: userLockdropPosition?.amount || 0,
            lockdropMBRN: userLockdropPosition?.mbrnAllocation || 0,
            lockdropUnlockTime: userLockdropPosition ? `${userLockdropPosition.lockDays} days` : '',
            isLockdropClaimable: claimsReady,
            
            // Connection facts
            isConnected: !!address,
        },
        onShortcut: (shortcutId: string, action: string) => {
            switch (action) {
                case 'claimLockdrop':
                    // Would trigger lockdrop claim
                    break
                case 'setMaxSwap':
                    // Would set max swap amount
                    break
                case 'showLockdropDetails':
                    // Scroll to lockdrop section
                    document.querySelector('[data-section="lockdrop"]')?.scrollIntoView({
                        behavior: 'smooth',
                        block: 'center'
                    })
                    break
                case 'openLockdrop':
                    // Focus on deposit amount input
                    break
            }
        },
    })

    // Debug logging
    useEffect(() => {
        console.log('Visualizer data:', {
            allocationsCount: allocations.length,
            totalPoints,
            groupedByLockDaysKeys: Object.keys(groupedByLockDays),
            isLoading,
        })
    }, [allocations.length, totalPoints, groupedByLockDays, isLoading])

    // Debounce slider values
    const debouncedDeposit = useDebounce(depositAmount, DEBOUNCE_DELAY)
    const debouncedLockDays = useDebounce(lockDays, DEBOUNCE_DELAY)

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

    if (isLoading) {
        return (
            <Box
                w="100%"
                h="100vh"
                display="flex"
                alignItems="center"
                justifyContent="center"
                bg="#0A0A0A"
                color="purple.300"
                fontFamily="mono"
            >
                <Text>Loading lockdrop data...</Text>
            </Box>
        )
    }

    return (
        <Box
            w="100%"
            minH="100vh"
            bg="#0A0A0A"
            position="relative"
            p={8}
        >
            {/* Page Title */}
            <Text
                fontSize="4xl"
                fontWeight="bold"
                bgGradient="linear(to-r, purple.400, cyan.400)"
                bgClip="text"
                fontFamily="mono"
                textAlign="left"
                w="100%"
                maxW="1400px"
                mx="auto"
                mb={4}
            >
                Transmuter
            </Text>

            {/* Volume Chart */}
            {volumeChartData.length > 0 && (
                <Box mt={8} mb={8}>
                    <Text fontSize="sm" color="gray.400" mb={3}>
                        All-Time Volume
                    </Text>
                    <CumulativeChart data={volumeChartData} isLoading={false} />
                </Box>
            )}
            {/* Etch-a-sketch frame */}
            <Box
                position="relative"
                maxW="1400px"
                mx="auto"
                bg="rgba(20, 20, 30, 0.8)"
                borderRadius="lg"
                border="3px solid"
                borderColor="purple.400"
                p={6}
                boxShadow="0 0 40px rgba(166, 146, 255, 0.3)"
            >
                {/* Title */}
                <VStack spacing="27px" mb={6}>
                    <Text
                        fontSize="2xl"
                        fontWeight="bold"
                        color="white"
                        fontFamily="mono"
                    >
                        LOCKDROP
                    </Text>
                    <LockdropProgressBar
                        startTime={currentLockdrop?.lockdrop?.start_time}
                        depositEnd={currentLockdrop?.lockdrop?.deposit_end}
                        withdrawalEnd={currentLockdrop?.lockdrop?.withdrawal_end}
                    />
                </VStack>

                {/* Canvas Screen */}
                <Box
                    position="relative"
                    w="100%"
                    bg="rgba(10, 10, 15, 0.9)"
                    borderRadius="md"
                    border="2px solid"
                    borderColor="purple.500"
                    p={4}
                    mb={6}
                    boxShadow="inset 0 0 30px rgba(0, 0, 0, 0.5)"
                >
                    <canvas
                        ref={canvasRef}
                        style={{
                            width: '100%',
                            height: 'auto',
                            display: 'block',
                            imageRendering: 'crisp-edges',
                        }}
                    />
                </Box>

                {/* Sliders (Etch-a-sketch knobs) */}
                <HStack spacing={8} justify="center" flexWrap="wrap">
                    {/* Deposit Slider */}
                    <VStack spacing={3} minW="300px" maxW="400px">
                        <Text
                            fontSize="lg"
                            fontWeight="bold"
                            color="cyan.400"
                            fontFamily="mono"
                        >
                            DEPOSIT AMOUNT
                        </Text>
                        <Box
                            position="relative"
                            w="100%"
                            bg="rgba(20, 20, 30, 0.6)"
                            borderRadius="full"
                            p={4}
                            border="2px solid"
                            borderColor="cyan.400"
                        >
                            <Slider
                                min={DEPOSIT_MIN}
                                max={DEPOSIT_MAX}
                                value={depositAmount}
                                onChange={setDepositAmount}
                                step={10000}
                            >
                                <SliderTrack bg="gray.700" h="4px">
                                    <SliderFilledTrack bg="cyan.400" />
                                </SliderTrack>
                                <SliderThumb
                                    boxSize={8}
                                    bg="cyan.400"
                                    border="2px solid"
                                    borderColor="white"
                                    boxShadow="0 0 10px rgba(0, 191, 255, 0.5)"
                                />
                            </Slider>
                        </Box>
                        <Text
                            fontSize="xl"
                            fontWeight="bold"
                            color="cyan.300"
                            fontFamily="mono"
                        >
                            {depositAmount.toLocaleString()} USDC
                        </Text>
                    </VStack>

                    {/* Lock Days Slider */}
                    <VStack spacing={3} minW="300px" maxW="400px">
                        <Text
                            fontSize="lg"
                            fontWeight="bold"
                            color="purple.400"
                            fontFamily="mono"
                        >
                            LOCK DAYS
                        </Text>
                        <Box
                            position="relative"
                            w="100%"
                            bg="rgba(20, 20, 30, 0.6)"
                            borderRadius="full"
                            p={4}
                            border="2px solid"
                            borderColor="purple.400"
                        >
                            <Slider
                                min={LOCK_DAYS_MIN}
                                max={LOCK_DAYS_MAX}
                                value={lockDays}
                                onChange={setLockDays}
                                step={1}
                            >
                                <SliderTrack bg="gray.700" h="4px">
                                    <SliderFilledTrack bg="purple.400" />
                                </SliderTrack>
                                <SliderThumb
                                    boxSize={8}
                                    bg="purple.400"
                                    border="2px solid"
                                    borderColor="white"
                                    boxShadow="0 0 10px rgba(166, 146, 255, 0.5)"
                                />
                            </Slider>
                        </Box>
                        <Text
                            fontSize="xl"
                            fontWeight="bold"
                            color="purple.300"
                            fontFamily="mono"
                        >
                            {lockDays} DAYS
                        </Text>
                    </VStack>
                </HStack>

                {/* Stats */}
                <HStack
                    spacing={6}
                    justify="center"
                    mt={6}
                    flexWrap="wrap"
                    fontFamily="mono"
                >
                    <VStack spacing={1}>
                        <Text fontSize="xs" color="gray.400">
                            TOTAL POINTS
                        </Text>
                        <Text fontSize="lg" color="purple.300" fontWeight="bold">
                            {calculatedData.totalPoints.toLocaleString(undefined, {
                                maximumFractionDigits: 2,
                            })}
                        </Text>
                    </VStack>
                    <VStack spacing={1}>
                        <Text fontSize="xs" color="gray.400">
                            YOUR SHARE
                        </Text>
                        <Text fontSize="lg" color="cyan.300" fontWeight="bold">
                            {debouncedDeposit > 0
                                ? ((
                                    calculatedData.allocations.find(a => a.user === 'hypothetical')
                                        ?.allocation || 0
                                ) * 100).toFixed(2)
                                : 0}
                            %
                        </Text>
                    </VStack>
                    <VStack spacing={1}>
                        <Text fontSize="xs" color="gray.400">
                            YOUR ALLOCATION
                        </Text>
                        <Text fontSize="lg" color="purple.300" fontWeight="bold">
                            {debouncedDeposit > 0
                                ? (
                                    (calculatedData.allocations.find(a => a.user === 'hypothetical')
                                        ?.allocation || 0) * 10_000_000
                                ).toLocaleString(undefined, {
                                    maximumFractionDigits: 0,
                                })
                                : '0'}
                            {' '}MBRN
                        </Text>
                    </VStack>
                </HStack>

                {/* Lock Button */}
                <VStack mt={8} spacing={2}>
                    <Button
                        size="lg"
                        bg="purple.500"
                        color="white"
                        fontFamily="mono"
                        fontWeight="bold"
                        px={12}
                        py={6}
                        fontSize="lg"
                        borderRadius="full"
                        border="2px solid"
                        borderColor="purple.300"
                        boxShadow="0 0 20px rgba(166, 146, 255, 0.4)"
                        isLoading={lockHook.action?.tx?.isPending}
                        isDisabled={!lockHook.action?.simulate?.data || depositAmount <= 0}
                        onClick={handleLock}
                        _hover={{
                            bg: 'purple.400',
                            boxShadow: '0 0 30px rgba(166, 146, 255, 0.6)',
                            transform: 'scale(1.02)',
                        }}
                        _active={{
                            transform: 'scale(0.98)',
                        }}
                        transition="all 0.2s"
                    >
                        Lock {depositAmount.toLocaleString()} USDC for {lockDays} Days
                    </Button>
                    {!lockHook.action?.simulate?.data && depositAmount > 0 && (
                        <Text fontSize="xs" color="gray.500" fontFamily="mono">
                            Preparing transaction...
                        </Text>
                    )}
                </VStack>

                {/* Claim Card */}
                {claimsReady && claimableAmount > 0 && (
                    <VStack mt={8} spacing={2}>
                        <LockdropClaimCard
                            claimableAmount={claimableAmount}
                            onClaimSuccess={() => {
                                // Refresh data after claim
                            }}
                        />
                    </VStack>
                )}
            </Box>
        </Box>
    )
}

