import React from 'react'
import { Box, VStack, Grid, GridItem, Button } from '@chakra-ui/react'
import { SectionInfoCard } from './SectionInfoCard'
import { SlotSelector } from './SlotSelector'
import { EpochRevenueCard } from './EpochRevenueCard'
import { DiscoPageAssetMenu } from './DiscoPageAssetMenu'
import { PRIMARY_PURPLE } from './DiscoPageConstants'
import type { DiscoPageState } from './hooks/useDiscoPage'

interface DiscoPageGlobalSectionProps {
    assetMenuOpen: boolean
    setAssetMenuOpen: DiscoPageState['setAssetMenuOpen']
    assetList: DiscoPageState['assetList']
    firstAsset: string
    setSelectedAsset: DiscoPageState['setSelectedAsset']
    selectedSlot: DiscoPageState['selectedSlot']
    setSelectedSlot: DiscoPageState['setSelectedSlot']
    selectedSlotDataWithAPR: DiscoPageState['selectedSlotDataWithAPR']
    slotsData: DiscoPageState['slotsData']
    depositFormTrigger: number
    setDepositModalSlot: DiscoPageState['setDepositModalSlot']
}

/** Global 2-column layout: asset/slot cards on the left, slot bars + CTA on the right. */
export const DiscoPageGlobalSection: React.FC<DiscoPageGlobalSectionProps> = ({
    assetMenuOpen,
    setAssetMenuOpen,
    assetList,
    firstAsset,
    setSelectedAsset,
    selectedSlot,
    setSelectedSlot,
    selectedSlotDataWithAPR,
    slotsData,
    depositFormTrigger,
    setDepositModalSlot,
}) => {
    return (
        <Grid
            templateColumns={{ base: '1fr', md: '280px 1fr' }}
            gap={6}
            alignItems="flex-start"
        >
            {/* Column 1: 3 stacked cards */}
            <GridItem>
                <VStack spacing={4} align="stretch">
                    {/* Asset Menu Card */}
                    <DiscoPageAssetMenu
                        assetMenuOpen={assetMenuOpen}
                        setAssetMenuOpen={setAssetMenuOpen}
                        assetList={assetList}
                        firstAsset={firstAsset}
                        setSelectedAsset={setSelectedAsset}
                        setSelectedSlot={setSelectedSlot}
                    />

                    {/* Slot Details Card */}
                    <SectionInfoCard
                        selectedSlot={selectedSlotDataWithAPR}
                        slotsData={slotsData}
                        externalFormTrigger={depositFormTrigger}
                    />

                    {/* Epoch Metrics Card */}
                    <EpochRevenueCard
                        selectedSlot={selectedSlotDataWithAPR ? { slot: selectedSlotDataWithAPR.slot, tvl: selectedSlotDataWithAPR.tvl } : null}
                    />

                </VStack>
            </GridItem>

            {/* Column 2: Slot bars + CTA */}
            <GridItem>
                <VStack spacing={4} align="stretch">
                    <Box
                        bg="rgba(10, 10, 10, 0.8)"
                        p={4}
                        borderRadius="md"
                        border="2px solid"
                        borderColor={PRIMARY_PURPLE}
                        boxShadow={`0 0 20px ${PRIMARY_PURPLE}40`}
                        data-section="slot-selector"
                    >
                        <SlotSelector
                            slots={slotsData}
                            selectedSlot={selectedSlot}
                            onSlotSelect={setSelectedSlot}
                        />
                    </Box>

                    {/* CTA: Deposit Button */}
                    {selectedSlotDataWithAPR && (
                        <Button
                            w="100%"
                            size="md"
                            bg="#7A5CCE"
                            color="white"
                            fontFamily="mono"
                            fontSize="sm"
                            fontWeight="bold"
                            _hover={{
                                bg: '#7ab534',
                                boxShadow: '0 0 15px rgba(155, 220, 79, 0.4)'
                            }}
                            onClick={() => setDepositModalSlot(selectedSlot)}
                        >
                            Insure to Earn
                        </Button>
                    )}

                </VStack>
            </GridItem>
        </Grid>
    )
}
