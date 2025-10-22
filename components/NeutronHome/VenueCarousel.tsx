import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, HStack, IconButton, Button, VStack, SimpleGrid, Collapse, useBreakpointValue, Text } from '@chakra-ui/react';
import { ChevronLeftIcon, ChevronRightIcon } from '@chakra-ui/icons';
import VenueCard from './VenueCard';
import { Venue } from './mockVenues';

interface VenueCarouselProps {
    venues: Venue[];
    onVenueSelect?: (venue: Venue) => void;
    selectedVenueId?: string;
    onNavigateToVenue?: (navigateFn: (index: number) => void, getShowAllState: () => boolean) => void;
}

const VenueCarousel: React.FC<VenueCarouselProps> = ({ venues, onVenueSelect, selectedVenueId, onNavigateToVenue }) => {
    const [currentIndex, setCurrentIndex] = useState(0);
    const [showAll, setShowAll] = useState(false);
    const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
    const [showAllClickable, setShowAllClickable] = useState(true);

    const cardsPerView = useBreakpointValue({ base: 1, md: 2, lg: 3 }) || 3;
    const isMobile = useBreakpointValue({ base: true, lg: false });
    const maxIndex = Math.max(0, venues.length - cardsPerView);

    // Create a stable navigation function
    const navigateToIndex = useCallback((index: number) => {
        const clampedIndex = Math.max(0, Math.min(index, maxIndex));
        console.log('VenueCarousel: navigating to index:', clampedIndex, 'maxIndex:', maxIndex, 'showAll:', showAll);

        // If not in show all view, navigate to carousel page
        if (!showAll) {
            setCurrentIndex(clampedIndex);
            setShowAll(true); // Open Show All view
        }
        // If already in show all view, do nothing (venue is already highlighted)
    }, [maxIndex, showAll]);

    // Function to get current showAll state
    const getShowAllState = useCallback(() => {
        return showAll;
    }, [showAll]);

    // Expose navigation function to parent
    useEffect(() => {
        if (onNavigateToVenue) {
            onNavigateToVenue(navigateToIndex, getShowAllState);
        }
    }, [onNavigateToVenue, navigateToIndex, getShowAllState]);

    const handlePrev = () => {
        if (currentIndex === 0) {
            // Toggle show all when at first position
            setShowAll(!showAll);
        } else {
            setCurrentIndex(Math.max(0, currentIndex - 1));
        }
    };

    const handleNext = () => {
        if (currentIndex >= maxIndex) {
            // Toggle show all when at last position
            setShowAll(!showAll);
        } else {
            setCurrentIndex(Math.min(maxIndex, currentIndex + 1));
        }
    };

    const isAtStart = currentIndex === 0;
    const isAtEnd = currentIndex >= maxIndex;

    // Manage delay for Show All buttons to prevent accidental clicks
    useEffect(() => {
        let timeoutId: NodeJS.Timeout;

        if (isAtStart || isAtEnd) {
            // Disable clicks immediately when reaching start/end
            setShowAllClickable(false);

            // Re-enable clicks after 500ms delay
            timeoutId = setTimeout(() => {
                setShowAllClickable(true);
            }, 500);
        } else {
            // If not at start/end, ensure buttons are clickable
            setShowAllClickable(true);
        }

        return () => {
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
        };
    }, [isAtStart, isAtEnd]);

    // Ref for the selected venue card in Show All view
    const selectedVenueRef = useRef<HTMLDivElement>(null);

    // Scroll to selected venue when Show All opens
    useEffect(() => {
        if (showAll && selectedVenueId && selectedVenueRef.current) {
            // Small delay to ensure DOM is rendered
            setTimeout(() => {
                selectedVenueRef.current?.scrollIntoView({
                    behavior: 'smooth',
                    block: 'center',
                });
            }, 100);
        }
    }, [showAll, selectedVenueId]);

    if (showAll) {
        return (
            <VStack w="100%" spacing={4}>
                <HStack justify="center" w="33%">
                    <Button
                        onClick={() => setShowAll(false)}
                        colorScheme="blue"
                        variant="ghost"
                        size="sm"
                        minW="100px"
                    >
                        Go Back to Carousel
                    </Button>
                </HStack>
                <SimpleGrid columns={{ base: 1, md: 2, lg: 3 }} spacing={4} w="100%" justifyItems="center">
                    {venues.map((venue) => {
                        const isSelectedVenue = selectedVenueId === venue.id;
                        return (
                            <Box
                                key={venue.id}
                                ref={isSelectedVenue ? selectedVenueRef : null}
                            >
                                <VenueCard
                                    venue={venue}
                                    isSelected={isSelectedVenue}
                                    isFocused={true}
                                    onClick={() => {
                                        onVenueSelect?.(venue);
                                        // Don't navigate away from Show All view
                                    }}
                                />
                            </Box>
                        );
                    })}
                </SimpleGrid>
            </VStack>
        );
    }

    const visibleVenues = venues.slice(currentIndex, currentIndex + cardsPerView);

    return (
        <Box w="100%" position="relative">
            <HStack spacing={3} align="center" justify="center">
                {/* Left Button/Arrow */}
                {isAtStart ? (
                    <Button
                        onClick={handlePrev}
                        colorScheme="blue"
                        variant="ghost"
                        size="sm"
                        isDisabled={!showAllClickable || venues.length === 0}
                        minW="fit-content"
                    >
                        Show All
                    </Button>
                ) : (
                    <IconButton
                        aria-label="Previous venues"
                        icon={<ChevronLeftIcon boxSize={6} />}
                        onClick={handlePrev}
                        variant="ghost"
                        colorScheme="blue"
                        isDisabled={venues.length === 0}
                        _hover={{ bg: 'blue.700' }}
                    />
                )}

                {/* Venue Cards */}
                <HStack
                    spacing={4}
                    flex={1}
                    justify="center"
                    overflow="visible"
                    minH="240px"
                    align="center"
                    onMouseLeave={() => !isMobile && setHoveredIndex(null)}
                >
                    {visibleVenues.map((venue, idx) => {
                        const actualIndex = currentIndex + idx;
                        const isMiddleCard = cardsPerView === 3 && idx === 1;
                        const isSelectedCard = selectedVenueId === venue.id;
                        const isHoveredCard = hoveredIndex === actualIndex;

                        // Primary focus: 1. Hovered card, 2. Selected card (if no hover), 3. Middle card (if no selection & no hover)
                        let isFocused = false;
                        let isSecondaryFocus = false;

                        if (isMobile) {
                            isFocused = true;
                        } else if (hoveredIndex !== null) {
                            // If hovering, the hovered card gets primary focus
                            isFocused = isHoveredCard;
                            // If this is the selected card and NOT the hovered card, give it secondary focus
                            if (isSelectedCard && !isHoveredCard) {
                                isSecondaryFocus = true;
                            }
                        } else if (isSelectedCard) {
                            // If no hover and this is the selected venue, focus it
                            isFocused = true;
                        } else if (!selectedVenueId && isMiddleCard) {
                            // If no hover and no selection, focus the middle card
                            isFocused = true;
                        }

                        return (
                            <VenueCard
                                key={venue.id}
                                venue={venue}
                                isSelected={isSelectedCard}
                                isFocused={isFocused}
                                isSecondaryFocus={isSecondaryFocus}
                                onClick={() => onVenueSelect?.(venue)}
                                onMouseEnter={() => !isMobile && setHoveredIndex(actualIndex)}
                                onMouseLeave={() => !isMobile && setHoveredIndex(null)}
                            />
                        );
                    })}
                </HStack>

                {/* Right Button/Arrow */}
                {isAtEnd ? (
                    <Button
                        onClick={handleNext}
                        colorScheme="blue"
                        variant="ghost"
                        size="sm"
                        isDisabled={!showAllClickable || venues.length === 0}
                        minW="100px"
                    >
                        Show All
                    </Button>
                ) : (
                    <IconButton
                        aria-label="Next venues"
                        icon={<ChevronRightIcon boxSize={6} />}
                        onClick={handleNext}
                        variant="ghost"
                        colorScheme="blue"
                        isDisabled={venues.length === 0}
                        _hover={{ bg: 'blue.700' }}
                    />
                )}
            </HStack>

            {/* Indicator Dots */}
            {!showAll && venues.length > cardsPerView && (
                <HStack justify="center" mt={3} spacing={2}>
                    {Array.from({ length: maxIndex + 1 }).map((_, idx) => (
                        <Box
                            key={idx}
                            w="8px"
                            h="8px"
                            borderRadius="full"
                            bg={idx === currentIndex ? 'blue.400' : 'whiteAlpha.400'}
                            cursor="pointer"
                            onClick={() => setCurrentIndex(idx)}
                            transition="all 0.2s"
                            _hover={{ bg: 'blue.300' }}
                        />
                    ))}
                </HStack>
            )}
        </Box>
    );
};

export default VenueCarousel;

