import { Box, Button, HStack, Image, Stack, Text, Spacer, IconButton, Drawer, DrawerOverlay, DrawerContent, DrawerBody, useDisclosure, VStack, Menu, MenuButton, MenuList, MenuItem, Collapse } from '@chakra-ui/react';
import React, { useEffect, useRef, useState } from 'react';
import { FaUserCircle, FaBars, FaChevronDown, FaChevronUp } from 'react-icons/fa';
import WallectConnect from './WallectConnect/WalletConnect';
import NextLink from 'next/link';
import { useRouter } from 'next/router';
import { colors } from '@/config/defaults';
import { SEMANTIC_COLORS } from '@/config/semanticColors';
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions';
import Logo from './Logo';
import { supportedChains, getChainConfig } from '@/config/chains';
import { useChainRoute } from '@/hooks/useChainRoute';
import useAppState from '@/persisted-state/useAppState';

// Sim-first launch (owner ruling, Aug 31 2026 — docs/GAME_LAUNCH_PLAN.md): the simulation
// game goes public before any executable page. Only the wallet-free surfaces sit at the top
// level; everything that needs a live contract is grouped under the "Coming soon" menu.
// Keeping all 13 flat overflowed the nav and pushed the whole document sideways by 252px.
// Evidence is the landing page (renders at '/'), so its nav entry points at the root
// rather than /evidence — that route 307s here, keeping one canonical URL.
// The old marketing home moved to /home; it was not deleted.
const navItems = [
    { label: 'Evidence', href: '/' },
    { label: 'Simulator', href: '/simulator' },
    // Wallet-free personal BTC/LTV calculator (Landing page) — was orphaned from
    // both nav and sitemap despite being the strongest no-commitment decision tool.
    { label: 'Calculator', href: '/landing' },
    // Wallet-free carry-trader decision tool: paste any address, stress its
    // positions against our recorded venue capacity + flow corpus.
    { label: 'Radar', href: '/radar' },
    { label: 'Home', href: '/home' },
    { label: 'Builder', href: '/builder' },
    { label: 'Defend', href: '/defend' },
    // Promoted out of the removed Dashboards menu — it stands on its own.
    { label: 'Membrane', href: '/membrane-dashboard' },
    // Lore/marketing page — kept reachable, but numbers-first surfaces lead the nav.
    { label: 'About', href: '/about' },
];

// Reachable, but not advertised as live. Depth-ordered per public/proto/flow.html.
const comingSoonItems = [
    // Direct door to the Levels directory (Transmuter, Manic, Stake, Maze Runners) —
    // previously only discoverable by completing the Home fingerprint-scan ritual.
    { label: 'Levels', href: '/levels' },
    { label: 'Position', href: '/position' },
    { label: 'Borrow', href: '/borrow' },
    { label: 'Carry', href: '/carry' },
    { label: 'Earn', href: '/earn' },
    { label: 'Liquidate', href: '/liquidate' },
    { label: 'Mint', href: '/mint' },
    { label: 'Portfolio', href: '/portfolio' }, // flow.html marks this replaced by Position — keep until owner removes
    { label: 'The Disco', href: '/disco' },
    // Fully built page that was orphaned from every nav path.
    { label: 'Boost', href: '/boost' },
    // { label: 'Transmuter', href: '/transmuter' },
    // { label: 'Maze Runners', href: '/maze-runners' },
    // { label: 'Bridge', href: '/bridge' },

    // { label: 'Manic', href: '/manic' }, //There is 190 TVL in here so whoever's that is can just type /manic
    // { label: 'Isolated Markets', href: '/isolated' }, //Remove supplied CDT Trix
    // { label: 'Stake', href: '/stake' },
    // { label: 'Control Room', href: '/control-room' },
];

// Dashboards menu removed (owner ruling, Aug 31 2026):
//   - Acquisition — the underlying feature does not exist yet
//   - LTVs        — these updates belong on the Disco / Defend pages, not a separate dashboard
//   - Membrane    — promoted to a solo top-level nav item above
// Emptied rather than deleted: both render sites are guarded by `dashboards.length > 0`,
// so the menu disappears while the markup stays ready to restore. The pages themselves
// are untouched and still reachable by direct URL.
const dashboardItems: { label: string; href: string }[] = [];

