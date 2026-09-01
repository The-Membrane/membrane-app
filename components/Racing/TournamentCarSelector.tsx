import React from 'react'
import {
    Box,
    Text,
    Button,
    Menu,
    MenuButton,
    MenuList,
    MenuItem
} from '@chakra-ui/react'
import { ChevronDownIcon } from '@chakra-ui/icons'

interface TournamentCarSelectorProps {
    selectedCarId: number | null
    ownedCars: Array<{ id: string; name: string | null }> | undefined
    onSelectCar: (carId: number) => void
}

// Car selection dropdown for tournament registration
const TournamentCarSelector: React.FC<TournamentCarSelectorProps> = ({
    selectedCarId,
    ownedCars,
    onSelectCar
}) => {
    return (
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
                                    onClick={() => onSelectCar(Number(car.id))}
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
    )
}

export default TournamentCarSelector
