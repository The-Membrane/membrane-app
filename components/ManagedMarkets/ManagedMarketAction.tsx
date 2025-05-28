import React, { useMemo, useState } from 'react';
import { Box, Text, HStack, VStack, Input, Button, Slider, SliderTrack, SliderFilledTrack, SliderThumb, SliderMark, Image, useNumberInput, Stack, Card, Tabs, TabList, Tab, TabPanels, TabPanel } from '@chakra-ui/react';
import { useAssetByDenom, useAssetBySymbol } from '@/hooks/useAssets';
import { useBalanceByAsset } from '@/hooks/useBalance';
import { useManagedConfig, useManagedMarket } from '@/hooks/useManaged';
import { useOraclePrice } from '@/hooks/useOracle';
import { num } from '@/helpers/num';
import { colors } from '@/config/defaults';
import useManagedAction from './hooks/useManagedMarket';
import { useRouter } from 'next/router';
import useBorrowAndBoost from './hooks/useBorrowAndBoost';
import ConfirmModal from '@/components/ConfirmModal/ConfirmModal';
import ManagedMarketSummary from '@/components/ManagedMarkets/ManagedMarketSummary';

const STICKY_THRESHOLD = 0.05;

// Props: action, marketAddress, collateralSymbol
const ManagedMarketAction = ({
    action = 'Multiply',
    marketAddress = "Loading...",
    collateralSymbol = "Loading...",
}) => {
    //Get collateral asset from symbol
    const collateralAsset = useAssetBySymbol(collateralSymbol, 'osmosis');
    //Get market details
    const { data: market } = useManagedMarket(marketAddress, collateralAsset?.base || "");
    const { data: config } = useManagedConfig(marketAddress);
    //Get asset price
    const { data: prices } = useOraclePrice();
    const collateralPrice = prices?.find(p => p.denom === collateralAsset?.base)?.price;
    // Get asset details and balance
    // (Assume assets array is available or fetched elsewhere, or use placeholder)
    // const assetDetails = useAssetByDenom(asset.base, 'osmosis', assets)
    // For now, use asset.logo

    // Zustand state (no selectedAction)
    const {
        managedActionState,
        setManagedActionState
    } = useManagedAction();

    // Local UI toggles
    const [showTakeProfit, setShowTakeProfit] = useState(false);
    const [showStopLoss, setShowStopLoss] = useState(false);

    // Placeholder: get max from balance (assume 100 for now)
    // const max = useBalanceByAsset(assetDetails)
    const maxBalance = useBalanceByAsset(collateralAsset);

    // Calculate max multiplier
    const maxLTV = parseFloat(market?.collateral_params?.max_borrow_LTV || '0.67');
    const maxMultiplier = useMemo(() => 1 / (1 - maxLTV), [maxLTV]);

    // Sticky points for slider
    const stickyPoints = [1, 1 + (maxMultiplier - 1) * 0.25, 1 + (maxMultiplier - 1) * 0.5, 1 + (maxMultiplier - 1) * 0.75, maxMultiplier];

    // Router for shallow routing
    const router = useRouter();
    const { marketAddress: address, action: routeAction } = router.query;
    const actionLabels = ["Multiply", "Lend", "Strategize"];
    const actionMap = ['multiply', 'lend', 'strategize'];

    // Derive selected tab index from route
    let selectedTab = 0;
    if (Array.isArray(routeAction) && routeAction[1]) {
        selectedTab = actionMap.indexOf(routeAction[1]);
    } else if (typeof routeAction === 'string') {
        selectedTab = actionMap.indexOf(routeAction);
    }
    if (selectedTab === -1) selectedTab = 0;

    // Snap slider to sticky points if close, else allow smooth
    const handleSliderChange = (val: number) => {
        const closest = stickyPoints.find(pt => Math.abs(pt - val) < STICKY_THRESHOLD);
        setManagedActionState({ multiplier: closest ?? val });
    };

    // Handle manual input for multiplier
    const handleMultiplierInput = (e: React.ChangeEvent<HTMLInputElement>) => {
        let val = parseFloat(e.target.value);
        if (isNaN(val)) val = 1;
        if (val < 1) val = 1;
        if (val > maxMultiplier) val = maxMultiplier;
        setManagedActionState({ multiplier: val });
    };

    // Handle Take Profit and Stop Loss input changes
    const handleTakeProfitChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        e.preventDefault();
        const val = e.target.value;
        if (val === '' || /^\d*\.?\d*$/.test(val)) setManagedActionState({ takeProfit: val });
    };
    const handleStopLossChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        e.preventDefault();
        const val = e.target.value;
        if (val === '' || /^\d*\.?\d*$/.test(val)) setManagedActionState({ stopLoss: val });
    };

    // Handle collateral amount input
    const handleCollateralAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setManagedActionState({ collateralAmount: e.target.value });
    };

    // Handle selected action/tab: update route shallowly
    const handleTabChange = (idx: number) => {
        const newAction = actionMap[idx];
        // Build new route: /[address]/[collateralSymbol]/[newAction]
        console.log(address, collateralSymbol, newAction);
        if (address && collateralSymbol) {
            router.push(`/${address}/${collateralSymbol}/${newAction}`, undefined, { shallow: true });
        }
    };

    // Add useBorrowAndBoost for Multiply action
    const { action: borrowAndBoost } = useBorrowAndBoost({
        marketContract: marketAddress,
        collateralDenom: collateralAsset?.base || '',
        managedActionState,
        run: selectedTab === 0, // Only run for Multiply tab
    });

    return (
        <VStack w="fit-content" spacing={6} align="center" mt={8}>
            <Tabs
                index={selectedTab}
                onChange={handleTabChange}
                variant="unstyled"
                // w="100%"
                maxW="600px"
            >
                <TabList
                    bg="transparent"
                    borderRadius="xl"
                    border="1px solid #232A3E"
                    px={2}
                    py={1}
                    paddingInlineEnd={"0"}
                    display="flex"
                    justifyContent="space-between"
                >
                    {actionLabels.map((label, idx) => (
                        <Tab
                            key={label}
                            fontSize="2xl"
                            fontWeight="bold"
                            color={selectedTab === idx ? 'white' : 'whiteAlpha.600'}
                            borderBottom={selectedTab === idx ? '2px solid #6fffc2' : '2px solid transparent'}
                            _selected={{ color: 'white', borderBottom: '2px solid #6fffc2', bg: 'transparent' }}
                            _focus={{ boxShadow: 'none' }}
                            px={8}
                            py={2}
                            borderRadius="xl xl 0 0"
                            transition="all 0.2s"
                        >
                            {label}
                        </Tab>
                    ))}
                </TabList>
                <TabPanels>
                    <TabPanel px={0} py={0}>
                        <Card
                            borderRadius="2xl"
                            border="4px solid #232A3E"
                            bg="#20232C"
                            p={{ base: 4, md: 8 }}
                            h="fit-content"
                            // maxH="98vh"
                            w="40vw"
                            maxW="600px"
                            m="0 auto"
                            overflowY="auto"
                            sx={{
                                /* Custom scrollbar */
                                '&::-webkit-scrollbar': {
                                    width: '8px',
                                },
                                '&::-webkit-scrollbar-thumb': {
                                    background: '#232A3E',
                                    borderRadius: '8px',
                                },
                                '&::-webkit-scrollbar-track': {
                                    background: 'transparent',
                                },
                            }}
                            display="flex"
                            flexDirection="column"
                            alignItems="center"
                        >
                            {/* {Market Action input components} */}
                            <VStack spacing={8} align="stretch" w="100%" maxW="600px" mx="auto">
                                {/* Top: Action, Asset, Manager */}
                                {/* Removed the HStack with the title row */}

                                {/* Collateral input */}
                                <Box w="100%" bg="#11161e" borderRadius="lg" p={5}>
                                    <HStack justify="space-between" align="flex-start" w="100%">
                                        <VStack align="flex-start" spacing={1} flex={1}>
                                            <Text color="whiteAlpha.700" fontSize="sm" fontWeight="medium">Margin collateral</Text>
                                            <Input
                                                variant="unstyled"
                                                fontSize="3xl"
                                                fontWeight="bold"
                                                color="white"
                                                value={managedActionState.collateralAmount}
                                                onChange={handleCollateralAmountChange}
                                                type="number"
                                                min={0}
                                                max={maxBalance}
                                                placeholder="0"
                                                w="100%"
                                                _placeholder={{ color: 'whiteAlpha.400' }}
                                                paddingInlineEnd={"3"}
                                            />
                                            <Text color="whiteAlpha.600" fontSize="md">~ ${collateralPrice ? num(collateralPrice).times(managedActionState.collateralAmount).toFixed(2) : "0.00"}</Text>
                                        </VStack>
                                        <VStack align="flex-end" spacing={2}>
                                            <HStack bg="#1a2330" borderRadius="full" px={3} py={1} spacing={2}>
                                                <Image src={collateralAsset?.logo} alt={collateralAsset?.symbol} boxSize="24px" />
                                                <Text color="white" fontWeight="bold">{collateralAsset?.symbol}</Text>
                                            </HStack>
                                            <Text
                                                color="whiteAlpha.700"
                                                fontSize="md"
                                                cursor="pointer"
                                                _hover={{ textDecoration: 'underline', color: 'blue.300' }}
                                                onClick={() => setManagedActionState({ collateralAmount: maxBalance.toString() })}
                                            >
                                                Wallet 0
                                            </Text>
                                        </VStack>
                                    </HStack>
                                </Box>
                                {/* Multiplier input and slider - moved here */}
                                <Box px={2} w="100%">
                                    <HStack mb={2} justify="flex-end">
                                        <Text fontWeight="bold" color="whiteAlpha.800">Multiplier:</Text>
                                        <Input
                                            value={managedActionState.multiplier.toFixed(2)}
                                            onChange={handleMultiplierInput}
                                            type="number"
                                            min={1}
                                            max={maxMultiplier}
                                            step={0.01}
                                            w={`${Math.max(managedActionState.multiplier.toFixed(2).length + 1, 5)}ch`}
                                            bg="gray.800"
                                            color="white"
                                            textAlign="right"
                                            paddingInlineEnd={"2"}
                                            paddingInlineStart={"2"}
                                        />
                                    </HStack>
                                    <Slider
                                        min={1}
                                        max={maxMultiplier}
                                        step={0.01}
                                        value={managedActionState.multiplier}
                                        onChange={handleSliderChange}
                                        colorScheme="blue"
                                    >
                                        {stickyPoints.map((pt, i) => (
                                            <SliderMark key={i} value={pt} mt="2" ml="-1.5" fontSize="sm" color="whiteAlpha.700">
                                                {pt.toFixed(2)}x
                                            </SliderMark>
                                        ))}
                                        <SliderTrack bg="gray.700">
                                            <SliderFilledTrack bg="blue.400" />
                                        </SliderTrack>
                                        <SliderThumb boxSize={6} />
                                    </Slider>
                                </Box>
                                {/* Take Profit / Stop Loss Inputs - full width below multiplier */}
                                <VStack spacing={4} w="100%" align="stretch">
                                    {showTakeProfit || showStopLoss ? (
                                        <VStack spacing={4} w="100%" align="stretch">
                                            <HStack w="100%" justify="space-between">
                                                <Text
                                                    minW="120px"
                                                    color="whiteAlpha.800"
                                                    fontWeight="medium"
                                                    cursor="pointer"
                                                    onClick={() => setShowTakeProfit(!showTakeProfit)}
                                                    _hover={{ color: 'white' }}
                                                    textAlign="center"
                                                    flex={1}
                                                    bg="gray.800"
                                                    py={2}
                                                    borderRadius="md"
                                                >
                                                    {showTakeProfit ? 'Take Profit Price:' : 'Set a TP'}
                                                </Text>
                                                {showTakeProfit && (
                                                    <Input
                                                        value={managedActionState.takeProfit}
                                                        onChange={handleTakeProfitChange}
                                                        type="text"
                                                        bg="gray.800"
                                                        color="white"
                                                        textAlign={"right"}
                                                        paddingInlineEnd={"2"}
                                                        paddingInlineStart={"2"}
                                                        minWidth={"60px"}
                                                        w="100%"
                                                    />
                                                )}
                                            </HStack>
                                            <HStack w="100%" justify="space-between">
                                                <Text
                                                    minW="120px"
                                                    color="whiteAlpha.800"
                                                    fontWeight="medium"
                                                    cursor="pointer"
                                                    onClick={() => setShowStopLoss(!showStopLoss)}
                                                    _hover={{ color: 'white' }}
                                                    textAlign="center"
                                                    flex={1}
                                                    bg="gray.800"
                                                    py={2}
                                                    borderRadius="md"
                                                >
                                                    {showStopLoss ? 'Stop Loss Price:' : 'Set a SL'}
                                                </Text>
                                                {showStopLoss && (
                                                    <Input
                                                        value={managedActionState.stopLoss}
                                                        onChange={handleStopLossChange}
                                                        type="text"
                                                        bg="gray.800"
                                                        color="white"
                                                        textAlign={"right"}
                                                        paddingInlineEnd={"2"}
                                                        paddingInlineStart={"2"}
                                                        minWidth={"60px"}
                                                        w="100%"
                                                    />
                                                )}
                                            </HStack>
                                        </VStack>
                                    ) : (
                                        <HStack w="100%" justify="space-between" spacing={4}>
                                            <Text
                                                color="whiteAlpha.800"
                                                fontWeight="medium"
                                                cursor="pointer"
                                                onClick={() => setShowTakeProfit(!showTakeProfit)}
                                                _hover={{ color: 'white' }}
                                                textAlign="center"
                                                flex={1}
                                                bg="gray.800"
                                                py={2}
                                                borderRadius="md"
                                            >
                                                Set a TP
                                            </Text>
                                            <Text
                                                color="whiteAlpha.800"
                                                fontWeight="medium"
                                                cursor="pointer"
                                                onClick={() => setShowStopLoss(!showStopLoss)}
                                                _hover={{ color: 'white' }}
                                                textAlign="center"
                                                flex={1}
                                                bg="gray.800"
                                                py={2}
                                                borderRadius="md"
                                            >
                                                Set a SL
                                            </Text>
                                        </HStack>
                                    )}
                                </VStack>
                                {/* Input components end */}
                                {/* Info Card mirroring the image - moved above Deploy button */}
                                <Box w="100%" bg="#181C23" borderRadius="lg" p={6} mt={0} mb={2}>
                                    <VStack align="stretch" spacing={2}>
                                        <HStack justify="space-between">
                                            <Text color="whiteAlpha.700">Multiplier</Text>
                                            <Text color="white" fontWeight="bold">{managedActionState.multiplier.toFixed(2)}x</Text>
                                        </HStack>
                                        <HStack justify="space-between">
                                            <Text color="whiteAlpha.700">Collateral</Text>
                                            <Text color="white" fontWeight="bold">{managedActionState.collateralAmount || 0} {collateralAsset?.symbol}</Text>
                                        </HStack>
                                        <HStack justify="space-between">
                                            <Text color="whiteAlpha.700">Managed by</Text>
                                            <Text color="white" fontWeight="bold">{config?.owner ?? "-"}</Text>
                                        </HStack>
                                        <HStack justify="space-between">
                                            <Text color="whiteAlpha.700">Current price</Text>
                                            <Text color="white" fontWeight="bold">{collateralPrice ? `$${num(collateralPrice).toFixed(2)}` : '-'}</Text>
                                        </HStack>
                                        <HStack justify="space-between">
                                            <Text color="whiteAlpha.700">Liquidation price</Text>
                                            <Text color="white" fontWeight="bold">-</Text>
                                        </HStack>
                                        <HStack justify="space-between">
                                            <Text color="whiteAlpha.700">Your LTV (LLTV)</Text>
                                            <Text color="white" fontWeight="bold">-</Text>
                                        </HStack>
                                        <HStack justify="space-between">
                                            <Text color="whiteAlpha.700">Your health</Text>
                                            <Text color="white" fontWeight="bold">-</Text>
                                        </HStack>
                                        <HStack justify="space-between">
                                            <Text color="whiteAlpha.700">Your Take Profit</Text>
                                            <Text color="white" fontWeight="bold">{managedActionState.takeProfit ? `$${managedActionState.takeProfit}` : '-'}</Text>
                                        </HStack>
                                        <HStack justify="space-between">
                                            <Text color="whiteAlpha.700">Your Stop Loss</Text>
                                            <Text color="white" fontWeight="bold">{managedActionState.stopLoss ? `$${managedActionState.stopLoss}` : '-'}</Text>
                                        </HStack>
                                        <HStack justify="space-between">
                                            <Text color="whiteAlpha.700">Slippage tolerance</Text>
                                            <Text color="white" fontWeight="bold">0.1%</Text>
                                        </HStack>
                                    </VStack>
                                </Box>
                                {/* Deploy button at the bottom */}
                                <ConfirmModal
                                    label={actionLabels[selectedTab].toUpperCase()}
                                    action={borrowAndBoost}
                                    isDisabled={!managedActionState.collateralAmount || !managedActionState.multiplier || Number(managedActionState.collateralAmount) <= 0 || managedActionState.multiplier < 1}
                                >
                                    <ManagedMarketSummary managedActionState={managedActionState} borrowAndBoost={borrowAndBoost} collateralAsset={collateralAsset} />
                                </ConfirmModal>
                            </VStack>
                        </Card>
                    </TabPanel>
                    <TabPanel px={0} py={0}>
                        <Card
                            borderRadius="2xl"
                            border="4px solid #232A3E"
                            bg="#20232C"
                            p={{ base: 4, md: 8 }}
                            h="fit-content"
                            w="vwvw"
                            maxW="600px"
                            m="0 auto"
                            overflowY="auto"
                            display="flex"
                            flexDirection="column"
                            alignItems="center"
                        >
                            <Text fontSize="2xl" color="white">Lend {collateralAsset?.symbol ? collateralAsset.symbol : ''}</Text>
                            <Text fontSize="lg" color="whiteAlpha.600" mt={4}>Not available yet.</Text>
                        </Card>
                    </TabPanel>
                    <TabPanel px={0} py={0}>
                        <Card
                            borderRadius="2xl"
                            border="4px solid #232A3E"
                            bg="#20232C"
                            p={{ base: 4, md: 8 }}
                            h="fit-content"
                            w="vwvw"
                            maxW="600px"
                            m="0 auto"
                            overflowY="auto"
                            display="flex"
                            flexDirection="column"
                            alignItems="center"
                        >
                            <Text fontSize="2xl" color="white">Strategize {collateralAsset?.symbol ? collateralAsset.symbol : ''}</Text>
                            <Text fontSize="lg" color="whiteAlpha.600" mt={4}>Not available yet.</Text>
                        </Card>
                    </TabPanel>
                </TabPanels>
            </Tabs>
        </VStack>
    );
};

export default ManagedMarketAction;
