import { Box, Button, HStack, Image, Stack, Text, Spacer } from '@chakra-ui/react';
import React from 'react';
import ConnectButton from './WallectConnect/ConnectButton';
import { FaUserCircle } from 'react-icons/fa';

const navItems = [
    { label: 'Earn' },
    { label: 'Borrow' },
    { label: 'Explore' },
    { label: 'Migrate' },
];

const HorizontalNav = () => {
    return (
        <Box
            as="nav"
            w="full"
            px={{ base: 2, md: 8 }}
            py={2}
            bgGradient="linear(to-r, #232A3E 60%, #2B3A67 100%)"
            boxShadow="md"
            borderRadius="0 0 2xl 2xl"
            display="flex"
            alignItems="center"
            justifyContent="space-between"
            minH="64px"
            zIndex={100}
        >
            {/* Left: Logo, Title, Page Selector */}
            <HStack spacing={6} align="center">
                {/* Placeholder Logo */}
                <Box boxSize="32px" borderRadius="full" bgGradient="linear(to-br, #3B5998, #4568DC)" display="flex" alignItems="center" justifyContent="center">
                    <Text fontWeight="bold" color="white" fontSize="xl">M</Text>
                </Box>
                <Text fontWeight="bold" fontSize="xl" color="white" letterSpacing="wide">Morpho</Text>
                <HStack spacing={1} ml={4}>
                    {navItems.map((item, idx) => (
                        <Button
                            key={item.label}
                            variant={idx === 0 ? 'solid' : 'ghost'}
                            colorScheme="blue"
                            color="white"
                            fontWeight="semibold"
                            borderRadius="full"
                            px={6}
                            py={2}
                            bg={idx === 0 ? 'whiteAlpha.200' : 'transparent'}
                            _hover={{ bg: 'whiteAlpha.300' }}
                            fontSize="md"
                        >
                            {item.label}
                        </Button>
                    ))}
                </HStack>
            </HStack>
            <Spacer />
            {/* Right: Connect Wallet & User Icon */}
            <HStack spacing={4} align="center">
                <ConnectButton
                    size="md"
                    borderRadius="xl"
                    px={6}
                    py={2}
                    fontSize="md"
                    bgGradient="linear(to-r, #3B5998, #4568DC)"
                    color="white"
                    _hover={{ bgGradient: 'linear(to-r, #4568DC, #3B5998)' }}
                >
                    Connect Wallet
                </ConnectButton>
                <Box as={FaUserCircle} color="whiteAlpha.800" boxSize={8} />
            </HStack>
        </Box>
    );
};

export default HorizontalNav; 