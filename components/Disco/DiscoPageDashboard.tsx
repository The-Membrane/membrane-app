import React from 'react'
import { Box, Button, Collapse } from '@chakra-ui/react'
import { MetricsSection } from './MetricsSection'
import type { DiscoPageState } from './hooks/useDiscoPage'

interface DiscoPageDashboardProps {
    showMetrics: boolean
    setShowMetrics: DiscoPageState['setShowMetrics']
    metricsRef: DiscoPageState['metricsRef']
    usdcAsset: DiscoPageState['usdcAsset']
    metrics: DiscoPageState['metrics']
    selectedSlotDataWithAPR: DiscoPageState['selectedSlotDataWithAPR']
    assetQueueData: DiscoPageState['assetQueueData']
}

/** Dashboard toggle button plus the collapsible metrics section. */
export const DiscoPageDashboard: React.FC<DiscoPageDashboardProps> = ({
    showMetrics,
    setShowMetrics,
    metricsRef,
    usdcAsset,
    metrics,
    selectedSlotDataWithAPR,
    assetQueueData,
}) => {
    return (
        <>
            {/* View Dashboard Toggle */}
            <Box display="flex" justifyContent="center" mt={8} mb={4}>
                <Button
                    onClick={() => setShowMetrics(!showMetrics)}
                    color="white"
                    bg="transparent"
                    borderRadius="md"
                    px={4}
                    py={2}
                    w="fit-content"
                    _hover={{ bg: 'rgba(255, 255, 255, 0.1)' }}
                    _active={{ bg: 'rgba(255, 255, 255, 0.15)' }}
                    fontFamily="mono"
                    fontSize="sm"
                >
                    {showMetrics ? 'Close Dashboard' : 'View Dashboard'}
                </Button>
            </Box>

            {/* Metrics Section */}
            <Collapse in={showMetrics} animateOpacity>
                <Box ref={metricsRef}>
                    {usdcAsset && (
                        <Box>
                            <MetricsSection
                                globalTotalDeposits={metrics.totalDeposits}
                                globalTotalInsurance={metrics.totalInsurance}
                                selectedSlotData={selectedSlotDataWithAPR}
                                ltvChartAsset={usdcAsset.base || 'USDC'}
                                ltvChartAssetSymbol={usdcAsset.symbol}
                                ltvChartQueue={assetQueueData}
                            />
                        </Box>
                    )}
                    {!usdcAsset && (
                        <Box data-tutorial="metrics-section">
                            <MetricsSection
                                globalTotalDeposits={metrics.totalDeposits}
                                globalTotalInsurance={metrics.totalInsurance}
                                selectedSlotData={selectedSlotDataWithAPR}
                            />
                        </Box>
                    )}
                </Box>
            </Collapse>
        </>
    )
}
