import React, { useRef, useMemo, useEffect } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls, Text, Line, Sphere } from '@react-three/drei'
import * as THREE from 'three'
import type { MarketNode, FlowEdge, SystemEvent } from '@/types/visualization'
import { HexDome } from './HexDome'
import { MyceliumTendril } from './MyceliumTendril'
import { EventPulse } from './EventPulse'
import { Box, Spinner, Text as ChakraText, VStack } from '@chakra-ui/react'

interface GalaxyGraphProps {
    markets: MarketNode[]
    flows: FlowEdge[]
    events: SystemEvent[]
    selectedMarket: string | null
    onMarketSelect: (marketId: string | null) => void
    isLoading: boolean
}

export const GalaxyGraph: React.FC<GalaxyGraphProps> = ({
    markets,
    flows,
    events,
    selectedMarket,
    onMarketSelect,
    isLoading,
}) => {
    const cameraRef = useRef<THREE.PerspectiveCamera>(null)

    // Debug logging
    useEffect(() => {
        console.log('GalaxyGraph render:', {
            marketsCount: markets.length,
            flowsCount: flows.length,
            eventsCount: events.length,
            isLoading,
        })
    }, [markets.length, flows.length, events.length, isLoading])

    // Calculate event positions based on market positions
    const eventsWithPositions = useMemo(() => {
        return events.map(event => {
            const market = markets.find(m => m.id === event.marketId)
            if (market) {
                return {
                    ...event,
                    position: [
                        market.position[0] + (Math.random() - 0.5) * 2,
                        market.position[1] + (Math.random() - 0.5) * 2,
                        market.position[2] + (Math.random() - 0.5) * 2,
                    ] as [number, number, number],
                }
            }
            return event
        })
    }, [events, markets])

    if (isLoading) {
        return (
            <Box
                w="100%"
                h="100%"
                display="flex"
                alignItems="center"
                justifyContent="center"
                bg="rgba(10, 10, 15, 0.9)"
            >
                <VStack spacing={4}>
                    <Spinner size="xl" color="purple.400" />
                    <ChakraText color="purple.300" fontFamily="mono">
                        Loading galaxy network...
                    </ChakraText>
                </VStack>
            </Box>
        )
    }

    // Show message if no markets
    if (markets.length === 0) {
        return (
            <Box
                w="100%"
                h="100%"
                display="flex"
                alignItems="center"
                justifyContent="center"
                bg="rgba(10, 10, 15, 0.9)"
            >
                <VStack spacing={4}>
                    <ChakraText color="purple.300" fontFamily="mono" fontSize="lg">
                        No markets found
                    </ChakraText>
                    <ChakraText color="purple.500" fontFamily="mono" fontSize="sm">
                        Waiting for data...
                    </ChakraText>
                </VStack>
            </Box>
        )
    }

    return (
        <Box w="100%" h="100%" position="relative" minH="600px">
            <Canvas
                camera={{ position: [0, 0, 50], fov: 75 }}
                gl={{ antialias: true, alpha: true }}
                style={{ background: 'transparent', width: '100%', height: '100%' }}
                dpr={[1, 2]}
            >
                <ambientLight intensity={0.3} />
                <pointLight position={[10, 10, 10]} intensity={0.5} color="#8a2be2" />
                <pointLight position={[-10, -10, 10]} intensity={0.5} color="#00bfff" />
                <pointLight position={[0, 0, -10]} intensity={0.3} color="#ff00ff" />

                {/* Grid background */}
                <Grid />

                {/* Market nodes as hex domes */}
                {markets.map((market) => (
                    <HexDome
                        key={market.id}
                        market={market}
                        isSelected={selectedMarket === market.id}
                        onClick={() => onMarketSelect(market.id)}
                    />
                ))}

                {/* Flow edges as mycelium tendrils */}
                {flows.map((flow) => {
                    const sourceMarket = markets.find(m => m.id === flow.source)
                    const targetMarket = markets.find(m => m.id === flow.target)
                    if (!sourceMarket || !targetMarket) return null

                    return (
                        <MyceliumTendril
                            key={flow.id}
                            flow={flow}
                            source={sourceMarket.position}
                            target={targetMarket.position}
                        />
                    )
                })}

                {/* Event pulses */}
                {eventsWithPositions
                    .filter(e => e.position)
                    .map((event) => (
                        <EventPulse
                            key={event.id}
                            event={event}
                            position={event.position!}
                        />
                    ))}

                <OrbitControls
                    enablePan={true}
                    enableZoom={true}
                    enableRotate={true}
                    minDistance={20}
                    maxDistance={200}
                    autoRotate={false}
                    autoRotateSpeed={0.5}
                />
            </Canvas>
        </Box>
    )
}

// Grid component for background
const Grid: React.FC = () => {
    const gridHelper = useMemo(() => {
        const grid = new THREE.GridHelper(100, 50, '#1a1a2e', '#0f0f1a')
        return grid
    }, [])

    return <primitive object={gridHelper} />
}

