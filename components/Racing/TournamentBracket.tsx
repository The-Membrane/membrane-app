import React from 'react'
import { Box, VStack, HStack, Text, Spinner, Divider } from '@chakra-ui/react'
import ConfirmModal from '../ConfirmModal'
import { useTournamentBracket } from './hooks/useTournamentBracket'
import TournamentBracketLayout from './TournamentBracketLayout'
import TournamentRegistrationView from './TournamentRegistrationView'
import TournamentRegistrationPanel from './TournamentRegistrationPanel'
import { FOCUS_STYLES } from '@/config/transitions'

// Main TournamentBracket component
const TournamentBracket: React.FC = () => {
    const {
        tournamentState,
        stateLoading,
        registrations,
        regLoading,
        bracket,
        bracketLoading,
        tournamentConfig,
        ownedCars,
        selectedCarId,
        setSelectedCarId,
        isPaymentLoading,
        paymentOptions,
        isPaymentOptionsOpen,
        openOptions,
        closeOptions,
        isMobile,
        getCarName,
        isCarRegistered,
        freeRegistrationAction,
        getActionForOption,
        handleOptionSelect,
        handleRegisterClick,
        runNextMatchAction
    } = useTournamentBracket()

    // Only show loading on initial load, not during refetches
    const isInitialLoading = (stateLoading && !tournamentState) || (regLoading && !registrations) || (bracketLoading && !bracket)

    if (isInitialLoading) {
        return (
            <VStack spacing={4} p={4}>
                <Spinner size="lg" color="#7cffa0" />
                <Text fontFamily='"Press Start 2P", monospace' fontSize="12px" color="#b8c1ff">
                    Loading tournament data...
                </Text>
            </VStack>
        )
    }

    console.log('ownedCars?.find(car => car.id === selectedCarId.toString())?.name', ownedCars, selectedCarId, (ownedCars?.find(car => car.id === selectedCarId?.toString()))?.name)

    // If no tournament data, show registration list instead of blank bracket
    if (!tournamentState) {
        return (
            <TournamentRegistrationView
                registrations={registrations}
                ownedCars={ownedCars}
                getCarName={getCarName}
                isMobile={isMobile}
                selectedCarId={selectedCarId}
                setSelectedCarId={setSelectedCarId}
                isCarRegistered={isCarRegistered}
                isPaymentLoading={isPaymentLoading}
                tournamentConfig={tournamentConfig}
                freeRegistrationAction={freeRegistrationAction}
                openOptions={openOptions}
                isPaymentOptionsOpen={isPaymentOptionsOpen}
                closeOptions={closeOptions}
                paymentOptions={paymentOptions}
                handleOptionSelect={handleOptionSelect}
                getActionForOption={getActionForOption}
            />
        )
    }

    const isTournamentStarted = tournamentState.status !== 'NotStarted'
    const isTournamentCompleted = tournamentState.status === 'Completed'

    return (
        <VStack spacing={6} p={4} align="stretch">
            {/* Tournament Status */}
            <Box textAlign="center">
                <Text
                    fontFamily='"Press Start 2P", monospace'
                    fontSize="16px"
                    color="#7cffa0"
                    mb={2}
                >
                    Tournament #{tournamentState.tournament_id}
                </Text>
                <Text
                    fontFamily='"Press Start 2P", monospace'
                    fontSize="12px"
                    color="#b8c1ff"
                >
                    Status: {tournamentState.status.replace(/([A-Z])/g, ' $1').trim()}
                </Text>
                <Text
                    fontFamily='"Press Start 2P", monospace'
                    fontSize="10px"
                    color="#b8c1ff"
                >
                    Track: {tournamentState.track_id} | Round: {tournamentState.current_round}/{tournamentState.total_rounds}
                </Text>
            </Box>

            <Divider borderColor="#2a3550" />

            {/* Registration Grid (before tournament starts) */}
            {!isTournamentStarted && (
                <TournamentRegistrationPanel
                    registrations={registrations}
                    ownedCars={ownedCars}
                    getCarName={getCarName}
                    isMobile={isMobile}
                    selectedCarId={selectedCarId}
                    setSelectedCarId={setSelectedCarId}
                    isCarRegistered={isCarRegistered}
                    isPaymentLoading={isPaymentLoading}
                    handleRegisterClick={handleRegisterClick}
                    isPaymentOptionsOpen={isPaymentOptionsOpen}
                    closeOptions={closeOptions}
                    paymentOptions={paymentOptions}
                    handleOptionSelect={handleOptionSelect}
                    getActionForOption={getActionForOption}
                />
            )}

            {/* Tournament Bracket (after tournament starts) */}
            {isTournamentStarted && (
                <VStack spacing={4} align="stretch">
                    <Box
                        overflowX="auto"
                        overflowY="visible"
                        p={4}
                        bg="#0a0f1e"
                        border="2px solid #0033ff"
                        borderRadius="md"
                    >
                        <HStack
                            spacing={8}
                            align="flex-start"
                            minW="max-content"
                            justify="center"
                        >
                            <TournamentBracketLayout
                                bracket={bracket}
                                tournamentState={tournamentState}
                                ownedCars={ownedCars}
                                getCarName={getCarName}
                            />
                        </HStack>
                    </Box>

                    {/* Run Next Match Button */}
                    {!isTournamentCompleted && (
                        <Box textAlign="center">
                            <ConfirmModal
                                label="Run Next Match"
                                executeDirectly={true}
                                action={runNextMatchAction.action}
                                buttonProps={{
                                    bg: "#274bff",
                                    color: "white",
                                    _hover: { bg: '#1a3bff' },
                                    _active: { bg: '#0f2bff' },
                                    _focus: FOCUS_STYLES.ring,
                                    _focusVisible: FOCUS_STYLES.ring,
                                    borderRadius: "md",
                                    size: "md",
                                    fontFamily: '"Press Start 2P", monospace',
                                    fontSize: "12px",
                                    px: 6,
                                    py: 3
                                }}
                            >
                                <VStack align="start" spacing={1}>
                                    <Text fontFamily='"Press Start 2P", monospace' fontSize="12px" color="#e6e6e6">
                                        Confirm Run Next Match
                                    </Text>
                                    <Text fontFamily='"Press Start 2P", monospace' fontSize="10px" color="#b8c1ff">
                                        This will execute the next match in the tournament
                                    </Text>
                                </VStack>
                            </ConfirmModal>
                        </Box>
                    )}
                </VStack>
            )}
        </VStack>
    )
}

export default TournamentBracket
