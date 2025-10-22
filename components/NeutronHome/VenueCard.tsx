import React from 'react';
import { Box, VStack, HStack, Text, Image } from '@chakra-ui/react';
import { Venue } from './mockVenues';
import protocolIcons from '@/config/protocolIcons.json';

interface VenueCardProps {
    venue: Venue;
    isSelected?: boolean;
    onClick?: () => void;
    isFocused?: boolean;
    isSecondaryFocus?: boolean;
    onMouseEnter?: () => void;
    onMouseLeave?: () => void;
}

const VenueCard: React.FC<VenueCardProps> = ({
    venue,
    isSelected = false,
    onClick,
    isFocused = false,
    isSecondaryFocus = false,
    onMouseEnter,
    onMouseLeave
}) => {
    const protocolIcon = (protocolIcons as Record<string, string>)[venue.protocol] || (protocolIcons as Record<string, string>)['default'];

    // Determine the scale and opacity based on focus state
    const scale = isFocused ? 'scale(1)' : isSecondaryFocus ? 'scale(0.95)' : 'scale(0.9)';
    const opacity = isFocused ? 1 : isSecondaryFocus ? 0.8 : 0.6;

    return (
        <Box
            bg={isSelected ? '#1f2937' : '#1a2330'}
            borderRadius="12px"
            p={4}
            w="220px"
            h="220px"
            cursor="pointer"
            onClick={onClick}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
            transition="all 0.3s ease"
            border={isSelected ? '2px solid #3b82f6' : '1px solid #2b3544'}
            transform={scale}
            opacity={opacity}
            _hover={{
                transform: 'scale(1)',
                opacity: 1,
                boxShadow: '0 0 0 2px #3b82f6',
                borderColor: '#3b82f6',
            }}
            position="relative"
            flexShrink={0}
        >
            <VStack align="center" spacing={3} w="100%" h="100%" justify="space-between">
                {/* Venue Name */}
                <Text
                    fontSize="md"
                    fontWeight="bold"
                    color="white"
                    lineHeight="1.3"
                    textAlign="center"
                    w="100%"
                >
                    {venue.name}
                </Text>

                {/* Protocol Icon - Centered */}
                <Box>
                    <Image
                        src={protocolIcon}
                        alt={venue.protocol}
                        boxSize="32px"
                        fallbackSrc="/images/protocols/default.svg"
                        loading="lazy"
                        decoding="async"
                    />
                </Box>

                <VStack spacing={2} w="100%">
                    {/* TVL */}
                    <HStack justify="space-between" w="100%">
                        <Text fontSize="sm" color="whiteAlpha.600">
                            TVL
                        </Text>
                        <Text fontSize="sm" fontWeight="semibold" color="white">
                            {venue.tvl}
                        </Text>
                    </HStack>

                    {/* APR */}
                    <HStack justify="space-between" w="100%">
                        <Text fontSize="sm" color="whiteAlpha.600">
                            APR
                        </Text>
                        <Text fontSize="sm" fontWeight="bold" color="#10b981">
                            {venue.apr}%
                        </Text>
                    </HStack>
                </VStack>
            </VStack>
        </Box>
    );
};

export default VenueCard;

