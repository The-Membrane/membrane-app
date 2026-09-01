import { Box, Flex, Stack } from '@chakra-ui/react'
import React, { useMemo, useCallback } from 'react'
import { FlywheelPurpose } from './FlywheelPurpose'
import { FlywheelNode } from './FlywheelNode'
import { useFlywheelMetrics } from '@/hooks/useFlywheelMetrics'
import { shiftDigits } from '@/helpers/math'

// Static geometry - never changes, compute once outside component
const CONTAINER_WIDTH = 600
const CONTAINER_HEIGHT = 500
const CENTER_X = CONTAINER_WIDTH / 2
const CENTER_Y = CONTAINER_HEIGHT / 2
const TRIANGLE_RADIUS = 150
const NODE_RADIUS = 75

const TOP_VERTEX = { x: CENTER_X, y: CENTER_Y - TRIANGLE_RADIUS }
const BOTTOM_LEFT_VERTEX = {
    x: CENTER_X - TRIANGLE_RADIUS * Math.cos(Math.PI / 6),
    y: CENTER_Y + TRIANGLE_RADIUS * Math.sin(Math.PI / 6)
}
const BOTTOM_RIGHT_VERTEX = {
    x: CENTER_X + TRIANGLE_RADIUS * Math.cos(Math.PI / 6),
    y: CENTER_Y + TRIANGLE_RADIUS * Math.sin(Math.PI / 6)
}

const getPointOnCircle = (from: { x: number, y: number }, to: { x: number, y: number }, radius: number) => {
    const angle = Math.atan2(to.y - from.y, to.x - from.x)
    return { x: from.x + Math.cos(angle) * radius, y: from.y + Math.sin(angle) * radius }
}

const ARROW_1_START = getPointOnCircle(TOP_VERTEX, BOTTOM_LEFT_VERTEX, NODE_RADIUS)
const ARROW_1_END = getPointOnCircle(BOTTOM_LEFT_VERTEX, TOP_VERTEX, NODE_RADIUS)
const ARROW_1_MID = { x: (ARROW_1_START.x + ARROW_1_END.x) / 2 - 30, y: (ARROW_1_START.y + ARROW_1_END.y) / 2 - 20 }

const ARROW_2_START = getPointOnCircle(BOTTOM_LEFT_VERTEX, BOTTOM_RIGHT_VERTEX, NODE_RADIUS)
const ARROW_2_END = getPointOnCircle(BOTTOM_RIGHT_VERTEX, BOTTOM_LEFT_VERTEX, NODE_RADIUS)
const ARROW_2_MID = { x: (ARROW_2_START.x + ARROW_2_END.x) / 2, y: (ARROW_2_START.y + ARROW_2_END.y) / 2 + 30 }

const ARROW_3_START = getPointOnCircle(BOTTOM_RIGHT_VERTEX, TOP_VERTEX, NODE_RADIUS)
const ARROW_3_END = getPointOnCircle(TOP_VERTEX, BOTTOM_RIGHT_VERTEX, NODE_RADIUS)
const ARROW_3_MID = { x: (ARROW_3_START.x + ARROW_3_END.x) / 2 + 30, y: (ARROW_3_START.y + ARROW_3_END.y) / 2 - 20 }

const formatMetric = (value: string) => {
    try {
        return shiftDigits(value, -6).toString()
    } catch {
        return value
    }
}

export const FlywheelDiagram = React.memo(() => {
    const { discoInsurance, transmuterTVL, manicTVL, isLoading } = useFlywheelMetrics()

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
                        d={`M ${ARROW_1_START.x} ${ARROW_1_START.y} Q ${ARROW_1_MID.x} ${ARROW_1_MID.y} ${ARROW_1_END.x} ${ARROW_1_END.y}`}
                        stroke="rgba(255, 255, 255, 0.3)"
                        strokeWidth="2"
                        fill="none"
                        markerEnd="url(#arrowhead)"
                    />

                    {/* Arrow 2: Transmuter → Manic */}
                    <path
                        d={`M ${ARROW_2_START.x} ${ARROW_2_START.y} Q ${ARROW_2_MID.x} ${ARROW_2_MID.y} ${ARROW_2_END.x} ${ARROW_2_END.y}`}
                        stroke="rgba(255, 255, 255, 0.3)"
                        strokeWidth="2"
                        fill="none"
                        markerEnd="url(#arrowhead)"
                    />

                    {/* Arrow 3: Manic → Disco */}
                    <path
                        d={`M ${ARROW_3_START.x} ${ARROW_3_START.y} Q ${ARROW_3_MID.x} ${ARROW_3_MID.y} ${ARROW_3_END.x} ${ARROW_3_END.y}`}
                        stroke="rgba(255, 255, 255, 0.3)"
                        strokeWidth="2"
                        fill="none"
                        markerEnd="url(#arrowhead)"
                    />
                </svg>

                {/* Disco Node - Top */}
                <Box
                    position="absolute"
                    top={`${TOP_VERTEX.y - NODE_RADIUS}px`}
                    left={`${TOP_VERTEX.x - NODE_RADIUS}px`}
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
                    top={`${BOTTOM_LEFT_VERTEX.y - NODE_RADIUS}px`}
                    left={`${BOTTOM_LEFT_VERTEX.x - NODE_RADIUS}px`}
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
                    top={`${BOTTOM_RIGHT_VERTEX.y - NODE_RADIUS}px`}
                    left={`${BOTTOM_RIGHT_VERTEX.x - NODE_RADIUS}px`}
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

