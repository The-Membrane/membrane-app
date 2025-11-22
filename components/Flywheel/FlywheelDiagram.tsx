import { Box, Flex, Stack } from '@chakra-ui/react'
import React from 'react'
import { FlywheelPurpose } from './FlywheelPurpose'
import { FlywheelNode } from './FlywheelNode'
import { useFlywheelMetrics } from '@/hooks/useFlywheelMetrics'
import { shiftDigits } from '@/helpers/math'

export const FlywheelDiagram = React.memo(() => {
    const { discoInsurance, transmuterTVL, manicTVL, isLoading } = useFlywheelMetrics()

    // Format metrics (assuming 6 decimals for CDT/USDC)
    const formatMetric = (value: string) => {
        try {
            const num = shiftDigits(value, -6)
            return num.toString()
        } catch {
            return value
        }
    }

    // Equilateral triangle calculations
    const containerWidth = 600
    const containerHeight = 500
    const centerX = containerWidth / 2
    const centerY = containerHeight / 2
    const triangleRadius = 150 // Distance from center to each vertex
    const nodeRadius = 75 // Half of node diameter (150px / 2)

    // Calculate vertex positions (centers of circles)
    const topVertex = {
        x: centerX,
        y: centerY - triangleRadius
    }

    const bottomLeftVertex = {
        x: centerX - triangleRadius * Math.cos(Math.PI / 6), // cos(30°)
        y: centerY + triangleRadius * Math.sin(Math.PI / 6)  // sin(30°)
    }

    const bottomRightVertex = {
        x: centerX + triangleRadius * Math.cos(Math.PI / 6), // cos(30°)
        y: centerY + triangleRadius * Math.sin(Math.PI / 6)  // sin(30°)
    }

    // Calculate arrow start/end points on circle borders
    // Helper function to get point on circle border given center and target center
    const getPointOnCircle = (from: { x: number, y: number }, to: { x: number, y: number }, radius: number) => {
        const angle = Math.atan2(to.y - from.y, to.x - from.x)
        return {
            x: from.x + Math.cos(angle) * radius,
            y: from.y + Math.sin(angle) * radius
        }
    }

    // Arrow 1: Disco (top) → Transmuter (bottom left)
    const arrow1Start = getPointOnCircle(topVertex, bottomLeftVertex, nodeRadius)
    const arrow1End = getPointOnCircle(bottomLeftVertex, topVertex, nodeRadius)
    const arrow1Mid = {
        x: (arrow1Start.x + arrow1End.x) / 2 - 30,
        y: (arrow1Start.y + arrow1End.y) / 2 - 20
    }

    // Arrow 2: Transmuter (bottom left) → Manic (bottom right)
    const arrow2Start = getPointOnCircle(bottomLeftVertex, bottomRightVertex, nodeRadius)
    const arrow2End = getPointOnCircle(bottomRightVertex, bottomLeftVertex, nodeRadius)
    const arrow2Mid = {
        x: (arrow2Start.x + arrow2End.x) / 2,
        y: (arrow2Start.y + arrow2End.y) / 2 + 30
    }

    // Arrow 3: Manic (bottom right) → Disco (top)
    const arrow3Start = getPointOnCircle(bottomRightVertex, topVertex, nodeRadius)
    const arrow3End = getPointOnCircle(topVertex, bottomRightVertex, nodeRadius)
    const arrow3Mid = {
        x: (arrow3Start.x + arrow3End.x) / 2 + 30,
        y: (arrow3Start.y + arrow3End.y) / 2 - 20
    }

    return (
        <Stack
            direction="column"
            gap="3rem"
            alignItems="center"
            py="3rem"
            px={4}
            w="100%"
        >
            <FlywheelPurpose />

            {/* Equilateral triangle flow diagram with arrows */}
            <Box
                position="relative"
                w="100%"
                maxW="600px"
                h="500px"
                display="flex"
                alignItems="center"
                justifyContent="center"
            >
                {/* SVG container for arrows */}
                <svg
                    width="600"
                    height="500"
                    style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        pointerEvents: 'none',
                        zIndex: 0,
                    }}
                >
                    <defs>
                        {/* Arrowhead marker definition */}
                        <marker
                            id="arrowhead"
                            markerWidth="10"
                            markerHeight="10"
                            refX="9"
                            refY="3"
                            orient="auto"
                        >
                            <polygon
                                points="0 0, 10 3, 0 6"
                                fill="rgba(255, 255, 255, 0.3)"
                            />
                        </marker>
                    </defs>

                    {/* Arrow 1: Disco → Transmuter */}
                    <path
                        d={`M ${arrow1Start.x} ${arrow1Start.y} Q ${arrow1Mid.x} ${arrow1Mid.y} ${arrow1End.x} ${arrow1End.y}`}
                        stroke="rgba(255, 255, 255, 0.3)"
                        strokeWidth="2"
                        fill="none"
                        markerEnd="url(#arrowhead)"
                    />

                    {/* Arrow 2: Transmuter → Manic */}
                    <path
                        d={`M ${arrow2Start.x} ${arrow2Start.y} Q ${arrow2Mid.x} ${arrow2Mid.y} ${arrow2End.x} ${arrow2End.y}`}
                        stroke="rgba(255, 255, 255, 0.3)"
                        strokeWidth="2"
                        fill="none"
                        markerEnd="url(#arrowhead)"
                    />

                    {/* Arrow 3: Manic → Disco */}
                    <path
                        d={`M ${arrow3Start.x} ${arrow3Start.y} Q ${arrow3Mid.x} ${arrow3Mid.y} ${arrow3End.x} ${arrow3End.y}`}
                        stroke="rgba(255, 255, 255, 0.3)"
                        strokeWidth="2"
                        fill="none"
                        markerEnd="url(#arrowhead)"
                    />
                </svg>

                {/* Disco Node - Top */}
                <Box
                    position="absolute"
                    top={`${topVertex.y - nodeRadius}px`}
                    left={`${topVertex.x - nodeRadius}px`}
                    zIndex={1}
                >
                    <FlywheelNode
                        type="disco"
                        metric={formatMetric(discoInsurance)}
                        label="Disco"
                        metricLabel="Insured"
                    />
                </Box>

                {/* Transmuter Node - Bottom Left */}
                <Box
                    position="absolute"
                    top={`${bottomLeftVertex.y - nodeRadius}px`}
                    left={`${bottomLeftVertex.x - nodeRadius}px`}
                    zIndex={1}
                >
                    <FlywheelNode
                        type="transmuter"
                        metric={formatMetric(transmuterTVL)}
                        label="Transmuter"
                        metricLabel="TVL"
                    />
                </Box>

                {/* Manic Node - Bottom Right */}
                <Box
                    position="absolute"
                    top={`${bottomRightVertex.y - nodeRadius}px`}
                    left={`${bottomRightVertex.x - nodeRadius}px`}
                    zIndex={1}
                >
                    <FlywheelNode
                        type="manic"
                        metric={formatMetric(manicTVL)}
                        label="Manic"
                        metricLabel="TVL"
                    />
                </Box>
            </Box>
        </Stack>
    )
})

FlywheelDiagram.displayName = 'FlywheelDiagram'

