import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Box, Flex, Text, Image, Button, VStack, HStack, Input, Tooltip, Radio, RadioGroup, Stack, useBreakpointValue, Select, Slider, SliderTrack, SliderFilledTrack, SliderThumb, NumberInput, NumberInputField } from '@chakra-ui/react';
import { InfoOutlineIcon } from '@chakra-ui/icons';
import { LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip as RechartsTooltip } from 'recharts';

// @ts-ignore
import tinycolor from 'tinycolor2';
import { Formatter } from '@/helpers/formatter';
import ConfirmModal from '../ConfirmModal';
import { Asset } from '@/helpers/chain';
import useManagedAction from '@/components/ManagedMarkets/hooks/useManagedMarketState';
import useTransformExposure from '@/components/ManagedMarkets/hooks/useIncreasedExposureCard';
import TransformExposureSummary from '@/components/ManagedMarkets/TransformExposureSummary';
import { useBasket } from '@/hooks/useCDP';
import useAppState from '@/persisted-state/useAppState';
import useAssets from '@/hooks/useAssets';
import VenueCarousel from './VenueCarousel';
import { MOCK_VENUES, Venue } from './mockVenues';
import FAQ from './FAQ';



interface AssetProps {
    logo: string;
    symbol: string;
    large?: boolean;
    glowColor?: string;
    balance?: string;
    price?: string;
    maxBorrowLTV?: number;
    maxLTV?: string;
    marketContract: string;
    asset: Asset;
}

