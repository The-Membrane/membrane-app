import { Box, Button, HStack, Image, Stack, Text, Spacer, IconButton, Drawer, DrawerOverlay, DrawerContent, DrawerBody, useDisclosure, VStack, Menu, MenuButton, MenuList, MenuItem } from '@chakra-ui/react';
import React from 'react';
import { FaUserCircle, FaBars, FaChevronDown } from 'react-icons/fa';
import WallectConnect from './WallectConnect';
import NextLink from 'next/link';
import { useRouter } from 'next/router';
import { colors } from '@/config/defaults';
import Logo from './Logo';
import { supportedChains, getChainConfig } from '@/config/chains';
import { useChainRoute } from '@/hooks/useChainRoute';
import useAppState from '@/persisted-state/useAppState';

const navItems = [
    { label: 'Home', href: '/' },
    { label: 'Portfolio', href: '/portfolio' },
    { label: 'Isolated Markets', href: '/isolated' },
    { label: 'Mint', href: '/mint' },
    { label: 'Liquidate', href: '/liquidate' },
    { label: 'Stake', href: '/stake' },
    // { label: 'Manic', href: '/manic' }, //There is 190 TVL in here so whoever's that is can just type /manic
    { label: 'Control Room', href: '/control-room' },
];

const HorizontalNav = () => {
    const { isOpen, onOpen, onClose } = useDisclosure();
    const router = useRouter();
    const { chainName } = useChainRoute();
    const currentChain = getChainConfig(chainName);
    const { setAppState } = useAppState();

    const handleChainChange = (newChain: string) => {
        const currentPath = router.asPath;
        const newPath = currentPath.replace(/^\/[^/]+/, `/${newChain}`);
        const newChainConfig = getChainConfig(newChain);
        setAppState({ rpcUrl: newChainConfig.rpcUrl });
        router.push(newPath);
    };

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
                <Stack spacing={0} alignContent={"start"}>
                    <Logo />
                    <Text
                        color={colors.tabBG}
                        fontSize="2xs"
                        alignSelf={"center"}
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
                            href={`/${chainName}${item.href}`}
                            variant={router.asPath === `/${chainName}${item.href}` ? 'solid' : 'ghost'}
                            colorScheme="blue"
                            color="white"
                            fontWeight="semibold"
                            borderRadius="full"
                            px={6}
                            py={2}
                            bg={router.asPath === `/${chainName}${item.href}` ? 'whiteAlpha.200' : 'transparent'}
                            _hover={{ bg: 'whiteAlpha.300' }}
                            fontSize="13px"
                            w={"fit-content"}
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
            {/* Right: Chain Selector & Connect Wallet */}
            <HStack spacing={4} align="center">
                <Menu>
                    <MenuButton
                        as={Button}
                        w={"fit-content"}
                        rightIcon={<FaChevronDown />}
                        leftIcon={<Image src={currentChain.logo} alt={`${currentChain.name} Logo`} boxSize={6} />}
                        variant="ghost"
                        color="white"
                        _hover={{ bg: 'whiteAlpha.200' }}
                        px={2}
                    >
                    </MenuButton>
                    <MenuList bg="#232A3E">
                        {supportedChains.map((chain) => (
                            <MenuItem
                                key={chain.name}
                                onClick={() => handleChainChange(chain.name)}
                                bg={chain.name === currentChain.name ? 'whiteAlpha.200' : 'transparent'}
                                _hover={{ bg: 'whiteAlpha.300' }}
                                color="white"
                                isDisabled={true}
                                opacity={0.5}
                                cursor="not-allowed"
                            >
                                <HStack>
                                    <Image src={chain.logo} alt={`${chain.name} Logo`} boxSize={6} />
                                    <Text>{chain.name}</Text>
                                </HStack>
                            </MenuItem>
                        ))}
                    </MenuList>
                </Menu>
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
                                    href={`/${chainName}${item.href}`}
                                    variant={router.asPath === `/${chainName}${item.href}` ? 'solid' : 'ghost'}
                                    colorScheme="blue"
                                    color="white"
                                    fontWeight="semibold"
                                    borderRadius="full"
                                    px={6}
                                    py={4}
                                    bg={router.asPath === `/${chainName}${item.href}` ? 'whiteAlpha.200' : 'transparent'}
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