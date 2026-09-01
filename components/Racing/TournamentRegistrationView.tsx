import React from 'react'
import { Box, VStack, Text, Button, Divider } from '@chakra-ui/react'
import ConfirmModal from '../ConfirmModal'
import PaymentOptionsSheet from './PaymentOptionsSheet'
import TournamentRegistrationGrid from './TournamentRegistrationGrid'
import TournamentCarSelector from './TournamentCarSelector'
import { Registration, TournamentConfig } from './hooks/useTournamentQueries'
import { PaymentOption } from './hooks/usePaymentSelection'

interface TournamentRegistrationViewProps {
    registrations: { registrations: Registration[] } | undefined
    ownedCars: Array<{ id: string; name: string | null }> | undefined
    getCarName: (carId: number, ownedCars: any) => string
    isMobile: boolean | undefined
    selectedCarId: number | null
    setSelectedCarId: React.Dispatch<React.SetStateAction<number | null>>
    isCarRegistered: (carId: number) => boolean
    isPaymentLoading: boolean
    tournamentConfig: { config: TournamentConfig } | undefined
    freeRegistrationAction: { action: any }
    openOptions: () => void
    isPaymentOptionsOpen: boolean
    closeOptions: () => void
    paymentOptions: PaymentOption[]
    handleOptionSelect: (option: PaymentOption) => void
    getActionForOption: (option: PaymentOption) => any
}

// Registration view shown when there is no active tournament
const TournamentRegistrationView: React.FC<TournamentRegistrationViewProps> = ({
    registrations,
    ownedCars,
    getCarName,
    isMobile,
    selectedCarId,
    setSelectedCarId,
    isCarRegistered,
    isPaymentLoading,
    tournamentConfig,
    freeRegistrationAction,
    openOptions,
    isPaymentOptionsOpen,
    closeOptions,
    paymentOptions,
    handleOptionSelect,
    getActionForOption
}) => {
    return (
        <VStack spacing={6} p={4} align="stretch">
            <Box textAlign="center">
                <Text fontFamily='"Press Start 2P", monospace' fontSize="16px" color="#7cffa0" mb={2}>
                    Tournament Registration
                </Text>
                <Text fontFamily='"Press Start 2P", monospace' fontSize="12px" color="#b8c1ff">
                    No active tournament — register for the next one
                </Text>
            </Box>

            <Divider borderColor="#2a3550" />

            {/* Registration Grid */}
            <VStack spacing={4} align="stretch">
                <Text
                    fontFamily='"Press Start 2P", monospace'
                    fontSize="14px"
                    color="#e6e6e6"
                    textAlign="center"
                    borderBottom="2px solid #0033ff"
                    pb={2}
                >
                    Pre-Registered
                </Text>

                <TournamentRegistrationGrid
                    registrations={registrations}
                    ownedCars={ownedCars}
                    getCarName={getCarName}
                    isMobile={isMobile}
                    emptyText="No pre-registrations yet"
                />

                {/* Car Selection */}
                <TournamentCarSelector
                    selectedCarId={selectedCarId}
                    ownedCars={ownedCars}
                    onSelectCar={setSelectedCarId}
                />

                {/* Registration Button */}
                <Box textAlign="center" mt={4} position="relative">
                    {(() => {
                        const isRegistered = selectedCarId ? isCarRegistered(selectedCarId) : false
                        const isDisabled = !selectedCarId || isPaymentLoading || isRegistered
                        console.log('Pre-register button debug:', { selectedCarId, isRegistered, isDisabled, isPaymentLoading })
                        return null
                    })()}
                    {tournamentConfig?.config?.allow_free_registration ? (
                        <ConfirmModal
                            label={selectedCarId && isCarRegistered(selectedCarId) ? "Already Registered" : "Pre-Register"}
                            executeDirectly={true}
                            action={freeRegistrationAction.action}
                            buttonProps={{
                                disabled: !selectedCarId || isPaymentLoading || (selectedCarId ? isCarRegistered(selectedCarId) : false),
                                bg: selectedCarId && isCarRegistered(selectedCarId) ? "#666666" : "#274bff",
                                color: "white",
                                _hover: { bg: selectedCarId && isCarRegistered(selectedCarId) ? '#666666' : '#1a3bff' },
                                _active: { bg: selectedCarId && isCarRegistered(selectedCarId) ? '#666666' : '#0f2bff' },
                                borderRadius: "md",
                                size: "sm",
                                fontFamily: '"Press Start 2P", monospace',
                                fontSize: "12px",
                                w: "200px",
                                opacity: selectedCarId ? 1 : 0.5,
                                cursor: selectedCarId && !isCarRegistered(selectedCarId) ? 'pointer' : 'not-allowed'
                            }}
                        >
                            <VStack align="start" spacing={1}>
                                <Text fontFamily='"Press Start 2P", monospace' fontSize="12px" color="#e6e6e6">
                                    {selectedCarId && isCarRegistered(selectedCarId) ? "Already Registered" : "Confirm Pre-Registration"}
                                </Text>
                                <Text fontFamily='"Press Start 2P", monospace' fontSize="10px" color="#b8c1ff">
                                    {selectedCarId && isCarRegistered(selectedCarId) ? "This car is already registered" : "Free registration - no payment required"}
                                </Text>
                            </VStack>
                        </ConfirmModal>
                    ) : (
                        <Button
                            onClick={openOptions}
                            disabled={!selectedCarId || isPaymentLoading || (selectedCarId ? isCarRegistered(selectedCarId) : false)}
                            bg={selectedCarId && isCarRegistered(selectedCarId) ? "#666666" : "#274bff"}
                            color="white"
                            _hover={{ bg: selectedCarId && isCarRegistered(selectedCarId) ? '#666666' : '#1a3bff' }}
                            _active={{ bg: selectedCarId && isCarRegistered(selectedCarId) ? '#666666' : '#0f2bff' }}
                            borderRadius="md"
                            size="sm"
                            fontFamily='"Press Start 2P", monospace'
                            fontSize="12px"
                            w="200px"
                            opacity={selectedCarId ? 1 : 0.5}
                            cursor={selectedCarId && !isCarRegistered(selectedCarId) ? 'pointer' : 'not-allowed'}
                        >
                            {isPaymentLoading ? 'Processing...' : (selectedCarId && isCarRegistered(selectedCarId) ? 'Already Registered' : 'Pre-Register')}
                        </Button>
                    )}
                    <Text
                        fontFamily='"Press Start 2P", monospace'
                        fontSize="8px"
                        color="#b8c1ff"
                        mt={2}
                    >
                        {!selectedCarId ? 'Select a car to pre-register' : 'Ready to pre-register'}
                    </Text>

                    {/* Payment Options Sheet */}
                    <PaymentOptionsSheet
                        isOpen={isPaymentOptionsOpen}
                        onClose={closeOptions}
                        paymentOptions={paymentOptions}
                        onSelectOption={handleOptionSelect}
                        isLoading={isPaymentLoading}
                        dropdownWidth="default"
                        getActionForOption={getActionForOption}
                    />
                </Box>
            </VStack>
        </VStack>
    )
}

export default TournamentRegistrationView
