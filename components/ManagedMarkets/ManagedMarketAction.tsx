import React, { useMemo, useState } from 'react';
import { Box, Text, HStack, VStack, Input, Button, Slider, SliderTrack, SliderFilledTrack, SliderThumb, SliderMark, Image, useNumberInput, Stack } from '@chakra-ui/react';
import { useAssetByDenom, useAssetBySymbol } from '@/hooks/useAssets';
import { useBalanceByAsset } from '@/hooks/useBalance';
import { useManagedConfig, useManagedMarket } from '@/hooks/useManaged';
import { useOraclePrice } from '@/hooks/useOracle';
import { num } from '@/helpers/num';
import { colors } from '@/config/defaults';

const STICKY_THRESHOLD = 0.05;

// Props: action, asset, manager, market
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
    const [collateralAmount, setCollateralAmount] = useState('');
    const [multiplier, setMultiplier] = useState(1);
    const [takeProfit, setTakeProfit] = useState('');
    const [stopLoss, setStopLoss] = useState('');

    // Placeholder: get max from balance (assume 100 for now)
    // const max = useBalanceByAsset(assetDetails)
    const maxBalance = useBalanceByAsset(collateralAsset);

    // Calculate max multiplier
    const maxLTV = parseFloat(market?.collateral_params?.max_borrow_LTV || '0.67');
    const maxMultiplier = useMemo(() => 1 / (1 - maxLTV), [maxLTV]);

    // Sticky points for slider
    const stickyPoints = [1, 1 + (maxMultiplier - 1) * 0.25, 1 + (maxMultiplier - 1) * 0.5, 1 + (maxMultiplier - 1) * 0.75, maxMultiplier];

    // Snap slider to sticky points if close, else allow smooth
    const handleSliderChange = (val: number) => {
        const closest = stickyPoints.find(pt => Math.abs(pt - val) < STICKY_THRESHOLD);
        setMultiplier(closest ?? val);
    };

    // Handle manual input for multiplier
    const handleMultiplierInput = (e: React.ChangeEvent<HTMLInputElement>) => {
        let val = parseFloat(e.target.value);
        if (isNaN(val)) val = 1;
        if (val < 1) val = 1;
        if (val > maxMultiplier) val = maxMultiplier;
        setMultiplier(val);
    };
    console.log(takeProfit, stopLoss);
    // Handle Take Profit and Stop Loss input changes
    const handleTakeProfitChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        e.preventDefault();
        const val = e.target.value;
        if (val === '' || /^\d*\.?\d*$/.test(val)) setTakeProfit(val);
    };
    const handleStopLossChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        e.preventDefault();
        const val = e.target.value;
        if (val === '' || /^\d*\.?\d*$/.test(val)) setStopLoss(val);
    };

    return (
        <Box w="100vw" minH="100vh" display="flex" justifyContent="center" alignItems="flex-start" py={{ base: 6, md: 12 }}>
            {/* Outer border effect container */}
            <Box
                // w={{ base: '98vw' }} 
                borderRadius="2xl"
                p={{ base: 1.5, md: 2.5 }}
                bgGradient="linear(135deg, #232A3E 0%, #232A3E 100%)"
                display="flex"
                justifyContent="center"
                alignItems="center"
                boxShadow="0 0 0 4px #232A3E"
            >
                {/* Main content box */}
                <Box
                    w="100%"
                    bg="#20232C"
                    borderRadius="2xl"
                    p={{ base: 4, md: 8 }}
                    minH="70vh"
                    maxH="80vh"
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
                    <VStack spacing={8} align="stretch" w="100%" maxW="600px" mx="auto">
                        {/* Top: Action, Asset, Manager */}
                        <HStack justify="space-between" align="center" w="100%">
                            <Text fontSize="2xl" fontWeight="bold">{action}</Text>
                            <HStack>
                                <Image src={collateralAsset?.logo} alt={collateralAsset?.symbol} boxSize="32px" />
                                <Text fontSize="xl" fontWeight="bold">{collateralAsset?.symbol}</Text>
                            </HStack>
                            <Box bg="gray.700" px={3} py={1} borderRadius="md">
                                <Text fontSize="sm" color="whiteAlpha.800">Managed by</Text>
                                <Text fontSize="sm" fontWeight="bold">{config?.owner ?? "..."}</Text>
                            </Box>
                        </HStack>

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
                                        value={collateralAmount}
                                        onChange={e => setCollateralAmount(e.target.value)}
                                        type="number"
                                        min={0}
                                        max={maxBalance}
                                        placeholder="0"
                                        w="100%"
                                        _placeholder={{ color: 'whiteAlpha.400' }}
                                        paddingInlineEnd={"3"}
                                    />
                                    <Text color="whiteAlpha.600" fontSize="md">~ ${collateralPrice ? num(collateralPrice).times(collateralAmount).toFixed(2) : "0.00"}</Text>
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
                                        onClick={() => setCollateralAmount(maxBalance.toString())}
                                    >
                                        Wallet 0
                                    </Text>
                                </VStack>
                            </HStack>
                        </Box>
                        {/* Multiplier input and slider */}
                        <Box px={2}>
                            <HStack mb={2} justify="flex-end">
                                <Text fontWeight="bold" color="whiteAlpha.800">Multiplier:</Text>
                                <Input
                                    value={multiplier.toFixed(2)}
                                    onChange={handleMultiplierInput}
                                    type="number"
                                    min={1}
                                    max={maxMultiplier}
                                    step={0.01}
                                    w={`${Math.max(multiplier.toFixed(2).length + 1, 5)}ch`}
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
                                value={multiplier}
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
                        {/* Take Profit / Stop Loss + Deploy */}
                        <HStack align="flex-end" spacing={4}>
                            <VStack spacing={4} flex={1} align="stretch">
                                <HStack gap="0">
                                    <Text minW="120px" color="whiteAlpha.800" fontWeight="medium">Take Profit @ $</Text>
                                    <Input
                                        value={takeProfit}
                                        onChange={handleTakeProfitChange}
                                        type="text"
                                        bg="gray.800"
                                        color="white"
                                        textAlign={"left"}
                                        paddingInlineEnd={"2"}
                                        paddingInlineStart={"2"}
                                        minWidth={"60px"}
                                    />
                                </HStack>
                                <HStack gap="0">
                                    <Text minW="120px" color="whiteAlpha.800" fontWeight="medium">Stop Loss @ $</Text>
                                    <Input
                                        value={stopLoss}
                                        onChange={handleStopLossChange}
                                        type="text"
                                        bg="gray.800"
                                        color="white"
                                        textAlign={"left"}
                                        paddingInlineEnd={"2"}
                                        paddingInlineStart={"2"}
                                        minWidth={"60px"}
                                    />
                                </HStack>
                            </VStack>
                            <Button h="88px" color={colors.tabBG} fontSize="2xl" px={10} borderRadius="xl">
                                DEPLOY
                            </Button>
                        </HStack>
                    </VStack>
                </Box>
            </Box>
        </Box>
    );
};

export default ManagedMarketAction;