const Mycelium: React.FC<AssetProps> = ({ logo, large, glowColor, balance, price, maxBorrowLTV, maxLTV, marketContract, asset }) => {
    // Mock LTVs for common assets (values in 0-1)
    const MOCK_LTVS: Record<string, number> = useMemo(() => ({
        uosmo: 0.55,
        untrn: 0.6,
        uatom: 0.5,
        utia: 0.5,
        ucdt: 0.9,
        umbrn: 0.4,
        uusdc: 0.85,
        uusdt: 0.8,
    }), []);
    const [mode, setMode] = useState<'multiply' | 'de-risk'>('multiply');
    const [amount, setAmount] = useState('');
    const [selectedMultiplier, setSelectedMultiplier] = useState('conservative');
    const [selectedVenue, setSelectedVenue] = useState<Venue | null>(null);
    const carouselNavigateRef = useRef<((index: number) => void) | null>(null);
    const getShowAllStateRef = useRef<(() => boolean) | null>(null);
    const [ltvInputValue, setLtvInputValue] = useState<string>('0.0');
    const inputRef = useRef<HTMLInputElement>(null);
    const isMobile = useBreakpointValue({ base: true, md: false });
    const { appState } = useAppState();
    const { data: basket } = useBasket(appState.rpcUrl);
    const chainAssets = useAssets();
    const { managedActionState, setManagedActionState } = useManagedAction();

    // Selected asset state (default to prop asset)
    const [selectedAssetBase, setSelectedAssetBase] = useState<string | undefined>(asset?.base);
    const availableAssets = useMemo<Asset[]>(() => {
        const bases: string[] = (basket?.collateral_types || []).map((ct: any) => ct?.denom || ct?.base).filter(Boolean);
        if (!chainAssets || !bases.length) return chainAssets || (asset ? [asset] as Asset[] : []);
        return chainAssets.filter((a: Asset) => bases.includes(a.base));
    }, [basket?.collateral_types, chainAssets, asset]);

    // Auto-select first available asset if none selected
    useEffect(() => {
        if (availableAssets.length > 0 && !selectedAssetBase) {
            setSelectedAssetBase(availableAssets[0].base);
        }
    }, [availableAssets, selectedAssetBase]);

    const selectedAsset = useMemo<Asset | undefined>(() => {
        const found = availableAssets.find((a: Asset) => a.base === selectedAssetBase);
        return found || availableAssets[0] || asset;
    }, [availableAssets, selectedAssetBase, asset]);
    const symbol = selectedAsset?.symbol || asset?.symbol || 'SYM';
    const logoToShow = selectedAsset?.logo || logo;
    // Resolve maxBorrowLTV from basket collateral_types if available, else mock map, else prop
    const resolvedMaxBorrowLTV = useMemo(() => {
        const ct = basket?.collateral_types?.find((ct: any) => ct?.denom === selectedAsset?.base || ct?.base === selectedAsset?.base);
        const basketVal = ct?.max_loan_to_value;
        const mockVal = selectedAsset?.base ? MOCK_LTVS[selectedAsset.base] : undefined;
        const v = Number((basketVal ?? mockVal ?? maxBorrowLTV ?? 0));
        return isFinite(v) && v > 0 ? v : 0;
    }, [basket?.collateral_types, selectedAsset?.base, maxBorrowLTV, MOCK_LTVS]);

    const maxMultiplier = resolvedMaxBorrowLTV > 0 ? 1 / (1 - resolvedMaxBorrowLTV) : 1;

    // Calculate conservative and moderate multipliers as percentages of max
    const conservativeMultiplier = resolvedMaxBorrowLTV > 0 ? (1 / (1 - (resolvedMaxBorrowLTV * 0.4))) : 1;
    const moderateMultiplier = resolvedMaxBorrowLTV > 0 ? (1 / (1 - (resolvedMaxBorrowLTV * 0.7))) : 1;

    // Update managed market state when amount, mode or slider/multiplier choice changes
    useEffect(() => {
        let multiplierValue;
        if (selectedMultiplier === 'max') {
            multiplierValue = maxMultiplier;
        } else if (selectedMultiplier === 'conservative') {
            multiplierValue = conservativeMultiplier;
        } else if (selectedMultiplier === 'moderate') {
            multiplierValue = moderateMultiplier;
        } else {
            multiplierValue = parseFloat(selectedMultiplier);
        }

        if (mode === 'multiply') {
            setManagedActionState({
                collateralAmount: amount,
                multiplier: multiplierValue,
            });
        } else {
            // For de-risk mode, no multiplier
            setManagedActionState({
                collateralAmount: amount,
                multiplier: undefined, // No multiplier for de-risk
            });
        }
    }, [amount, mode, selectedMultiplier, setManagedActionState, maxMultiplier, conservativeMultiplier, moderateMultiplier]);
    const liqPrice = useMemo(() => {
        if (!maxLTV || maxLTV === '—' || !price || price === '0') return '';

        // Calculate liquidation price with 10% LTV buffer
        const maxLTVNum = parseFloat(maxLTV);
        const currentPrice = parseFloat(price);

        var loopLTV = 1 - 1 / managedActionState.multiplier;
        if (maxBorrowLTV && loopLTV > maxBorrowLTV) {
            loopLTV = maxBorrowLTV;
        }
        console.log('loopLTV', loopLTV, maxBorrowLTV, managedActionState.multiplier);
        const bufferLTV = maxLTVNum / (mode === 'de-risk' ? 0.1 : loopLTV);

        // Liquidation price 
        const liquidationPrice = currentPrice / bufferLTV;

        return liquidationPrice.toFixed(4);
    }, [maxLTV, price, maxBorrowLTV, managedActionState.multiplier]);
    const buttonColor = glowColor ? tinycolor(glowColor).toHexString() : '#63b3ed';
    const displayBalance = balance !== undefined ? balance : '1000';
    const displayPrice = price !== undefined ? price : '0.00';
    const value = amount && price ? (parseFloat(amount) * parseFloat(displayPrice)).toFixed(2) : '0.00';
    const collateralValue = Number(value);
    const borrowAmount = (Number(value) / 10).toString();
    const { action: transformExposure } = useTransformExposure({
        marketContract: marketContract,
        asset: selectedAsset ?? asset,
        managedActionState: managedActionState,
        maxBorrowLTV: resolvedMaxBorrowLTV ?? 0,
        collateralValue: collateralValue,
        borrowAmount: borrowAmount,
        mode: mode,
        run: true,
    });

    // Sync ltvInputValue when multiplier changes (from slider)
    // but NOT when the user is actively typing in the input
    useEffect(() => {
        const m = managedActionState.multiplier;
        if (!m || m <= 1) {
            if (document.activeElement !== inputRef.current) {
                setLtvInputValue('0.0');
            }
            return;
        }
        const ltv = 1 - 1 / m;
        const clampedLtv = Math.max(0, Math.min(resolvedMaxBorrowLTV, ltv)) * 100;

        // Only update if input is not focused (user is not typing)
        if (document.activeElement !== inputRef.current) {
            setLtvInputValue(clampedLtv.toFixed(1));
        }
    }, [managedActionState.multiplier, resolvedMaxBorrowLTV]);

    // Chart data calculation for 10-year compound growth
    interface ChartDataPoint {
        year: number;
        baseAmount: number;
        boostedAmount: number;
    }

    const chartData = useMemo((): ChartDataPoint[] => {
        const amountNum = parseFloat(amount) || 0;
        if (amountNum <= 0) return [];

        const data: ChartDataPoint[] = [];
        const baseAPR = 0.10; // 10%
        const boostedAPR = 0.15; // 15%

        for (let year = 0; year <= 10; year++) {
            const baseAmount = amountNum * Math.pow(1 + baseAPR, year);
            const boostedAmount = amountNum * Math.pow(1 + boostedAPR, year);

            data.push({
                year,
                baseAmount: Math.round(baseAmount * 100) / 100,
                boostedAmount: Math.round(boostedAmount * 100) / 100
            });
        }

        return data;
    }, [amount]);

    const formatTooltipValue = (value: number) => {
        return value.toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        });
    };

    return (
        <VStack align="center" spacing={large ? 10 : 6} w="100%" mt={8}>
            <VStack>
                <Stack direction={{ base: 'column', md: 'row' }} align="center" spacing={large ? 5 : 3} mb={large ? 0 : 0} w="auto" minW="fit-content">
                    {logoToShow && <Image src={logoToShow} alt={symbol} boxSize={large ? "48px" : "32px"} flexShrink={0} loading="lazy" decoding="async" />}
                    <Text fontWeight="bold" fontSize={large ? "4xl" : "2xl"} color="white" textAlign={{ base: 'center', md: undefined }} whiteSpace={{ base: 'nowrap', md: 'normal' }}>Mycelium</Text>
                </Stack>
                {/* Helper text under title */}
                <HStack spacing={2} align="center" justify="center">
                    <Text color="whiteAlpha.700" fontSize="sm" mt={1} mb={-2} display={{ base: 'block', md: 'block' }}>
                        Boost your yield bearing collateral to compound exponentially faster
                    </Text>
                    <Text
                        color="#3b82f6"
                        fontSize="sm"
                        cursor="pointer"
                        mt={1}
                        mb={-2}
                        _hover={{ textDecoration: 'underline' }}
                        onClick={() => {
                            const faqSection = document.getElementById('faq-section');
                            if (faqSection) {
                                faqSection.scrollIntoView({ behavior: 'smooth' });
                            }
                        }}
                    >
                        FAQ
                    </Text>
                </HStack>
            </VStack>
            {/* Amount input */}
            <Box w={{ base: '90vw', md: large ? '420px' : '380px' }}>
                <HStack justify="space-between" align="flex-start" w="100%">
                    <VStack align="flex-start" spacing={1} flex={1}>
                        <Input
                            variant="unstyled"
                            fontSize={large ? "3xl" : "2xl"}
                            fontWeight="bold"
                            color="white"
                            value={amount}
                            onChange={e => setAmount(e.target.value)}
                            type="number"
                            min={0}
                            placeholder="0"
                            w="100%"
                            _placeholder={{ color: 'whiteAlpha.400' }}
                            paddingInlineEnd={"3"}
                        />
                        <Text color="whiteAlpha.600" fontSize="md">~ ${value}</Text>
                    </VStack>
                    <VStack align="flex-end" spacing={2}>
                        {/* Asset selector menu */}
                        <HStack width="125px" bg="#1a2330" borderRadius="full" px={3} py={1} spacing={2}>
                            {logoToShow && <Image src={logoToShow} alt={symbol} boxSize="24px" loading="lazy" decoding="async" />}
                            <Select
                                value={selectedAsset?.base}
                                onChange={(e) => setSelectedAssetBase(e.target.value)}
                                variant="unstyled"
                                color="white"
                                fontWeight="bold"
                                minW="90px"
                            >
                                {(availableAssets.length ? availableAssets : (asset ? [asset] : [])).map((a: Asset) => (
                                    <option key={a.base} value={a.base} style={{ color: '#000' }}>{a.symbol}</option>
                                ))}
                            </Select>
                        </HStack>
                        {/* When selected we calc a new displayBalance based on the user's wallet contents */}
                        <HStack
                            cursor="pointer"
                            onClick={() => setAmount(displayBalance.toString())}
                            sx={{
                                '&:hover > .wallet-hover-text': {
                                    textDecoration: 'underline',
                                    color: 'blue.300',
                                },
                            }}
                        >
                            <Text className="wallet-hover-text" color="whiteAlpha.700" fontSize="md">
                                Wallet
                            </Text>
                            <Text className="wallet-hover-text" color="whiteAlpha.700" fontSize="md">
                                {Formatter.toNearestNonZero(displayBalance)}
                            </Text>
                        </HStack>
                    </VStack>
                </HStack>
            </Box>
            {/* Borrow LTV selection */}
            <VStack opacity={!amount || amount === '0' ? 0.3 : 1} transition="opacity 0.2s">
                <HStack
                    gap={4}
                    align="center"
                    spacing={2}
                    w={{ base: '90vw', md: large ? '420px' : '320px' }}
                    borderRadius="md"
                    justify={{ base: 'center', md: undefined }}
                    transition="all 0.2s"
                >
                    {/* Local Chakra slider + input for LTV (0 - resolvedMaxBorrowLTV) */}
                    <HStack w="100%" opacity={mode === 'de-risk' ? 0.5 : 1} pointerEvents={mode === 'de-risk' || !amount || amount === '0' ? 'none' : 'auto'}>
                        <Slider
                            aria-label='ltv-slider'
                            w="100%"
                            min={0}
                            max={resolvedMaxBorrowLTV}
                            step={0.005}
                            focusThumbOnChange={false}
                            value={(() => {
                                const m = managedActionState.multiplier;
                                if (!m || m <= 1) return 0;
                                const ltv = 1 - 1 / m;
                                return Math.max(0, Math.min(resolvedMaxBorrowLTV, ltv));
                            })()}
                            onChange={(ltv) => {
                                const multiplierFromLTV = ltv >= resolvedMaxBorrowLTV ? maxMultiplier : (ltv >= 0 ? 1 / (1 - ltv) : 1);
                                setSelectedMultiplier(String(multiplierFromLTV));
                                if (mode === 'multiply') {
                                    setManagedActionState({
                                        collateralAmount: amount,
                                        multiplier: multiplierFromLTV,
                                    });
                                }
                            }}
                        >
                            <SliderTrack h="10px" borderRadius="full">
                                <SliderFilledTrack />
                            </SliderTrack>
                            <SliderThumb boxSize="18px" />
                        </Slider>
                        {/* Number input for LTV */}
                        <Input
                            ref={inputRef}
                            value={ltvInputValue}
                            onChange={(e) => {
                                const inputValue = e.target.value;
                                setLtvInputValue(inputValue);

                                const valueAsNumber = parseFloat(inputValue);
                                if (isNaN(valueAsNumber)) return;

                                const ltv = Math.max(0, Math.min(resolvedMaxBorrowLTV * 100, valueAsNumber)) / 100;
                                const multiplierFromLTV = ltv >= resolvedMaxBorrowLTV ? maxMultiplier : (ltv >= 0 ? 1 / (1 - ltv) : 1);
                                setSelectedMultiplier(String(multiplierFromLTV));
                                if (mode === 'multiply') {
                                    setManagedActionState({
                                        collateralAmount: amount,
                                        multiplier: multiplierFromLTV,
                                    });
                                }
                            }}
                            onBlur={() => {
                                // Format to one decimal place on blur
                                const valueAsNumber = parseFloat(ltvInputValue);
                                if (!isNaN(valueAsNumber)) {
                                    const clamped = Math.max(0, Math.min(resolvedMaxBorrowLTV * 100, valueAsNumber));
                                    setLtvInputValue(clamped.toFixed(1));
                                }
                            }}
                            type="text"
                            color="white"
                            textAlign="center"
                            paddingInlineEnd={0}
                            paddingEnd={0}
                            paddingInlineStart={0}
                            width="63px"
                            variant="unstyled"
                            fontSize="sm"
                        />
                        <Text color="white" whiteSpace="nowrap" flexShrink={0}>% LTV</Text>
                    </HStack>
                </HStack>
                {/* Info text under borrow slider */}
                {/* <Text color="whiteAlpha.700" fontSize="sm" mt={1} mb={-2} display={{ base: 'none', md: 'block' }}>
                { }% yield boost
                </Text> */}
            </VStack>

            {/* Venue selection Card carousel */}
            <Box w={{ base: '90vw', md: '100%' }} maxW="900px" mt={4}>
                <Text color="whiteAlpha.700" fontSize="sm" mb={3} textAlign="center">
                    {selectedVenue ? (
                        <>
                            Currently Selected:{' '}
                            <Text
                                as="span"
                                color="white"
                                fontWeight="semibold"
                                cursor="pointer"
                                _hover={{ textDecoration: 'underline' }}
                                onClick={() => {
                                    // Check if we're in Show All view
                                    const isShowAll = getShowAllStateRef.current?.() ?? false;

                                    if (isShowAll) {
                                        // Already in Show All view, do nothing (venue is already highlighted)
                                        console.log('Already in Show All view, venue highlighted');
                                        return;
                                    }

                                    // Find the index of the selected venue
                                    const selectedIndex = MOCK_VENUES.findIndex(v => v.id === selectedVenue.id);
                                    if (selectedIndex !== -1 && carouselNavigateRef.current) {
                                        // Navigate to Show All view with venue highlighted
                                        const targetPage = Math.floor(selectedIndex / 3);
                                        console.log('Opening Show All for venue:', selectedVenue.name, 'at index:', selectedIndex);
                                        carouselNavigateRef.current(targetPage);
                                    }
                                }}
                            >
                                {selectedVenue.name}
                            </Text>
                        </>
                    ) : (
                        'Select a deployment venue'
                    )}
                </Text>
                <VenueCarousel
                    venues={MOCK_VENUES}
                    onVenueSelect={setSelectedVenue}
                    selectedVenueId={selectedVenue?.id}
                    onNavigateToVenue={(navigateFn, getShowAllStateFn) => {
                        carouselNavigateRef.current = navigateFn;
                        getShowAllStateRef.current = getShowAllStateFn;
                    }}
                />
            </Box>

            {/* Compound Yield Chart */}
            <Box w="100%" maxW="700px" mt={8} mb={4}>
                <VStack spacing={4} w="100%">
                    <Text color="white" fontSize="lg" fontWeight="semibold" textAlign="center">
                        10-Year Compound Growth Comparison
                    </Text>

                    {chartData.length > 0 ? (
                        <Box w="100%" h="300px" position="relative" bg="#1a2330" borderRadius="md" p={4}>
                            <VStack spacing={2} align="stretch" h="100%">
                                {/* Simple text-based chart representation */}
                                <Text color="white" fontSize="sm" textAlign="center">
                                    Compound Growth Projection (10 years)
                                </Text>

                                {/* Recharts Line Chart */}
                                <Box flex="1" minH="200px" w="100%">
                                    <ResponsiveContainer width="100%" height="100%">
                                        <LineChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
                                            <XAxis
                                                dataKey="year"
                                                tick={{ fontSize: 12, fill: '#9CA3AF' }}
                                                axisLine={{ stroke: '#374151' }}
                                                tickLine={{ stroke: '#374151' }}
                                                label={{ value: 'Year', position: 'insideBottom', offset: -10, style: { textAnchor: 'middle', fill: '#9CA3AF', fontSize: '12px' } }}
                                            />
                                            <YAxis
                                                tick={{ fontSize: 12, fill: '#9CA3AF' }}
                                                axisLine={{ stroke: '#374151' }}
                                                tickLine={{ stroke: '#374151' }}
                                                label={{ value: symbol, angle: -90, position: 'insideLeft', style: { textAnchor: 'middle', fill: '#9CA3AF', fontSize: '12px' } }}
                                                tickFormatter={(value) => {
                                                    if (value >= 1000) {
                                                        return `${(value / 1000).toFixed(1)}K`;
                                                    }
                                                    return value.toFixed(0);
                                                }}
                                            />
                                            <RechartsTooltip
                                                contentStyle={{
                                                    backgroundColor: '#1f2937',
                                                    border: '1px solid #374151',
                                                    borderRadius: '8px',
                                                    color: 'white'
                                                }}
                                                labelStyle={{ color: 'white' }}
                                                formatter={(value: any, name: string, props: any) => {
                                                    const dataKey = props.dataKey;
                                                    const label = dataKey === 'baseAmount' ? 'Base APR (10%)' : 'Boosted APR (15%)';
                                                    return [`${formatTooltipValue(value)} tokens`, label];
                                                }}
                                                labelFormatter={(label) => `Year ${label}`}
                                            />
                                            <Line
                                                type="monotone"
                                                dataKey="baseAmount"
                                                stroke="#9CA3AF"
                                                strokeWidth={2}
                                                dot={false}
                                                name="Base APR (10%)"
                                            />
                                            <Line
                                                type="monotone"
                                                dataKey="boostedAmount"
                                                stroke="#3b82f6"
                                                strokeWidth={3}
                                                dot={false}
                                                name="Boosted APR (15%)"
                                            />
                                        </LineChart>
                                    </ResponsiveContainer>

                                    {/* Yield Boost Indicator */}
                                    {chartData.length > 0 && (
                                        <Box position="absolute" top="20px" right="30px">
                                            <Text
                                                color="#3b82f6"
                                                fontSize="sm"
                                                fontWeight="bold"
                                                bg="#1f2937"
                                                px={2}
                                                py={1}
                                                borderRadius="md"
                                                border="1px solid #374151"
                                            >
                                                {(() => {
                                                    const lastPoint = chartData[chartData.length - 1];
                                                    const boost = ((lastPoint.boostedAmount - lastPoint.baseAmount) / lastPoint.baseAmount) * 100;
                                                    return `${boost.toFixed(0)}% Boost`;
                                                })()}
                                            </Text>
                                        </Box>
                                    )}
                                </Box>
                            </VStack>
                        </Box>
                    ) : (
                        <Box w="100%" h="300px" display="flex" alignItems="center" justifyContent="center">
                            <Text color="whiteAlpha.600" fontSize="md">
                                Enter an amount to see your 10-year compound growth projection
                            </Text>
                        </Box>
                    )}
                </VStack>
            </Box>

            {/* FAQ Section */}
            <FAQ />

            {/* Deploy button */}
            <Box w={"98%"} maxW={"420px"} mt={4}>
                <ConfirmModal
                    buttonProps={{ bg: '#10b981', _hover: { bg: '#059669' }, w: '100%', textShadow: '0 0 20px rgba(0, 0, 0, 1)' }}
                    label={"Deploy"}
                    isDisabled={amount === '0' || Number(managedActionState.collateralAmount) <= 0}
                    action={transformExposure}
                >
                    <TransformExposureSummary
                        mode={mode}
                        asset={selectedAsset ?? asset}
                        collateralAmount={managedActionState.collateralAmount}
                        multiplier={managedActionState.multiplier}
                        borrowAmount={borrowAmount}
                        collateralValue={collateralValue}
                        maxBorrowLTV={resolvedMaxBorrowLTV ?? 0}
                    />
                </ConfirmModal>
                {/* <Text color="gray.400" fontSize="xs" mt={2} alignSelf="flex-end">(liq price ${liqPrice})</Text> */}
            </Box>
        </VStack>
    );
};

export default Mycelium; 