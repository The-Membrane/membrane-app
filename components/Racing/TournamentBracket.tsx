import React, { useState, useMemo } from 'react'
import {
    Box,
    VStack,
    HStack,
    Text,
    Button,
    Grid,
    GridItem,
    Spinner,
    useBreakpointValue,
    Divider,
    Menu,
    MenuButton,
    MenuList,
    MenuItem
} from '@chakra-ui/react'
import { ChevronDownIcon } from '@chakra-ui/icons'
import { useTournamentState, useRegistrations, useCurrentBracket, useRunNextMatch, useRegisterForTournament, useTournamentConfig } from './hooks'
import { usePaymentSelection } from './hooks/usePaymentSelection'
import { useOwnedCars } from '@/hooks/useQRacing'
import useWallet from '@/hooks/useWallet'
import PaymentOptionsSheet from './PaymentOptionsSheet'
import ConfirmModal from '../ConfirmModal'
import { PaymentOption } from './hooks/usePaymentSelection'

// Component for individual bracket node
const BracketNode: React.FC<{
    carId?: number | null
    carName: string
    isWinner?: boolean
    isCompleted?: boolean
}> = ({ carId, carName, isWinner, isCompleted }) => {
    const bgColor = isCompleted
        ? (isWinner ? '#1a4d1a' : '#4d1a1a')
        : '#1a1f2e'
    const borderColor = isCompleted
        ? (isWinner ? '#7cffa0' : '#ff6b6b')
        : '#2a3550'

    return (
        <Box
            bg={bgColor}
            border="2px solid"
            borderColor={borderColor}
            borderRadius="md"
            p={3}
            minW="120px"
            textAlign="center"
            fontFamily='"Press Start 2P", monospace'
            fontSize="10px"
            color="#e6e6e6"
        >
            <Text noOfLines={1} title={carName}>
                {carName}
            </Text>
            {carId != null && (
                <Text fontSize="8px" color="#b8c1ff" mt={1}>
                    #{carId}
                </Text>
            )}
        </Box>
    )
}

// Component for bracket connector
const BracketConnector: React.FC<{
    direction: 'up' | 'down' | 'right'
}> = ({ direction }) => {
    const getConnectorStyle = () => {
        switch (direction) {
            case 'up':
                return {
                    width: '2px',
                    height: '20px',
                    bg: '#2a3550',
                    mx: 'auto',
                    mb: 1
                }
            case 'down':
                return {
                    width: '2px',
                    height: '20px',
                    bg: '#2a3550',
                    mx: 'auto',
                    mt: 1
                }
            case 'right':
                return {
                    width: '20px',
                    height: '2px',
                    bg: '#2a3550',
                    my: 'auto'
                }
            default:
                return {}
        }
    }

    return <Box {...getConnectorStyle()} />
}

// Component for horizontal connector
const HorizontalConnector: React.FC = () => (
    <Box
        width="40px"
        height="2px"
        bg="#2a3550"
        my="auto"
    />
)

// Component for vertical connector
const VerticalConnector: React.FC = () => (
    <Box
        width="2px"
        height="40px"
        bg="#2a3550"
        mx="auto"
    />
)

