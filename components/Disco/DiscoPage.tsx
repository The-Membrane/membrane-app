import React from 'react'
import { Box, Stack, Text, Grid, GridItem } from '@chakra-ui/react'
import { DiscoBallMeteor } from './DiscoBallMeteor'
import { TutorialProvider } from '@/components/DittoSpeechBox/TutorialContext'
import { TutorialButton } from '@/components/DittoSpeechBox/TutorialButton'
import { useDiscoPage } from './hooks/useDiscoPage'
import { PRIMARY_PURPLE, DARK_BG } from './DiscoPageConstants'
import { DiscoPageBackground } from './DiscoPageBackground'
import { DiscoPageHeader } from './DiscoPageHeader'
import { DiscoPageMetricsBar } from './DiscoPageMetricsBar'
import { DiscoPageGlobalSection } from './DiscoPageGlobalSection'
import { DiscoPageUserTotals } from './DiscoPageUserTotals'
import { DiscoPageWaterfall } from './DiscoPageWaterfall'
import { DiscoPageDashboard } from './DiscoPageDashboard'
import { DiscoPageModals } from './DiscoPageModals'

export const DiscoPage = React.memo(() => {
    const {
        tutorial,
        tutorialContextValue,
        usdcAsset,
        walletBalanceMBRN,
        setSelectedAsset,
        assetMenuOpen,
        setAssetMenuOpen,
        firstAsset,
        assetList,
        unstakeData,
        assetQueueData,
        slotsData,
        metrics,
        selectedSlot,
        setSelectedSlot,
        showMetrics,
        setShowMetrics,
        metricsRef,
        selectedSlotDataWithAPR,
        depositFormTrigger,
        depositAmount,
        setDepositAmount,
        expandedUserSlots,
        setExpandedUserSlots,
        manageSlot,
        setManageSlot,
        depositModalSlot,
        setDepositModalSlot,
        depositHook,
        claimHook,
        handleDeposit,
        userDeposits,
        depositCarouselData,
        cumulativeTotals,
        totalUnstaking,
        weightedAPR,
        userSlotDeposits,
        bufferData,
        handleClaimAll,
    } = useDiscoPage()

    return (
        <TutorialProvider value={tutorialContextValue}>
            <Box
                position="relative"
                w="100%"
                minH="100vh"
                bg={DARK_BG}
            >
                {/* Hexagonal Background Grid */}
                <DiscoPageBackground />

                {/* Tutorial Button */}
                <Box
                    position="fixed"
                    bottom={4}
                    right={4}
                    zIndex={1000}
                >
                    <TutorialButton
                        onClick={() => {
                            tutorial.resetTutorial()
                            tutorial.startTutorial()
                        }}
                        isVisible={tutorial.hasCompletedTutorial}
                    />
                </Box>

                {/* Disco Ball/Meteor */}
                <DiscoBallMeteor />

                {/* Main Content */}
                <Stack
                    direction="column"
                    spacing={8}
                    pt="120px"
                    pb={8}
                    position="relative"
                    zIndex={1}
                >
                    {/* Header */}
                    <DiscoPageHeader />

                    {/* Global Metrics Header Bar */}
                    <DiscoPageMetricsBar metrics={metrics} slotCount={slotsData.length} />

                    {/* ===== 2-Column Layout: Cards | Slot Bars ===== */}
                    <Box
                        w="100%"
                        maxW="1200px"
                        mx="auto"
                        px={{ base: 4, md: 8 }}
                    >
                        <DiscoPageGlobalSection
                            assetMenuOpen={assetMenuOpen}
                            setAssetMenuOpen={setAssetMenuOpen}
                            assetList={assetList}
                            firstAsset={firstAsset}
                            setSelectedAsset={setSelectedAsset}
                            selectedSlot={selectedSlot}
                            setSelectedSlot={setSelectedSlot}
                            selectedSlotDataWithAPR={selectedSlotDataWithAPR}
                            slotsData={slotsData}
                            depositFormTrigger={depositFormTrigger}
                            setDepositModalSlot={setDepositModalSlot}
                        />

                        {/* Divider between global and user data */}
                        <Box
                            w="100%"
                            h="1px"
                            bg={`${PRIMARY_PURPLE}40`}
                            my={6}
                        />

                        {/* ===== User Data Grid ===== */}
                        <Text
                            fontSize="xl"
                            fontWeight="bold"
                            color={PRIMARY_PURPLE}
                            fontFamily="'Neon Tubes', mono"
                            letterSpacing="1px"
                            textAlign="left"
                            mb={2}
                        >
                            Your Deposits
                        </Text>
                        <Grid
                            templateColumns={{ base: '1fr', md: '280px 1fr' }}
                            gap={6}
                            alignItems="flex-start"
                        >
                            {/* Left: User totals */}
                            <GridItem>
                                <DiscoPageUserTotals
                                    userDeposits={userDeposits}
                                    depositCarouselData={depositCarouselData}
                                    cumulativeTotals={cumulativeTotals}
                                    weightedAPR={weightedAPR}
                                    totalUnstaking={totalUnstaking}
                                    handleClaimAll={handleClaimAll}
                                    claimHook={claimHook}
                                />
                            </GridItem>

                            {/* Right: User deposits waterfall */}
                            <GridItem>
                                <DiscoPageWaterfall
                                    depositCarouselData={depositCarouselData}
                                    userSlotDeposits={userSlotDeposits}
                                    unstakeData={unstakeData}
                                    bufferData={bufferData}
                                    expandedUserSlots={expandedUserSlots}
                                    setExpandedUserSlots={setExpandedUserSlots}
                                    setManageSlot={setManageSlot}
                                />
                            </GridItem>
                        </Grid>
                    </Box>

                    {/* View Dashboard Toggle + Metrics Section */}
                    <DiscoPageDashboard
                        showMetrics={showMetrics}
                        setShowMetrics={setShowMetrics}
                        metricsRef={metricsRef}
                        usdcAsset={usdcAsset}
                        metrics={metrics}
                        selectedSlotDataWithAPR={selectedSlotDataWithAPR}
                        assetQueueData={assetQueueData}
                    />
                </Stack>
            </Box>
            {/* Modals */}
            <DiscoPageModals
                manageSlot={manageSlot}
                setManageSlot={setManageSlot}
                userSlotDeposits={userSlotDeposits}
                unstakeData={unstakeData}
                firstAsset={firstAsset}
                slotsData={slotsData}
                depositModalSlot={depositModalSlot}
                setDepositModalSlot={setDepositModalSlot}
                selectedSlotDataWithAPR={selectedSlotDataWithAPR}
                walletBalanceMBRN={walletBalanceMBRN}
                depositAmount={depositAmount}
                setDepositAmount={setDepositAmount}
                handleDeposit={handleDeposit}
                depositHook={depositHook}
            />
        </TutorialProvider>
    )
})

DiscoPage.displayName = 'DiscoPage'
