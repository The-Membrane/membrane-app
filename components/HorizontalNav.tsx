import { Box, Button, HStack, Image, Stack, Text, Spacer, IconButton, Drawer, DrawerOverlay, DrawerContent, DrawerBody, useDisclosure, VStack, Menu, MenuButton, MenuList, MenuItem, Collapse } from '@chakra-ui/react';
import React, { useEffect, useRef, useState } from 'react';
import { FaUserCircle, FaBars, FaChevronDown, FaChevronUp } from 'react-icons/fa';
import WallectConnect from './WallectConnect/WalletConnect';
import NextLink from 'next/link';
import { useRouter } from 'next/router';
import { colors } from '@/config/defaults';
import Logo from './Logo';
import { supportedChains, getChainConfig } from '@/config/chains';
import { useChainRoute } from '@/hooks/useChainRoute';
import useAppState from '@/persisted-state/useAppState';

const navItems = [
    { label: 'About', href: '/about' },
    { label: 'Home', href: '/' },
    // Proto-port surfaces, depth-ordered per public/proto/flow.html
    { label: 'Position', href: '/position' },
    { label: 'Borrow', href: '/borrow' },
    { label: 'Carry', href: '/carry' },
    { label: 'Earn', href: '/earn' },
    { label: 'Liquidate', href: '/liquidate' },
    { label: 'Defend', href: '/defend' },
    { label: 'Builder', href: '/builder' },
    { label: 'Mint', href: '/mint' },
    { label: 'Portfolio', href: '/portfolio' }, // flow.html marks this replaced by Position — keep until owner removes
    // { label: 'Transmuter', href: '/transmuter' },
    // { label: 'Manic', href: '/manic' },
    { label: 'The Disco', href: '/disco' },
    // { label: 'Maze Runners', href: '/maze-runners' },
    // { label: 'Bridge', href: '/bridge' },

    // { label: 'Manic', href: '/manic' }, //There is 190 TVL in here so whoever's that is can just type /manic
    // { label: 'Isolated Markets', href: '/isolated' }, //Remove supplied CDT Trix
    // { label: 'Stake', href: '/stake' },
    // { label: 'Control Room', href: '/control-room' },
];

const dashboardItems = [
    { label: 'Acquisition', href: '/acquisition-dashboard' },
    { label: 'LTVs', href: '/ltv-dashboard' },
    { label: 'Membrane', href: '/membrane-dashboard' },
];

// Neutron only shows Maze Runners
const neutronNavItems = [
    { label: 'Maze Runners', href: '/maze-runners' },
];

const getNavItemsForChain = (chainName: string) => {
    if (chainName === 'neutron' || chainName === 'neutrontestnet') {
        return { navItems: neutronNavItems, dashboards: [] as typeof dashboardItems };
    }
    return { navItems, dashboards: dashboardItems };
};

