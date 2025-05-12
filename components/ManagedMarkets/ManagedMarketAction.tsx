import React, { useMemo, useState } from 'react';
import { Box, Text, HStack, VStack, Input, Button, Slider, SliderTrack, SliderFilledTrack, SliderThumb, SliderMark, Image, useNumberInput, Stack } from '@chakra-ui/react';
import { useAssetByDenom } from '@/hooks/useAssets';
import { useBalanceByAsset } from '@/hooks/useBalance';

// Props: action, asset, manager, market
const ManagedMarketAction = ({
    action = 'Multiply',
    asset = { symbol: 'OSMO', base: 'uosmo', logo: '/osmo-logo.png' },
    manager = 'osmo1manageraddress',
    market = { params: { collateral_params: { max_borrow_LTV: '0.67' } } },
}) => {
    // Get asset details and balance
    // (Assume assets array is available or fetched elsewhere, or use placeholder)
    // const assetDetails = useAssetByDenom(asset.base, 'osmosis', assets)
    // For now, use asset.logo
    const [collateral, setCollateral] = useState('');
    const [multiplier, setMultiplier] = useState(1);
    const [takeProfit, setTakeProfit] = useState('');
    const [stopLoss, setStopLoss] = useState('');

    // Placeholder: get max from balance (assume 100 for now)
    // const max = useBalanceByAsset(assetDetails)
    const max = 100;

    // Calculate max multiplier
    const maxLTV = parseFloat(market.params.collateral_params.max_borrow_LTV || '0.67');
    const maxMultiplier = useMemo(() => 1 / (1 - maxLTV), [maxLTV]);

    // Sticky points for slider
    const stickyPoints = [1, 1 + (maxMultiplier - 1) * 0.25, 1 + (maxMultiplier - 1) * 0.5, 1 + (maxMultiplier - 1) * 0.75, maxMultiplier];

    // Snap slider to sticky points
    const handleSliderChange = (val: number) => {
        // Find closest sticky point
        const closest = stickyPoints.reduce((prev, curr) => Math.abs(curr - val) < Math.abs(prev - val) ? curr : prev);
        setMultiplier(closest);
    };

    return (
        <VStack spacing={8} align="stretch" w="100%" maxW="600px" mx="auto" py={8}>
            {/* Top: Action, Asset, Manager */}
            <HStack justify="space-between" align="center" w="100%">
                <Text fontSize="2xl" fontWeight="bold">{action}</Text>
                <HStack>
                    <Image src={asset.logo} alt={asset.symbol} boxSize="32px" />
                    <Text fontSize="xl" fontWeight="bold">{asset.symbol}</Text>
                </HStack>
                <Box bg="gray.700" px={3} py={1} borderRadius="md">
                    <Text fontSize="sm" color="whiteAlpha.800">Managed by</Text>
                    <Text fontSize="sm" fontWeight="bold">{manager}</Text>
                </Box>
            </HStack>

            {/* Collateral input */}
            <Box>
                <HStack spacing={2} align="center">
                    <Image src={asset.logo} alt={asset.symbol} boxSize="28px" />
                    <Input
                        placeholder={`Amount of ${asset.symbol}`}
                        value={collateral}
                        onChange={e => setCollateral(e.target.value)}
                        type="number"
                        min={0}
                        max={max}
                        flex={1}
                        bg="gray.800"
                        color="white"
                    />
                    <Button size="sm" onClick={() => setCollateral(max.toString())} variant="outline" colorScheme="blue">Max</Button>
                </HStack>
            </Box>
            {/* Multiplier slider */}
            <Box px={2}>
                <Text mb={2} fontWeight="bold" color="whiteAlpha.800" textAlign="right">Max: {maxMultiplier.toFixed(2)}x</Text>
                <Slider
                    min={1}
                    max={maxMultiplier}
                    step={0.01}
                    value={multiplier}
                    onChange={handleSliderChange}
                    colorScheme="blue"
                >
                    {stickyPoints.map((pt, i) => (
                        <SliderMark key={i} value={pt} mt="2" ml="-2.5" fontSize="sm" color="whiteAlpha.700">
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
                    <Input
                        placeholder="Take Profit @ $"
                        value={takeProfit}
                        onChange={e => setTakeProfit(e.target.value)}
                        type="number"
                        bg="gray.800"
                        color="white"
                    />
                    <Input
                        placeholder="Stop Loss @ $"
                        value={stopLoss}
                        onChange={e => setStopLoss(e.target.value)}
                        type="number"
                        bg="gray.800"
                        color="white"
                    />
                </VStack>
                <Button h="88px" colorScheme="blue" fontSize="2xl" px={10} borderRadius="xl">
                    DEPLOY
                </Button>
            </HStack>
        </VStack>
    );
};

export default ManagedMarketAction; 