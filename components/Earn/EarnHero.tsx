import { Box, Button, HStack, Stack, Text } from '@chakra-ui/react';
import React from 'react';
import ConnectButton from '../WallectConnect/ConnectButton';

const EarnHero = () => {
    return (
        <Box
            w="full"
            minH={{ base: '60vh', md: '70vh' }}
            bgGradient="linear(to-b, #181B23 60%, #181B23 100%)"
            borderRadius="2xl"
            px={{ base: 4, md: 12 }}
            py={{ base: 10, md: 20 }}
            display="flex"
            alignItems="center"
            justifyContent="space-between"
            flexDir={{ base: 'column', md: 'row' }}
            position="relative"
        >
            {/* Left: Headline and Connect Button */}
            <Stack spacing={8} maxW="lg" zIndex={2} align={{ base: 'center', md: 'flex-start' }}>
                <Box bg="#23252B" px={4} py={1} borderRadius="md" alignSelf={{ base: 'center', md: 'flex-start' }}>
                    <Text color="whiteAlpha.800" fontSize="sm">
                        Total Deposits <b>$4,000,765,306</b>
                    </Text>
                </Box>
                <Text
                    fontSize={{ base: '3xl', md: '5xl' }}
                    fontWeight="bold"
                    color="white"
                    lineHeight="1.1"
                >
                    Earn on<br />your terms
                </Text>
                <ConnectButton
                    size="lg"
                    borderRadius="2xl"
                    px={8}
                    py={6}
                    fontSize="lg"
                    bgGradient="linear(to-r, #3B5998, #4568DC)"
                    color="white"
                    _hover={{ bgGradient: 'linear(to-r, #4568DC, #3B5998)' }}
                >
                    Connect Wallet
                </ConnectButton>
            </Stack>
            {/* Right: 3D Illustration Placeholder */}
            <Box
                mt={{ base: 16, md: 0 }}
                flex="1"
                display="flex"
                alignItems="center"
                justifyContent="center"
                minW={{ base: '220px', md: '400px' }}
                minH={{ base: '220px', md: '400px' }}
            >
                {/* Placeholder for 3D illustration */}
                <Box
                    as="svg"
                    width={{ base: '220px', md: '340px' }}
                    height={{ base: '220px', md: '340px' }}
                    viewBox="0 0 340 340"
                    fill="none"
                >
                    <ellipse cx="170" cy="250" rx="120" ry="50" fill="#2B3A67" fillOpacity="0.7" />
                    <rect x="70" y="170" width="200" height="80" rx="20" fill="#3B5998" />
                    <ellipse cx="220" cy="120" rx="60" ry="80" fill="#4568DC" />
                </Box>
            </Box>
        </Box>
    );
};

export default EarnHero; 