// Main TournamentBracket component
const TournamentBracket: React.FC = () => {
    const { data: tournamentState, isLoading: stateLoading } = useTournamentState()
    const { data: registrations, isLoading: regLoading } = useRegistrations()
    const { data: bracket, isLoading: bracketLoading } = useCurrentBracket()
    const { data: tournamentConfig, isLoading: configLoading } = useTournamentConfig()
    const { address } = useWallet()
    const { data: ownedCars } = useOwnedCars(address)

    const [selectedCarId, setSelectedCarId] = useState<number | null>(null)

    // Payment selection hook
    const {
        paymentOptions,
        isLoading: isPaymentLoading,
        executePayment,
        openOptions: openPaymentOptions,
        closeOptions: closePaymentOptions
    } = usePaymentSelection(selectedCarId?.toString())

    // Local state for payment options visibility
    const [isPaymentOptionsOpen, setIsPaymentOptionsOpen] = useState(false)

    const openOptions = () => {
        setIsPaymentOptionsOpen(true)
        openPaymentOptions()
    }

    const closeOptions = () => {
        setIsPaymentOptionsOpen(false)
        closePaymentOptions()
    }

    const isMobile = useBreakpointValue({ base: true, md: false })

    // Get car names (you'll need to implement this based on your car data structure)
    const getCarName = (carId: number, ownedCars: any): string => {
        const carName = (ownedCars?.find(car => car.id === carId.toString()))?.name
        if (carName) {
            return carName
        }
        // This should be replaced with actual car name lookup
        return `Car #${carId}`
    }

    // Check if a car is already registered
    const isCarRegistered = (carId: number): boolean => {
        const result = registrations?.registrations.some(reg =>
            reg.car_id === carId || reg.car_id === carId.toString() || reg.car_id.toString() === carId.toString()
        ) ?? false
        // console.log('isCarRegistered:', {
        //     carId,
        //     carIdString: carId.toString(),
        //     registrations: registrations?.registrations.map(r => ({ car_id: r.car_id, car_id_type: typeof r.car_id })),
        //     result
        // })
        return result
    }

    // Registration action hook for free option
    const freeRegistrationAction = useRegisterForTournament({
        carId: selectedCarId!,
        paymentOption: null,
        isRegistered: selectedCarId ? isCarRegistered(selectedCarId) : false,
        onSuccess: () => {
            setSelectedCarId(null)
            closeOptions()
        }
    })

    // Get action for a specific payment option
    const getActionForOption = (option: PaymentOption) => {
        if (option.denom && option.amount !== '0') {
            // For paid options, we'll create the action in the PaymentOptionsSheet
            // This is a placeholder - the actual action will be created when the option is selected
            return freeRegistrationAction.action
        } else {
            // Free option
            return freeRegistrationAction.action
        }
    }

    // Handle payment option selection
    const handleOptionSelect = (option: PaymentOption) => {
        executePayment(option, () => {
            if (option.denom && option.amount !== '0') {
                // For paid options, we need to create a new action with the payment
                // This is a simplified approach - in a real implementation, you'd want to
                // create the action properly with the payment option
                console.log('Paid registration with:', option)
                // For now, just use the free action as a placeholder
                return freeRegistrationAction.action.tx.mutate()
            } else {
                // Free option
                return freeRegistrationAction.action.tx.mutate()
            }
        })
    }

    // Check if free registration is allowed and handle button click
    const handleRegisterClick = () => {
        console.log('Tournament config allow_free_registration:', tournamentConfig?.config?.allow_free_registration)

        if (tournamentConfig?.config?.allow_free_registration) {
            console.log('Free registration is enabled - executing directly')
            // If free registration is allowed, execute directly
            executePayment(
                { denom: '', amount: '0', label: 'Free registration', sublabel: 'No cost', isAvailable: true },
                () => freeRegistrationAction.action.tx.mutate()
            )
        } else {
            console.log('Free registration is disabled - opening payment options')
            // Otherwise, open payment options
            openOptions()
        }
    }

    // Run next match action
    const runNextMatchAction = useRunNextMatch({
        onSuccess: () => {
            // Tournament state will be automatically invalidated
        }
    })

    // Generate bracket layout in seed-tree style
    const generateBracketLayout = () => {
        if (!bracket || !tournamentState) return null

        const totalRounds = tournamentState.total_rounds

        // Build rounds as arrays of nodes: each node is { id, leftId, rightId, winnerId }
        // For display, we simply show pairs per round stacked with vertical connectors
        const rounds: Array<Array<{
            id: string
            car1: number
            car2: number
            winner?: number
            completed: boolean
        }>> = []

        // Group incoming matches by round index 1..N (fallback to 1 for safety)
        const byRound: Record<number, typeof bracket.matches> = {}
        for (const m of bracket.matches) {
            const r: number = (m as any).round ?? tournamentState.current_round
            byRound[r] = byRound[r] || []
            byRound[r].push(m)
        }

        for (let r = 1; r <= totalRounds; r++) {
            const list = (byRound[r] || []).map(m => ({
                id: m.match_id,
                car1: m.car1,
                car2: m.car2,
                winner: m.winner,
                completed: m.completed,
            }))
            rounds.push(list)
        }

        // Convert rounds -> vertical pyramid positions
        const leafCount = 2 ** totalRounds
        const nodeW = 140
        const nodeH = 36
        const vGap = 90
        const vPadding = 20
        const width = Math.max(leafCount * (nodeW + 24) + 80, 900)
        const height = (totalRounds + 1) * vGap + vPadding * 2

        // Build names for leaves and up levels
        const leafNames: string[] = []
        const firstRound = rounds[0] || []
        for (const m of firstRound) {
            leafNames.push(getCarName(m.car1, ownedCars))
            leafNames.push(getCarName(m.car2, ownedCars))
        }
        // Upper levels (names optional until winners known)
        const upperNames: string[][] = []
        for (let lvl = 1; lvl <= totalRounds; lvl++) {
            const r = rounds[lvl] || []
            upperNames[lvl - 1] = r.map(m => (m.completed && m.winner != null) ? getCarName(m.winner, ownedCars) : '')
        }

        // positions per level
        const levels = totalRounds + 1
        const positions: { x: number, y: number }[][] = []
        for (let lvl = 0; lvl < levels; lvl++) {
            const count = 2 ** (totalRounds - lvl)
            const colWidth = width / count
            const y = height - vPadding - (lvl * vGap)
            const rowPositions = Array.from({ length: count }, (_, i) => ({
                x: Math.round((i + 0.5) * colWidth - nodeW / 2),
                y: Math.round(y - nodeH / 2),
            }))
            positions.push(rowPositions)
        }

        // SVG connectors
        const lines: { x1: number, y1: number, x2: number, y2: number }[] = []
        for (let lvl = 0; lvl < levels - 1; lvl++) {
            const parentCount = 2 ** (totalRounds - (lvl + 1))
            for (let i = 0; i < parentCount; i++) {
                const leftIdx = 2 * i
                const rightIdx = 2 * i + 1
                const parentPos = positions[lvl + 1][i]
                const leftPos = positions[lvl][leftIdx]
                const rightPos = positions[lvl][rightIdx]
                const parentX = parentPos.x + nodeW / 2
                const parentY = parentPos.y + nodeH
                const midY = parentY + (vGap - nodeH) / 2
                lines.push({ x1: leftPos.x + nodeW / 2, y1: leftPos.y, x2: leftPos.x + nodeW / 2, y2: midY })
                lines.push({ x1: rightPos.x + nodeW / 2, y1: rightPos.y, x2: rightPos.x + nodeW / 2, y2: midY })
                lines.push({ x1: leftPos.x + nodeW / 2, y1: midY, x2: rightPos.x + nodeW / 2, y2: midY })
                lines.push({ x1: parentX, y1: midY, x2: parentX, y2: parentY })
            }
        }

        return (
            <Box position="relative" width={`${width}px`} height={`${height}px`}>
                <svg width={width} height={height} style={{ position: 'absolute', top: 0, left: 0 }}>
                    {lines.map((l, idx) => (
                        <line key={idx} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke="#2a3550" strokeWidth={2} />
                    ))}
                </svg>
                {/* Leaves */}
                {positions[0].map((p, i) => (
                    <Box key={`leaf-${i}`} position="absolute" left={`${p.x}px`} top={`${p.y}px`}>
                        <BracketNode carId={undefined} carName={leafNames[i] || ''} />
                    </Box>
                ))}
                {/* Upper levels including champion */}
                {positions.slice(1).map((row, lvl) => (
                    <React.Fragment key={`lvl-${lvl + 1}`}>
                        {row.map((p, i) => (
                            <Box key={`n-${lvl + 1}-${i}`} position="absolute" left={`${p.x}px`} top={`${p.y}px`}>
                                <BracketNode carId={undefined} carName={upperNames[lvl]?.[i] || ''} isWinner={lvl === levels - 2} isCompleted={upperNames[lvl]?.[i]?.length > 0} />
                            </Box>
                        ))}
                    </React.Fragment>
                ))}
            </Box>
        )
    }

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

                    {registrations && registrations.registrations.length > 0 ? (
                        <Grid
                            templateColumns={isMobile ? "repeat(2, 1fr)" : "repeat(4, 1fr)"}
                            gap={3}
                        >
                            {registrations.registrations.map((reg) => (
                                <GridItem key={reg.car_id}>
                                    <Box
                                        bg="#1a1f2e"
                                        border="2px solid #7cffa0"
                                        borderRadius="md"
                                        p={3}
                                        textAlign="center"
                                        fontFamily='"Press Start 2P", monospace'
                                        fontSize="10px"
                                        color="#e6e6e6"
                                    >
                                        <Text noOfLines={1} title={getCarName(reg.car_id, ownedCars)}>
                                            {getCarName(reg.car_id, ownedCars)}
                                        </Text>
                                    </Box>
                                </GridItem>
                            ))}
                        </Grid>
                    ) : (
                        <Text
                            fontFamily='"Press Start 2P", monospace'
                            fontSize="10px"
                            color="#b8c1ff"
                            textAlign="center"
                        >
                            No pre-registrations yet
                        </Text>
                    )}

                    {/* Car Selection */}
                    <Box textAlign="center" mt={4}>
                        <Text
                            fontFamily='"Press Start 2P", monospace'
                            fontSize="10px"
                            color="#b8c1ff"
                            mb={2}
                        >
                            Select Car:
                        </Text>
                        <Box mb={4}>
                            <Menu>
                                <MenuButton
                                    as={Button}
                                    rightIcon={<ChevronDownIcon />}
                                    variant="outline"
                                    borderColor="#2a3550"
                                    color="#e6e6e6"
                                    _hover={{ bg: 'whiteAlpha.100' }}
                                    fontFamily='"Press Start 2P", monospace'
                                    fontSize="10px"
                                    w="200px"
                                >
                                    {selectedCarId ? (ownedCars?.find(car => car.id === selectedCarId.toString())?.name || `Car #${selectedCarId}`) : 'Select Car'}
                                </MenuButton>
                                <MenuList bg="#0b0e17" borderColor="#2a3550">
                                    {ownedCars && ownedCars.length > 0 ? (
                                        ownedCars.map((car: { id: string; name?: string | null }) => (
                                            <MenuItem
                                                key={car.id}
                                                onClick={() => setSelectedCarId(Number(car.id))}
                                                bg={selectedCarId === Number(car.id) ? 'whiteAlpha.200' : 'transparent'}
                                                _hover={{ bg: 'whiteAlpha.300' }}
                                                color="#e6e6e6"
                                                fontFamily='"Press Start 2P", monospace'
                                                fontSize="10px"
                                            >
                                                {car.name || `Car #${car.id}`}
                                            </MenuItem>
                                        ))
                                    ) : (
                                        <MenuItem disabled color="#b8c1ff" fontFamily='"Press Start 2P", monospace' fontSize="10px">
                                            No cars owned
                                        </MenuItem>
                                    )}
                                </MenuList>
                            </Menu>
                        </Box>
                    </Box>

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

                    {registrations && registrations.registrations.length > 0 ? (
                        <Grid
                            templateColumns={isMobile ? "repeat(2, 1fr)" : "repeat(4, 1fr)"}
                            gap={3}
                        >
                            {registrations.registrations.map((reg) => (
                                <GridItem key={reg.car_id}>
                                    <Box
                                        bg="#1a1f2e"
                                        border="2px solid #7cffa0"
                                        borderRadius="md"
                                        p={3}
                                        textAlign="center"
                                        fontFamily='"Press Start 2P", monospace'
                                        fontSize="10px"
                                        color="#e6e6e6"
                                    >
                                        <Text noOfLines={1} title={getCarName(reg.car_id, ownedCars)}>
                                            {getCarName(reg.car_id, ownedCars)}
                                        </Text>
                                    </Box>
                                </GridItem>
                            ))}
                        </Grid>
                    ) : (
                        <Text
                            fontFamily='"Press Start 2P", monospace'
                            fontSize="10px"
                            color="#b8c1ff"
                            textAlign="center"
                        >
                            No registrations yet
                        </Text>
                    )}

                    {/* Car Selection */}
                    <Box textAlign="center" mt={4}>
                        <Text
                            fontFamily='"Press Start 2P", monospace'
                            fontSize="10px"
                            color="#b8c1ff"
                            mb={2}
                        >
                            Select Car:
                        </Text>
                        <Box mb={4}>
                            <Menu>
                                <MenuButton
                                    as={Button}
                                    rightIcon={<ChevronDownIcon />}
                                    variant="outline"
                                    borderColor="#2a3550"
                                    color="#e6e6e6"
                                    _hover={{ bg: 'whiteAlpha.100' }}
                                    fontFamily='"Press Start 2P", monospace'
                                    fontSize="10px"
                                    w="200px"
                                >
                                    {selectedCarId ? (ownedCars?.find(car => car.id === selectedCarId.toString())?.name || `Car #${selectedCarId}`) : 'Select Car'}
                                </MenuButton>
                                <MenuList bg="#0b0e17" borderColor="#2a3550">
                                    {ownedCars && ownedCars.length > 0 ? (
                                        ownedCars.map((car: { id: string; name?: string | null }) => (
                                            <MenuItem
                                                key={car.id}
                                                onClick={() => setSelectedCarId(Number(car.id))}
                                                bg={selectedCarId === Number(car.id) ? 'whiteAlpha.200' : 'transparent'}
                                                _hover={{ bg: 'whiteAlpha.300' }}
                                                color="#e6e6e6"
                                                fontFamily='"Press Start 2P", monospace'
                                                fontSize="10px"
                                            >
                                                {car.name || `Car #${car.id}`}
                                            </MenuItem>
                                        ))
                                    ) : (
                                        <MenuItem disabled color="#b8c1ff" fontFamily='"Press Start 2P", monospace' fontSize="10px">
                                            No cars owned
                                        </MenuItem>
                                    )}
                                </MenuList>
                            </Menu>
                        </Box>
                    </Box>

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
                            {generateBracketLayout()}
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