// Neutron only shows Maze Runners
const neutronNavItems = [
    { label: 'Maze Runners', href: '/maze-runners' },
];

const getNavItemsForChain = (chainName: string) => {
    if (chainName === 'neutron' || chainName === 'neutrontestnet') {
        return { navItems: neutronNavItems, comingSoon: [] as typeof comingSoonItems, dashboards: [] as typeof dashboardItems };
    }
    return { navItems, comingSoon: comingSoonItems, dashboards: dashboardItems };
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
    const { navItems: chainNavItems, comingSoon, dashboards } = getNavItemsForChain(chainName);
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
            {/* Restored — the desktop header had rendered no logo at all while this was
                commented out. Desktop ONLY: a separate centred logo already renders below
                at the mobile breakpoint, and without this gate both draw at once and
                collide with the hamburger. */}
            {/* The DISPLAY GATE MUST BE ON THIS ELEMENT, not on an inner Box. The nav is
                justify-content:space-between; a wrapper that stays in the flow with zero
                width still counts as a flex item, so space-between distributed the
                hamburger into the centre of the bar (measured x=135 on a 390px viewport)
                where it collided with the absolutely-centred mobile logo. */}
            <Box
                as={NextLink}
                href={`/${chainName}`}
                aria-label="Membrane home"
                display={{ base: 'none', lg: 'flex' }}
                alignItems="center"
                flexShrink={0}
            >
                <Logo height="34px" />
            </Box>
            {/* <Stack spacing={0} alignContent={"start"}> */}
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

            {/* Desktop Nav.
                minW={0} lets this flex child shrink below its content width; without it the
                item row (currently ~1.2k px) sets the nav's scrollWidth and the overflow
                escapes to <html>, scrolling the whole document sideways on every page. */}
            <HStack
                spacing={1}
                display={{ base: 'none', lg: 'flex' }}
                minW={0}
                overflowX="auto"
                sx={{ scrollbarWidth: 'none', '&::-webkit-scrollbar': { display: 'none' } }}
            >
                {chainName && filteredNavItems.map((item) => (
                    <Button
                        key={item.label}
                        as={NextLink}
                        href={`/${chainName}${item.href}`}
                        variant={router.asPath === `/${chainName}${item.href}` ? 'solid' : 'ghost'}
                        color={SEMANTIC_COLORS.textPrimary}
                        fontWeight="semibold"
                        borderRadius={0}
                        border="none"
                        px={4}
                        py={2}
                        bg={router.asPath === `/${chainName}${item.href}` ? SEMANTIC_COLORS.bgTertiary : 'transparent'}
                        transition={TRANSITIONS.colors}
                        _hover={{ bg: SEMANTIC_COLORS.bgTertiary, color: SEMANTIC_COLORS.success }}
                        _focusVisible={FOCUS_STYLES.ring}
                        fontSize="13px"
                        w={"fit-content"}
                        /* Never let the label squeeze — the row scrolls instead of colliding. */
                        flexShrink={0}
                    >
                        {item.label}
                    </Button>
                ))}
                {chainName && comingSoon.length > 0 && (
                    <Menu>
                        {/* Plain MenuButton, not `as={Button}` — that combination lets emotion's
                            dev-mode <style> tag render inside the trigger, which poisons the
                            accessible name (it read as ".css-xl71ch{pointer-" instead of a label). */}
                        <MenuButton
                            aria-label="Coming soon pages"
                            color={SEMANTIC_COLORS.textSecondary}
                            fontWeight="semibold"
                            borderRadius={0}
                            px={4}
                            py={2}
                            bg={comingSoon.some(d => router.asPath === `/${chainName}${d.href}`) ? SEMANTIC_COLORS.bgTertiary : 'transparent'}
                            transition={TRANSITIONS.colors}
                            _hover={{ bg: SEMANTIC_COLORS.bgTertiary, color: SEMANTIC_COLORS.textPrimary }}
                            _focusVisible={FOCUS_STYLES.ring}
                            fontSize="13px"
                            flexShrink={0}
                            whiteSpace="nowrap"
                            /* Plain MenuButton misses the Button theme, so match its casing here. */
                            textTransform="uppercase"
                            letterSpacing="0.08em"
                        >
                            <HStack spacing={2} as="span">
                                <Text as="span">Coming soon</Text>
                                <FaChevronDown size={10} />
                            </HStack>
                        </MenuButton>
                        <MenuList
                            bg={SEMANTIC_COLORS.bgSecondary}
                            border="1px solid"
                            borderColor={SEMANTIC_COLORS.borderStrong}
                            borderRadius={0}
                            minW="200px"
                            py={0}
                        >
                            {comingSoon.map((item) => (
                                <MenuItem
                                    key={item.label}
                                    as={NextLink}
                                    href={`/${chainName}${item.href}`}
                                    bg="transparent"
                                    color={SEMANTIC_COLORS.textSecondary}
                                    fontSize="13px"
                                    fontWeight="semibold"
                                    px={4}
                                    py={2}
                                    transition={TRANSITIONS.colors}
                                    _hover={{ bg: SEMANTIC_COLORS.bgTertiary, color: SEMANTIC_COLORS.success }}
                                    _focus={{ bg: SEMANTIC_COLORS.bgTertiary }}
                                >
                                    {item.label}
                                </MenuItem>
                            ))}
                        </MenuList>
                    </Menu>
                )}
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
                        leftIcon={<Image src={currentChain.logo} alt={`${currentChain.displayName} Logo`} boxSize={7} objectFit="contain" />}
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
                                    <Image src={chain.logo} alt={`${chain.displayName} Logo`} boxSize={7} objectFit="contain" />
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
                                {chainName && comingSoon.length > 0 && (
                                    <>
                                        <Text
                                            mt={2}
                                            px={6}
                                            fontSize="11px"
                                            fontWeight="semibold"
                                            textTransform="uppercase"
                                            letterSpacing="0.28em"
                                            color={SEMANTIC_COLORS.textTertiary}
                                        >
                                            Coming soon
                                        </Text>
                                        {comingSoon.map((item) => (
                                            <Button
                                                key={item.label}
                                                as={NextLink}
                                                href={`/${chainName}${item.href}`}
                                                variant="ghost"
                                                color={SEMANTIC_COLORS.textSecondary}
                                                fontWeight="semibold"
                                                borderRadius={0}
                                                border="none"
                                                px={6}
                                                py={4}
                                                bg={router.asPath === `/${chainName}${item.href}` ? SEMANTIC_COLORS.bgTertiary : 'transparent'}
                                                transition={TRANSITIONS.colors}
                                                _hover={{ bg: SEMANTIC_COLORS.bgTertiary, color: SEMANTIC_COLORS.success }}
                                                _focusVisible={FOCUS_STYLES.ring}
                                                fontSize="13px"
                                                maxW={"fit-content"}
                                                justifyContent="flex-start"
                                                onClick={onClose}
                                            >
                                                {item.label}
                                            </Button>
                                        ))}
                                    </>
                                )}
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
            {/* Centered logo for mobile.
                Absolutely centred on the NAV rather than placed in the flex flow, so it is
                centred on the viewport instead of on whatever space is left between the
                hamburger and the wallet controls. pointerEvents is disabled on the wrapper
                so it never swallows taps meant for the controls it floats over, and
                re-enabled on the link itself. */}
            <Box
                position="absolute"
                left="50%"
                top="50%"
                transform="translate(-50%, -50%)"
                display={{ base: 'block', lg: 'none' }}
                pointerEvents="none"
                zIndex={1}
            >
                <Box
                    as={NextLink}
                    href={`/${chainName}`}
                    aria-label="Membrane home"
                    display="block"
                    pointerEvents="auto"
                >
                    <Logo height="34px" />
                </Box>
            </Box>
        </Box>
    );
};

export default HorizontalNav; 