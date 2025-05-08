import { Box, Button, HStack, Image, Stack, Text, Spacer, IconButton, Drawer, DrawerOverlay, DrawerContent, DrawerBody, useDisclosure, VStack } from '@chakra-ui/react';
import React from 'react';
import ConnectButton from './WallectConnect/ConnectButton';
import { FaUserCircle, FaBars } from 'react-icons/fa';

const navItems = [
    { label: 'Earn' },
    { label: 'Borrow' },
    { label: 'Explore' },
    { label: 'Migrate' },
];

const HorizontalNav = () => {
    const { isOpen, onOpen, onClose } = useDisclosure();
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
            {/* Left: Logo, Title, Page Selector or Hamburger */}
            <HStack spacing={6} align="center">
                {/* Placeholder Logo */}
                <Box boxSize="32px" borderRadius="full" bgGradient="linear(to-br, #3B5998, #4568DC)" display="flex" alignItems="center" justifyContent="center">
                    <Text fontWeight="bold" color="white" fontSize="xl">M</Text>
                </Box>
                <Text fontWeight="bold" color="white" letterSpacing="wide" fontSize="13px">Morpho</Text>
                {/* Desktop Nav */}
                <HStack spacing={1} ml={4} display={{ base: 'none', md: 'flex' }}>
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
                            fontSize="13px"
                        >
                            {item.label}
                        </Button>
                    ))}
                </HStack>
                {/* Hamburger for mobile */}
                <IconButton
                    aria-label="Open menu"
                    icon={<FaBars />}
                    display={{ base: 'flex', md: 'none' }}
                    onClick={onOpen}
                    bg="transparent"
                    color="white"
                    fontSize="22px"
                    _hover={{ bg: 'whiteAlpha.200' }}
                />
            </HStack>
            <Spacer />
            {/* Right: Connect Wallet & User Icon */}
            <HStack spacing={4} align="center">
                <Box as={FaUserCircle} color="whiteAlpha.800" boxSize={8} />
                <ConnectButton
                    size="md"
                    borderRadius="xl"
                    px={6}
                    py={2}
                    fontSize="13px"
                    bgGradient="linear(to-r, #3B5998, #4568DC)"
                    color="white"
                    _hover={{ bgGradient: 'linear(to-r, #4568DC, #3B5998)' }}
                >
                    Connect Wallet
                </ConnectButton>
            </HStack>
            {/* Drawer for mobile nav */}
            <Drawer placement="left" onClose={onClose} isOpen={isOpen} size="xs">
                <DrawerOverlay />
                <DrawerContent bg="#232A3E">
                    <DrawerBody p={0} pt={8}>
                        <VStack align="stretch" spacing={1}>
                            {navItems.map((item, idx) => (
                                <Button
                                    key={item.label}
                                    variant={idx === 0 ? 'solid' : 'ghost'}
                                    colorScheme="blue"
                                    color="white"
                                    fontWeight="semibold"
                                    borderRadius="full"
                                    px={6}
                                    py={4}
                                    bg={idx === 0 ? 'whiteAlpha.200' : 'transparent'}
                                    _hover={{ bg: 'whiteAlpha.300' }}
                                    fontSize="13px"
                                    justifyContent="flex-start"
                                >
                                    {item.label}
                                </Button>
                            ))}
                        </VStack>
                    </DrawerBody>
                </DrawerContent>
            </Drawer>
        </Box>
    );
};

export default HorizontalNav; 