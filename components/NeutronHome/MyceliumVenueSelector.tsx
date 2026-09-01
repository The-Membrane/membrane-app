import React from 'react';
import { Box, Text } from '@chakra-ui/react';
import VenueCarousel from './VenueCarousel';
import { MOCK_VENUES, Venue } from './mockVenues';

interface MyceliumVenueSelectorProps {
    selectedVenue: Venue | null;
    setSelectedVenue: React.Dispatch<React.SetStateAction<Venue | null>>;
    carouselNavigateRef: React.MutableRefObject<((index: number) => void) | null>;
    getShowAllStateRef: React.MutableRefObject<(() => boolean) | null>;
}

const MyceliumVenueSelector: React.FC<MyceliumVenueSelectorProps> = ({
    selectedVenue,
    setSelectedVenue,
    carouselNavigateRef,
    getShowAllStateRef,
}) => {
    return (
        <Box w={{ base: '90vw', md: '100%' }} maxW="900px" mt={4}>
            <Text color="whiteAlpha.700" fontSize="sm" mb={3} textAlign="center">
                {selectedVenue ? (
                    <>
                        Currently Selected:{' '}
                        <Text
                            as="span"
                            color="white"
                            fontWeight="semibold"
                            cursor="pointer"
                            _hover={{ textDecoration: 'underline' }}
                            onClick={() => {
                                // Check if we're in Show All view
                                const isShowAll = getShowAllStateRef.current?.() ?? false;

                                if (isShowAll) {
                                    // Already in Show All view, do nothing (venue is already highlighted)
                                    console.log('Already in Show All view, venue highlighted');
                                    return;
                                }

                                // Find the index of the selected venue
                                const selectedIndex = MOCK_VENUES.findIndex(v => v.id === selectedVenue.id);
                                if (selectedIndex !== -1 && carouselNavigateRef.current) {
                                    // Navigate to Show All view with venue highlighted
                                    const targetPage = Math.floor(selectedIndex / 3);
                                    console.log('Opening Show All for venue:', selectedVenue.name, 'at index:', selectedIndex);
                                    carouselNavigateRef.current(targetPage);
                                }
                            }}
                        >
                            {selectedVenue.name}
                        </Text>
                    </>
                ) : (
                    'Select a deployment venue'
                )}
            </Text>
            <VenueCarousel
                venues={MOCK_VENUES}
                onVenueSelect={setSelectedVenue}
                selectedVenueId={selectedVenue?.id}
                onNavigateToVenue={(navigateFn, getShowAllStateFn) => {
                    carouselNavigateRef.current = navigateFn;
                    getShowAllStateRef.current = getShowAllStateFn;
                }}
            />
        </Box>
    );
};

export default MyceliumVenueSelector;
