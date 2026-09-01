import React from 'react'
import { Box, Text, Grid, GridItem } from '@chakra-ui/react'
import { Registration } from './hooks/useTournamentQueries'

interface TournamentRegistrationGridProps {
    registrations: { registrations: Registration[] } | undefined
    ownedCars: Array<{ id: string; name: string | null }> | undefined
    getCarName: (carId: number, ownedCars: any) => string
    isMobile: boolean | undefined
    emptyText: string
}

// Grid of registered cars (with empty-state message)
const TournamentRegistrationGrid: React.FC<TournamentRegistrationGridProps> = ({
    registrations,
    ownedCars,
    getCarName,
    isMobile,
    emptyText
}) => {
    return (
        <>
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
                    {emptyText}
                </Text>
            )}
        </>
    )
}

export default TournamentRegistrationGrid