const HorizontalNav = () => {
    const { isOpen, onOpen, onClose } = useDisclosure();
    // Passed to the Drawer as `finalFocusRef` so closing always returns focus to
    // the hamburger. Without it Chakra restores focus to whatever was focused
    // before opening, and WebKit does not focus a <button> on click — so on
    // iOS/Safari focus was landing back on <body>, stranding keyboard and
    // screen-reader users at the top of the document.
    const menuButtonRef = useRef<HTMLButtonElement>(null);
    const [dashboardsOpen, setDashboardsOpen] = useState(false);
    const router = useRouter();
    const { chainName } = useChainRoute();
    const currentChain = getChainConfig(chainName);
    const { appState, setAppState } = useAppState();

    // Sync RPC URL with current chain from route when component renders
    useEffect(() => {
        if (currentChain.rpcUrl !== appState.rpcUrl) {
            setAppState({ rpcUrl: currentChain.rpcUrl });
        }
    }, [chainName, currentChain.rpcUrl, appState.rpcUrl, setAppState]);

    const handleChainChange = (newChain: string) => {
        const currentPath = router.asPath;
        const newPath = currentPath.replace(/^\/[^/]+/, `/${newChain}`);
        const newChainConfig = getChainConfig(newChain);
        setAppState({ rpcUrl: newChainConfig.rpcUrl });
        router.push(newPath);
    };

    // Get chain-specific nav items, then filter out Home if contract signed
    const { navItems: chainNavItems, dashboards } = getNavItemsForChain(chainName);
    const filteredNavItems = appState.setCookie
        ? chainNavItems.filter(item => item.label !== 'Home')
        : chainNavItems;

    return (
        <Box
            as="nav"
            position="relative"
            w="full"
            px={{ base: 2, md: 8 }}
            py={2}
            bg="#0e0d10"
            borderBottom="1px solid"
            borderColor="rgba(236, 230, 216, 0.10)"
            borderRadius={0}
            display="flex"
            alignItems="center"
            justifyContent="space-between"
            minH="64px"
            mb={4}
            zIndex={100}
        >
            {/* Left: Logo, Title, Page Selector or Hamburger */}
            {/* <Stack spacing={0} alignContent={"start"}> */}
            {/* <Logo /> */}
            {/* <Text
                        color={colors.tabBG}
                        fontSize="2xs"
                        alignSelf={"center"}
                        letterSpacing="0.5em"
                        fontWeight="500"
                        textTransform="uppercase"
                        textShadow={`0px 0px 8px ${colors.tabBG}`}
                    >
                        Beta
                    </Text> */}
            {/* </Stack> */}

            {/* Desktop Nav */}
            <HStack spacing={1} display={{ base: 'none', lg: 'flex' }}>
                {chainName && filteredNavItems.map((item) => (
                    <Button
                        key={item.label}
                        as={NextLink}
                        href={`/${chainName}${item.href}`}
                        variant={router.asPath === `/${chainName}${item.href}` ? 'solid' : 'ghost'}
                        color="#ece6d8"
                        fontWeight="semibold"
                        borderRadius="full"
                        border="none"
                        px={4}
                        py={2}
                        bg={router.asPath === `/${chainName}${item.href}` ? 'whiteAlpha.200' : 'transparent'}
                        _hover={{ bg: 'whiteAlpha.300' }}
                        fontSize="13px"
                        w={"fit-content"}
                    >
                        {item.label}
                    </Button>
                ))}
                {chainName && dashboards.length > 0 && (
                    <>
                        <Button
                            rightIcon={dashboardsOpen ? <FaChevronUp /> : <FaChevronDown />}
                            variant="ghost"
                            color="#ece6d8"
                            fontWeight="semibold"
                            borderRadius="full"
                            border="none"
                            px={4}
                            py={2}
                            bg={dashboardsOpen || dashboards.some(d => router.asPath === `/${chainName}${d.href}`) ? 'whiteAlpha.200' : 'transparent'}
                            _hover={{ bg: 'whiteAlpha.300' }}
                            fontSize="13px"
                            w={"fit-content"}
                            onClick={() => setDashboardsOpen(!dashboardsOpen)}
                        >
                            Dashboards
                        </Button>
                        <Collapse in={dashboardsOpen} animateOpacity>
                            <HStack spacing={1} pl={1}>
                                {dashboards.map((item) => (
                                    <Button
                                        key={item.label}
                                        as={NextLink}
                                        href={`/${chainName}${item.href}`}
                                        variant={router.asPath === `/${chainName}${item.href}` ? 'solid' : 'ghost'}
                                        color="#ece6d8"
                                        fontWeight="semibold"
                                        borderRadius="full"
                                        border="none"
                                        px={4}
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
                        </Collapse>
                    </>
                )}
            </HStack>

            {/* Hamburger for mobile */}
            <IconButton
                ref={menuButtonRef}
                aria-label="Open menu"
                icon={<FaBars />}
                display={{ base: 'flex', lg: 'none' }}
                onClick={onOpen}
                bg="transparent"
                border="none"
                color="#ece6d8"
                fontSize="22px"
                _hover={{ bg: 'whiteAlpha.200' }}
                mr={2}
                w={"fit-content"}
                justifySelf={"left"}
            />

            {/* Right: Chain Selector & Connect Wallet */}
            <HStack spacing={{ base: 2, md: 4 }} align="center">
                <Menu>
                    <MenuButton
                        as={Button}
                        aria-label="Select chain"
                        w={"fit-content"}
                        rightIcon={<FaChevronDown />}
                        leftIcon={<Image src={currentChain.logo} alt={`${currentChain.displayName} Logo`} boxSize={6} />}
                        variant="ghost"
                        border="none"
                        color="#ece6d8"
                        _hover={{ bg: 'whiteAlpha.200' }}
                        px={2}
                    >
                    </MenuButton>
                    <MenuList bg="#0e0d10">
                        {supportedChains.map((chain) => (
                            <MenuItem
                                key={chain.name}
                                onClick={() => handleChainChange(chain.name)}
                                bg={chain.name === currentChain.name ? 'whiteAlpha.200' : 'transparent'}
                                _hover={{ bg: 'whiteAlpha.300' }}
                                color="#ece6d8"
                                cursor="pointer"
                            >
                                <HStack>
                                    <Image src={chain.logo} alt={`${chain.displayName} Logo`} boxSize={6} />
                                    <Text>{chain.displayName}</Text>
                                </HStack>
                            </MenuItem>
                        ))}
                    </MenuList>
                </Menu>
                <Box display={{ base: 'none', lg: 'block' }}>
                    <WallectConnect />
                </Box>
            </HStack>
            {/* Drawer for mobile nav */}
            <Drawer placement="left" onClose={onClose} isOpen={isOpen} size="xs" finalFocusRef={menuButtonRef}>
                <DrawerOverlay />
                {/* aria-label: the drawer has no DrawerHeader, so without this it
                    is a dialog with no accessible name — screen readers announce
                    only "dialog". */}
                <DrawerContent bg="#0e0d10" aria-label="Site navigation">
                    <DrawerBody p={0} pt={8}>
                        <VStack align="stretch" spacing={1} h="full" justify="space-between">
                            <VStack align="stretch" spacing={1}>
                                <Box mb={4}>
                                    <Logo />
                                </Box>
                                {chainName && filteredNavItems.map((item) => (
                                    <Button
                                        key={item.label}
                                        as={NextLink}
                                        href={`/${chainName}${item.href}`}
                                        variant={router.asPath === `/${chainName}${item.href}` ? 'solid' : 'ghost'}
                                        color="#ece6d8"
                                        fontWeight="semibold"
                                        borderRadius="full"
                                        border="none"
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
                                {chainName && dashboards.length > 0 && (
                                    <>
                                        <Button
                                            rightIcon={dashboardsOpen ? <FaChevronUp /> : <FaChevronDown />}
                                            variant="ghost"
                                            color="#ece6d8"
                                            fontWeight="semibold"
                                            borderRadius="full"
                                            border="none"
                                            px={6}
                                            py={4}
                                            bg={dashboardsOpen || dashboards.some(d => router.asPath === `/${chainName}${d.href}`) ? 'whiteAlpha.200' : 'transparent'}
                                            _hover={{ bg: 'whiteAlpha.300' }}
                                            fontSize="13px"
                                            maxW={"fit-content"}
                                            justifyContent="flex-start"
                                            onClick={() => setDashboardsOpen(!dashboardsOpen)}
                                        >
                                            Dashboards
                                        </Button>
                                        <Collapse in={dashboardsOpen} animateOpacity>
                                            <VStack align="stretch" spacing={1} pl={4}>
                                                {dashboards.map((item) => (
                                                    <Button
                                                        key={item.label}
                                                        as={NextLink}
                                                        href={`/${chainName}${item.href}`}
                                                        variant={router.asPath === `/${chainName}${item.href}` ? 'solid' : 'ghost'}
                                                        color="#ece6d8"
                                                        fontWeight="semibold"
                                                        borderRadius="full"
                                                        border="none"
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
                                        </Collapse>
                                    </>
                                )}
                            </VStack>
                            <Box p={4}>
                                <Text
                                    color="blue.300"
                                    fontStyle="italic"
                                    fontSize="sm"
                                    textAlign="center"
                                    mb={4}
                                >
                                    &quot;DeFy the World Together&quot;
                                </Text>
                                <Box display="flex" justifyContent="center">
                                    <WallectConnect />
                                </Box>
                            </Box>
                        </VStack>
                    </DrawerBody>
                </DrawerContent>
            </Drawer>
            {/* Centered logo for mobile */}
            <Box
                position="absolute"
                left="50%"
                top="50%"
                transform="translate(-50%, -50%)"
                display={{ base: 'block', lg: 'none' }}
            >
                <Logo />
            </Box>
        </Box>
    );
};

export default HorizontalNav; 