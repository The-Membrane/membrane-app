import { Box, Button, HStack, Image, Stack, Text, Spacer, IconButton, Drawer, DrawerOverlay, DrawerContent, DrawerBody, useDisclosure, VStack } from '@chakra-ui/react';
import React from 'react';
import { FaUserCircle, FaBars } from 'react-icons/fa';
import WallectConnect from './WallectConnect';
import NextLink from 'next/link';
import { useRouter } from 'next/router';
import { colors } from '@/config/defaults';

const navItems = [
    { label: 'Home', href: '/' },
    { label: 'Borrow', href: '/borrow' },
    { label: 'Bid', href: '/bid' },
    { label: 'Stake', href: '/stake' },
    { label: 'Manic', href: '/manic' },
    { label: 'Upper Management', href: '/management' },
];

const HorizontalNav = () => {
    const { isOpen, onOpen, onClose } = useDisclosure();
    const router = useRouter();

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
                <Stack spacing={0}>
                    <HStack spacing={2}>
                        <Image src="/images/cdt.svg" alt="CDT" boxSize="32px" />
                        <Text fontWeight="bold" color="white" letterSpacing="wide" fontSize="13px">Membrane</Text>
                    </HStack>
                    <Text
                        color={colors.tabBG}
                        fontSize="sm"
                        letterSpacing="0.5em"
                        fontWeight="500"
                        textTransform="uppercase"
                        textShadow={`0px 0px 8px ${colors.tabBG}`}
                    >
                        Beta
                    </Text>
                </Stack>
                {/* Desktop Nav */}
                <HStack spacing={1} ml={4} display={{ base: 'none', md: 'flex' }}>
                    {navItems.map((item) => (
                        <Button
                            key={item.label}
                            as={NextLink}
                            href={item.href}
                            variant={router.asPath === item.href ? 'solid' : 'ghost'}
                            colorScheme="blue"
                            color="white"
                            fontWeight="semibold"
                            borderRadius="full"
                            px={6}
                            py={2}
                            bg={router.asPath === item.href ? 'whiteAlpha.200' : 'transparent'}
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
                <Image src="/images/osmo.svg" alt="OSMO Logo" boxSize={8} />
                <WallectConnect />
            </HStack>
            {/* Drawer for mobile nav */}
            <Drawer placement="left" onClose={onClose} isOpen={isOpen} size="xs">
                <DrawerOverlay />
                <DrawerContent bg="#232A3E">
                    <DrawerBody p={0} pt={8}>
                        <VStack align="stretch" spacing={1}>
                            {navItems.map((item) => (
                                <Button
                                    key={item.label}
                                    as={NextLink}
                                    href={item.href}
                                    variant={router.asPath === item.href ? 'solid' : 'ghost'}
                                    colorScheme="blue"
                                    color="white"
                                    fontWeight="semibold"
                                    borderRadius="full"
                                    px={6}
                                    py={4}
                                    bg={router.asPath === item.href ? 'whiteAlpha.200' : 'transparent'}
                                    _hover={{ bg: 'whiteAlpha.300' }}
                                    fontSize="13px"
                                    maxW={"fit-content"}
                                    justifyContent="flex-start"
                                    onClick={onClose}
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