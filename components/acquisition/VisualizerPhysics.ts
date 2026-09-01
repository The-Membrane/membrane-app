const LOCK_CEILING = 365
export const DEPOSIT_MIN = 0
export const DEPOSIT_MAX = 10_000_000
export const LOCK_DAYS_MIN = 3
export const LOCK_DAYS_MAX = 365
export const DEBOUNCE_DELAY = 200 // ms

/**
 * A single lockdrop allocation row (as produced by useAcquisition, plus the
 * hypothetical user injected by the visualizer).
 */
export interface VisualizerAllocation {
    user: string
    amount: string
    lockDays: number
    points: number
    allocation: number
}

/**
 * Recalculated allocation data (including the hypothetical user) consumed by
 * the visualizer render sections.
 */
export interface VisualizerCalculatedData {
    allocations: VisualizerAllocation[]
    totalPoints: number
    groupedByLockDays: Record<number, VisualizerAllocation[]>
}

export interface Bubble {
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
export interface PhysicsBubble {
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
export const simulateFluidLayout = (
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
export const packCircles = (
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
 * Generate a set of Living Typeface colors from the teal-to-phosphor gradient
 */
export const generateCyberpunkColorPalette = (numColors: number): string[] => {
    const colors: string[] = []
    // Gradient from cyber teal to phosphor (Living Typeface machine->organic spectrum)
    // Teal: rgb(70, 211, 154) -> Phosphor: rgb(155, 220, 79)
    for (let i = 0; i < numColors; i++) {
        const ratio = i / (numColors - 1 || 1) // Avoid division by zero
        const r = Math.floor(70 + ratio * (155 - 70))
        const g = Math.floor(211 + ratio * (220 - 211))
        const b = Math.floor(154 + ratio * (79 - 154))
        colors.push(`rgb(${r}, ${g}, ${b})`)
    }
    return colors
}

/**
 * Get color from palette by cycling through available colors
 */
export const getColorFromPalette = (index: number, palette: string[]): string => {
    return palette[index % palette.length]
}

// Preserved for backwards compatibility with previous layout logic.
void LOCK_CEILING
