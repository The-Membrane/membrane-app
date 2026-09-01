import React from 'react'
import { Box, VStack, Text, Button } from '@chakra-ui/react'
import PaymentOptionsSheet from './PaymentOptionsSheet'
import TournamentRegistrationGrid from './TournamentRegistrationGrid'
import TournamentCarSelector from './TournamentCarSelector'
import { Registration } from './hooks/useTournamentQueries'
import { PaymentOption } from './hooks/usePaymentSelection'

interface TournamentRegistrationPanelProps {
    registrations: { registrations: Registration[] } | undefined
    ownedCars: Array<{ id: string; name: string | null }> | undefined
    getCarName: (carId: number, ownedCars: any) => string
    isMobile: boolean | undefined
    selectedCarId: number | null
    setSelectedCarId: React.Dispatch<React.SetStateAction<number | null>>
    isCarRegistered: (carId: number) => boolean
    isPaymentLoading: boolean
    handleRegisterClick: () => void
    isPaymentOptionsOpen: boolean
    closeOptions: () => void
    paymentOptions: PaymentOption[]
    handleOptionSelect: (option: PaymentOption) => void
    getActionForOption: (option: PaymentOption) => any
}

// Registration section shown while a tournament exists but has not started yet
const TournamentRegistrationPanel: React.FC<TournamentRegistrationPanelProps> = ({
    registrations,
    ownedCars,
    getCarName,
    isMobile,
    selectedCarId,
    setSelectedCarId,
    isCarRegistered,
    isPaymentLoading,
    handleRegisterClick,
    isPaymentOptionsOpen,
    closeOptions,
    paymentOptions,
    handleOptionSelect,
    getActionForOption
}) => {
    return (
        <VStack spacing={4} align="stretch">
            <Text
                fontFamily='"Press Start 2P", monospace'
                fontSize="14px"
                color="#e6e6e6"
                textAlign="center"
                borderBottom="2px solid #0033ff"
                pb={2}
            >
                Registered
            </Text>

            <TournamentRegistrationGrid
                registrations={registrations}
                ownedCars={ownedCars}
                getCarName={getCarName}
                isMobile={isMobile}
                emptyText="No registrations yet"
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
                    console.log('Register button debug:', { selectedCarId, isRegistered, isDisabled, isPaymentLoading })
                    return null
                })()}
                <Button
                    onClick={handleRegisterClick}
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
                    {isPaymentLoading ? 'Processing...' : (selectedCarId && isCarRegistered(selectedCarId) ? 'Already Registered' : 'Register')}
                </Button>
                <Text
                    fontFamily='"Press Start 2P", monospace'
                    fontSize="8px"
                    color="#b8c1ff"
                    mt={2}
                >
                    {!selectedCarId ? 'Select a car to register' : (selectedCarId && isCarRegistered(selectedCarId) ? 'This car is already registered' : 'Ready to register')}
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
    )
}

export default TournamentRegistrationPanel
