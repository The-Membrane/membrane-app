import React, { useState, useMemo } from 'react'
import { Box, Flex, HStack, useColorModeValue } from '@chakra-ui/react'
import { useChainRoute } from '@/hooks/useChainRoute'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import useAppState from '@/persisted-state/useAppState'
import { GalaxyGraph } from '@/components/Visualize/GalaxyGraph'
import { MarketDetailPanel } from '@/components/Visualize/MarketDetailPanel'
import { GlobalTimeline } from '@/components/Visualize/GlobalTimeline'
import { VisualizationControls } from '@/components/Visualize/VisualizationControls'
import { useVisualizationData } from '@/hooks/useVisualizationData'
import { PageTitle } from '@/components/ui/PageTitle'
import type { MarketNode, FlowEdge, SystemEvent, TimelineData } from '@/types/visualization'

const VisualizePage = () => {
    const { chainName } = useChainRoute()
    const { appState } = useAppState()
    const { data: cosmWasmClient } = useCosmWasmClient(appState?.rpcUrl || '')
    const bgColor = useColorModeValue('#0a0a0f', '#0a0a0f')
    const borderColor = useColorModeValue('rgba(138, 43, 226, 0.3)', 'rgba(138, 43, 226, 0.3)')

    const [selectedMarket, setSelectedMarket] = useState<string | null>(null)
    const [timeRange, setTimeRange] = useState<'1h' | '24h' | '7d' | '30d'>('24h')
    const [viewMode, setViewMode] = useState<'galaxy' | 'markets' | 'timeline'>('galaxy')

    // Fetch visualization data
    const {
        markets,
        flows,
        events,
        timelineData,
        isLoading,
        error
    } = useVisualizationData(cosmWasmClient, timeRange)

    // Debug logging
    React.useEffect(() => {
        console.log('VisualizePage data:', {
            marketsCount: markets.length,
            flowsCount: flows.length,
            eventsCount: events.length,
            isLoading,
            error: error?.message,
        })
    }, [markets.length, flows.length, events.length, isLoading, error])

    const selectedMarketData = useMemo(() => {
        if (!selectedMarket) return null
        return markets.find(m => m.id === selectedMarket)
    }, [selectedMarket, markets])

    if (error) {
        return (
            <Box p={8} bg={bgColor} minH="100vh" color="purple.300">
                <Text>Error loading visualization data: {error.message}</Text>
            </Box>
        )
    }

    return (
        <Box
            bg={bgColor}
            minH="100vh"
            position="relative"
            overflow="hidden"
            sx={{
                '&::before': {
                    content: '""',
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    background: `
            radial-gradient(circle at 20% 50%, rgba(138, 43, 226, 0.1) 0%, transparent 50%),
            radial-gradient(circle at 80% 80%, rgba(0, 191, 255, 0.1) 0%, transparent 50%),
            radial-gradient(circle at 40% 20%, rgba(255, 0, 255, 0.1) 0%, transparent 50%)
          `,
                    pointerEvents: 'none',
                    zIndex: 0,
                },
            }}
        >
            <Flex
                direction="column"
                h="100vh"
                position="relative"
                zIndex={1}
            >
                {/* Header */}
                <Box
                    p={4}
                    borderBottom="1px solid"
                    borderColor={borderColor}
                    backdropFilter="blur(10px)"
                    bg="rgba(10, 10, 15, 0.8)"
                >
                    <HStack justify="space-between" align="center">
                        <PageTitle
                            title="MEMBRANE VISUALIZATION"
                            subtitle="Cyberpunk Mycelium Network"
                            variant="cyberpunk"
                            gradient="linear(to-r, purple.400, blue.400, magenta.400)"
                            subtitleColor="purple.300"
                            mb={0}
                        />
                        <VisualizationControls
                            timeRange={timeRange}
                            onTimeRangeChange={setTimeRange}
                            viewMode={viewMode}
                            onViewModeChange={setViewMode}
                        />
                    </HStack>
                </Box>

                {/* Main Content */}
                <Flex flex={1} position="relative" overflow="hidden">
                    {/* Galaxy View - Full Screen 3D */}
                    {viewMode === 'galaxy' && (
                        <Box flex={1} position="relative">
                            <GalaxyGraph
                                markets={markets}
                                flows={flows}
                                events={events}
                                selectedMarket={selectedMarket}
                                onMarketSelect={setSelectedMarket}
                                isLoading={isLoading}
                            />
                            {selectedMarketData && (
                                <Box
                                    position="absolute"
                                    top={4}
                                    right={4}
                                    w="400px"
                                    maxH="80vh"
                                    overflowY="auto"
                                    bg="rgba(10, 10, 15, 0.95)"
                                    border="1px solid"
                                    borderColor={borderColor}
                                    borderRadius="lg"
                                    p={4}
                                    backdropFilter="blur(20px)"
                                    boxShadow="0 0 30px rgba(138, 43, 226, 0.5)"
                                >
                                    <MarketDetailPanel
                                        market={selectedMarketData}
                                        events={events.filter(e => e.marketId === selectedMarket)}
                                        timeRange={timeRange}
                                    />
                                </Box>
                            )}
                        </Box>
                    )}

                    {/* Markets Grid View */}
                    {viewMode === 'markets' && (
                        <Flex
                            flex={1}
                            p={6}
                            gap={4}
                            wrap="wrap"
                            overflowY="auto"
                            css={{
                                '&::-webkit-scrollbar': {
                                    width: '8px',
                                },
                                '&::-webkit-scrollbar-track': {
                                    background: 'rgba(138, 43, 226, 0.1)',
                                },
                                '&::-webkit-scrollbar-thumb': {
                                    background: 'rgba(138, 43, 226, 0.5)',
                                    borderRadius: '4px',
                                },
                            }}
                        >
                            {markets.map((market) => (
                                <Box
                                    key={market.id}
                                    w="calc(50% - 12px)"
                                    minW="400px"
                                    bg="rgba(10, 10, 15, 0.95)"
                                    border="1px solid"
                                    borderColor={borderColor}
                                    borderRadius="lg"
                                    p={4}
                                    backdropFilter="blur(20px)"
                                    boxShadow="0 0 20px rgba(138, 43, 226, 0.3)"
                                    _hover={{
                                        borderColor: 'purple.400',
                                        boxShadow: '0 0 30px rgba(138, 43, 226, 0.6)',
                                    }}
                                    transition="all 0.3s"
                                >
                                    <MarketDetailPanel
                                        market={market}
                                        events={events.filter(e => e.marketId === market.id)}
                                        timeRange={timeRange}
                                    />
                                </Box>
                            ))}
                        </Flex>
                    )}

                    {/* Timeline View */}
                    {viewMode === 'timeline' && (
                        <Box flex={1} p={6}>
                            <GlobalTimeline
                                data={timelineData}
                                events={events}
                                timeRange={timeRange}
                                isLoading={isLoading}
                            />
                        </Box>
                    )}
                </Flex>
            </Flex>
        </Box>
    )
}

export default VisualizePage

