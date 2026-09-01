import React, { useState } from 'react';
import { Box, Text, HStack, VStack, Input, Slider, SliderTrack, SliderFilledTrack, SliderThumb, SliderMark, Image, Card } from '@chakra-ui/react';
import { num } from '@/helpers/num';
import { Formatter } from '@/helpers/formatter';
import ConfirmModal from '@/components/ConfirmModal/ConfirmModal';
import ManagedMarketSummary from '@/components/ManagedMarkets/ManagedMarketSummary';
import type { ManagedMarketActionData } from './hooks/useManagedMarketActionData';
import { SEMANTIC_COLORS } from '@/config/semanticColors';
import { TYPOGRAPHY } from '@/helpers/typography';
import { SPACING } from '@/config/spacing';
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions';

// Numbers stay machine-readable: mono + tabular figures.
const NUMERIC = {
    fontFamily: TYPOGRAPHY.fontMono,
    fontWeight: TYPOGRAPHY.medium,
    color: SEMANTIC_COLORS.textPrimary,
    sx: { fontVariantNumeric: 'tabular-nums' as const },
};

const ROW_LABEL = {
    fontFamily: TYPOGRAPHY.fontMono,
    fontSize: TYPOGRAPHY.small,
    color: SEMANTIC_COLORS.textSecondary,
};

// Presentational sections extracted from ManagedMarketAction. Each renders a
// slice of the original Multiply-tab render tree byte-identically; all data,
// handlers and derived calculations arrive as explicit props from
// useManagedMarketActionData so behavior is preserved verbatim.

type CollateralInputProps = {
    collateralAsset: ManagedMarketActionData['collateralAsset'];
    collateralPrice: ManagedMarketActionData['collateralPrice'];
    managedActionState: ManagedMarketActionData['managedActionState'];
    handleCollateralAmountChange: ManagedMarketActionData['handleCollateralAmountChange'];
    maxBalance: ManagedMarketActionData['maxBalance'];
    setManagedActionState: ManagedMarketActionData['setManagedActionState'];
};

const CollateralInput = ({
    collateralAsset,
    collateralPrice,
    managedActionState,
    handleCollateralAmountChange,
    maxBalance,
    setManagedActionState,
}: CollateralInputProps) => {
    return (
        <Box
            w="100%"
            bg={SEMANTIC_COLORS.bgTertiary}
            borderRadius={0}
            border="1px solid"
            borderColor={SEMANTIC_COLORS.borderSubtle}
            p={SPACING.base}
        >
            <HStack justify="space-between" align="flex-start" w="100%">
                <VStack align="flex-start" spacing={SPACING.xs} flex={1}>
                    <Text
                        color={SEMANTIC_COLORS.textSecondary}
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontSize={TYPOGRAPHY.label}
                        textTransform="uppercase"
                        letterSpacing="0.28em"
                    >
                        Margin collateral
                    </Text>
                    <Input
                        variant="unstyled"
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontSize={TYPOGRAPHY.h1}
                        fontWeight={TYPOGRAPHY.medium}
                        color={SEMANTIC_COLORS.textPrimary}
                        sx={{ fontVariantNumeric: 'tabular-nums' }}
                        value={managedActionState.collateralAmount}
                        onChange={handleCollateralAmountChange}
                        type="number"
                        min={0}
                        max={maxBalance}
                        placeholder="0"
                        w="100%"
                        borderRadius={0}
                        transition={TRANSITIONS.colors}
                        _placeholder={{ color: SEMANTIC_COLORS.textTertiary }}
                        _focus={FOCUS_STYLES.ring}
                        paddingInlineEnd={"3"}
                    />
                    <Text
                        color={SEMANTIC_COLORS.textSecondary}
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontSize={TYPOGRAPHY.small}
                        sx={{ fontVariantNumeric: 'tabular-nums' }}
                    >
                        ~ ${collateralPrice ? num(collateralPrice).times(managedActionState.collateralAmount || 0).toFixed(2) : "0.00"}
                    </Text>
                </VStack>
                <VStack align="flex-end" spacing={SPACING.sm}>
                    <HStack
                        bg={SEMANTIC_COLORS.bgSecondary}
                        border="1px solid"
                        borderColor={SEMANTIC_COLORS.borderSubtle}
                        borderRadius={0}
                        px={SPACING.md}
                        py={SPACING.xs}
                        spacing={SPACING.sm}
                    >
                        <Image src={collateralAsset?.logo} alt={collateralAsset?.symbol} boxSize="24px" />
                        <Text
                            color={SEMANTIC_COLORS.textPrimary}
                            fontFamily={TYPOGRAPHY.fontMono}
                            fontWeight={TYPOGRAPHY.medium}
                        >
                            {collateralAsset?.symbol}
                        </Text>
                    </HStack>
                    <VStack
                        as="button"
                        type="button"
                        aria-label="Use max wallet balance"
                        cursor="pointer"
                        borderRadius={0}
                        transition={TRANSITIONS.colors}
                        onClick={() => setManagedActionState({ collateralAmount: maxBalance.toString() })}
                        _focus={FOCUS_STYLES.ring}
                        _focusVisible={FOCUS_STYLES.ring}
                        sx={{
                            '&:hover > .wallet-hover-text': {
                                textDecoration: 'underline',
                                color: SEMANTIC_COLORS.primary,
                            },
                        }}
                    >
                        <Text
                            className="wallet-hover-text"
                            color={SEMANTIC_COLORS.textSecondary}
                            fontFamily={TYPOGRAPHY.fontMono}
                            fontSize={TYPOGRAPHY.small}
                            transition={TRANSITIONS.colors}
                        >
                            Wallet
                        </Text>
                        <Text
                            className="wallet-hover-text"
                            color={SEMANTIC_COLORS.textSecondary}
                            fontFamily={TYPOGRAPHY.fontMono}
                            fontSize={TYPOGRAPHY.small}
                            transition={TRANSITIONS.colors}
                            sx={{ fontVariantNumeric: 'tabular-nums' }}
                        >
                            {Formatter.toNearestNonZero(maxBalance)}
                        </Text>
                    </VStack>
                </VStack>
            </HStack>
        </Box>
    );
};

type MultiplierSliderProps = {
    managedActionState: ManagedMarketActionData['managedActionState'];
    handleMultiplierInput: ManagedMarketActionData['handleMultiplierInput'];
    maxMultiplier: ManagedMarketActionData['maxMultiplier'];
    stickyPoints: ManagedMarketActionData['stickyPoints'];
    handleSliderChange: ManagedMarketActionData['handleSliderChange'];
};

const MultiplierSlider = ({
    managedActionState,
    handleMultiplierInput,
    maxMultiplier,
    stickyPoints,
    handleSliderChange,
}: MultiplierSliderProps) => {
    return (
        <Box px={SPACING.sm} w="100%">
            <HStack mb={SPACING.sm} justify={{ base: "center", md: "flex-end" }}>
                <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.label}
                    textTransform="uppercase"
                    letterSpacing="0.28em"
                    color={SEMANTIC_COLORS.textSecondary}
                >
                    Multiplier:
                </Text>
                <Input
                    value={managedActionState.multiplier.toFixed(2)}
                    onChange={handleMultiplierInput}
                    type="number"
                    min={1}
                    max={maxMultiplier}
                    step={0.01}
                    w={`${Math.max(managedActionState.multiplier.toFixed(2).length + 1, 5)}ch`}
                    bg={SEMANTIC_COLORS.bgTertiary}
                    color={SEMANTIC_COLORS.textPrimary}
                    fontFamily={TYPOGRAPHY.fontMono}
                    sx={{ fontVariantNumeric: 'tabular-nums' }}
                    borderRadius={0}
                    border="1px solid"
                    borderColor={SEMANTIC_COLORS.borderSubtle}
                    transition={TRANSITIONS.colors}
                    _hover={HOVER_EFFECTS.borderHighlight}
                    _focus={FOCUS_STYLES.ring}
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
            >
                {stickyPoints.map((pt) => (
                    <SliderMark
                        key={pt}
                        value={pt}
                        mt="2"
                        ml="-1.5"
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontSize={TYPOGRAPHY.xs}
                        color={SEMANTIC_COLORS.textSecondary}
                        sx={{ fontVariantNumeric: 'tabular-nums' }}
                    >
                        {pt.toFixed(2)}x
                    </SliderMark>
                ))}
                <SliderTrack bg={SEMANTIC_COLORS.bgTertiary} borderRadius={0}>
                    <SliderFilledTrack bg={SEMANTIC_COLORS.primary} />
                </SliderTrack>
                <SliderThumb boxSize={6} borderRadius={0} bg={SEMANTIC_COLORS.textPrimary} _focus={FOCUS_STYLES.ring} />
            </Slider>
        </Box>
    );
};

type TakeProfitStopLossProps = {
    managedActionState: ManagedMarketActionData['managedActionState'];
    handleTakeProfitChange: ManagedMarketActionData['handleTakeProfitChange'];
    handleStopLossChange: ManagedMarketActionData['handleStopLossChange'];
};

const TakeProfitStopLoss = ({
    managedActionState,
    handleTakeProfitChange,
    handleStopLossChange,
}: TakeProfitStopLossProps) => {
    // Local UI toggles (used exclusively within this section)
    const [showTakeProfit, setShowTakeProfit] = useState(false);
    const [showStopLoss, setShowStopLoss] = useState(false);

    // These toggles are <Text> nodes, not Buttons, so they need explicit button
    // semantics + keyboard activation on top of the visual focus ring.
    const toggleProps = (isOpen: boolean, toggle: () => void) => ({
        as: 'button' as const,
        type: 'button' as const,
        role: 'button',
        tabIndex: 0,
        'aria-pressed': isOpen,
        cursor: 'pointer',
        onClick: toggle,
        onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            toggle();
        },
        fontFamily: TYPOGRAPHY.fontMono,
        fontSize: TYPOGRAPHY.small,
        color: SEMANTIC_COLORS.textSecondary,
        textAlign: 'center' as const,
        bg: SEMANTIC_COLORS.bgTertiary,
        py: SPACING.sm,
        borderRadius: 0,
        border: '1px solid',
        borderColor: SEMANTIC_COLORS.borderSubtle,
        transition: TRANSITIONS.colors,
        _hover: HOVER_EFFECTS.brighten,
        _active: ACTIVE_EFFECTS.dim,
        _focus: FOCUS_STYLES.ring,
        _focusVisible: FOCUS_STYLES.ring,
    });

    const priceInputProps = {
        type: 'text' as const,
        bg: SEMANTIC_COLORS.bgTertiary,
        color: SEMANTIC_COLORS.textPrimary,
        fontFamily: TYPOGRAPHY.fontMono,
        sx: { fontVariantNumeric: 'tabular-nums' as const },
        borderRadius: 0,
        border: '1px solid',
        borderColor: SEMANTIC_COLORS.borderSubtle,
        transition: TRANSITIONS.colors,
        _hover: HOVER_EFFECTS.borderHighlight,
        _focus: FOCUS_STYLES.ring,
        textAlign: 'right' as const,
        paddingInlineEnd: '2',
        paddingInlineStart: '2',
        minWidth: '60px',
        w: '100%',
    };

    return (
        <VStack spacing={SPACING.base} w="100%" align="stretch">
            {showTakeProfit || showStopLoss ? (
                <VStack spacing={SPACING.base} w="100%" align="stretch">
                    <HStack w="100%" justify="space-between">
                        <Text
                            minW="120px"
                            flex={1}
                            {...toggleProps(showTakeProfit, () => setShowTakeProfit(!showTakeProfit))}
                        >
                            {showTakeProfit ? 'Take Profit Price:' : 'Set a TP'}
                        </Text>
                        {showTakeProfit && (
                            <Input
                                value={managedActionState.takeProfit}
                                onChange={handleTakeProfitChange}
                                aria-label="Take profit price"
                                {...priceInputProps}
                            />
                        )}
                    </HStack>
                    <HStack w="100%" justify="space-between">
                        <Text
                            minW="120px"
                            flex={1}
                            {...toggleProps(showStopLoss, () => setShowStopLoss(!showStopLoss))}
                        >
                            {showStopLoss ? 'Stop Loss Price:' : 'Set a SL'}
                        </Text>
                        {showStopLoss && (
                            <Input
                                value={managedActionState.stopLoss}
                                onChange={handleStopLossChange}
                                aria-label="Stop loss price"
                                {...priceInputProps}
                            />
                        )}
                    </HStack>
                </VStack>
            ) : (
                <HStack w="100%" justify="space-between" spacing={SPACING.base}>
                    <Text
                        flex={1}
                        {...toggleProps(showTakeProfit, () => setShowTakeProfit(!showTakeProfit))}
                    >
                        Set a TP
                    </Text>
                    <Text
                        flex={1}
                        {...toggleProps(showStopLoss, () => setShowStopLoss(!showStopLoss))}
                    >
                        Set a SL
                    </Text>
                </HStack>
            )}
        </VStack>
    );
};

type PositionInfoCardProps = {
    managedActionState: ManagedMarketActionData['managedActionState'];
    collateralAsset: ManagedMarketActionData['collateralAsset'];
    collateralValue: ManagedMarketActionData['collateralValue'];
    debtPrice: ManagedMarketActionData['debtPrice'];
    collateralPrice: ManagedMarketActionData['collateralPrice'];
    liquidationPrice: ManagedMarketActionData['liquidationPrice'];
    ltv: ManagedMarketActionData['ltv'];
    health: ManagedMarketActionData['health'];
};

const PositionInfoCard = ({
    managedActionState,
    collateralAsset,
    collateralValue,
    debtPrice,
    collateralPrice,
    liquidationPrice,
    ltv,
    health,
}: PositionInfoCardProps) => {
    return (
        <Box
            w="100%"
            bg={SEMANTIC_COLORS.bgTertiary}
            borderRadius={0}
            border="1px solid"
            borderColor={SEMANTIC_COLORS.borderSubtle}
            p={SPACING.lg}
            mt={SPACING.none}
            mb={SPACING.sm}
        >
            <VStack align="stretch" spacing={SPACING.sm}>
                <HStack justify="space-between">
                    <Text {...ROW_LABEL}>Multiplier</Text>
                    <Text {...NUMERIC}>{managedActionState.multiplier.toFixed(2)}x</Text>
                </HStack>
                <HStack justify="space-between">
                    <Text {...ROW_LABEL}>Collateral Amount</Text>
                    <Text {...NUMERIC}>{managedActionState.collateralAmount || 0} {collateralAsset?.symbol}</Text>
                </HStack>

                <HStack justify="space-between">
                    <Text {...ROW_LABEL}>Collateral Value</Text>
                    <Text {...NUMERIC}>
                        {collateralValue ? `$${Formatter.priceDynamicDecimals(num(collateralValue).toNumber(), 6)}` : '-'}
                    </Text>
                </HStack>

                <HStack justify="space-between">
                    <Text {...ROW_LABEL}>Debt</Text>
                    <Text {...NUMERIC}>
                        {collateralValue && managedActionState.multiplier && debtPrice ? `$${num(collateralValue).times(managedActionState.multiplier - 1).div(debtPrice).toFixed(2)}` : '-'}
                    </Text>
                </HStack>

                <HStack justify="space-between">
                    <Text {...ROW_LABEL}>Current Price</Text>
                    <Text {...NUMERIC}>{collateralPrice ? `$${Formatter.priceDynamicDecimals(num(collateralPrice).toNumber(), 6)}` : '-'}</Text>
                </HStack>
                <HStack justify="space-between">
                    <Text {...ROW_LABEL}>Liquidation Price</Text>
                    <Text {...NUMERIC} color={SEMANTIC_COLORS.danger}>
                        {liquidationPrice ? `$${Formatter.priceDynamicDecimals(num(liquidationPrice).toNumber(), 6)}` : '-'}
                    </Text>
                </HStack>

                <HStack justify="space-between">
                    <Text {...ROW_LABEL}>Your LTV</Text>
                    <Text {...NUMERIC}>
                        {ltv ? `${(ltv * 100).toFixed(2)}%` : '-'}
                    </Text>
                </HStack>
                <HStack justify="space-between">
                    <Text {...ROW_LABEL}>Your health</Text>
                    <Text {...NUMERIC}>
                        {health !== undefined && health !== null ? `${(health * 100).toFixed(0)}%` : '-'}
                    </Text>
                </HStack>
                <HStack justify="space-between">
                    <Text {...ROW_LABEL}>Your Take Profit</Text>
                    <Text {...NUMERIC}>{managedActionState.takeProfit ? `$${managedActionState.takeProfit}` : '-'}</Text>
                </HStack>
                <HStack justify="space-between">
                    <Text {...ROW_LABEL}>Your Stop Loss</Text>
                    <Text {...NUMERIC}>{managedActionState.stopLoss ? `$${managedActionState.stopLoss}` : '-'}</Text>
                </HStack>
                <HStack justify="space-between">
                    <Text {...ROW_LABEL}>Slippage tolerance</Text>
                    <Text {...NUMERIC}>0.1%</Text>
                </HStack>
            </VStack>
        </Box>
    );
};

// Full Multiply-tab card: assembles the input sections, info card and deploy
// button. Receives the whole hook payload and threads explicit props to leaves.
const MultiplyPanel = ({ data }: { data: ManagedMarketActionData }) => {
    const {
        collateralAsset,
        collateralPrice,
        debtPrice,
        managedActionState,
        setManagedActionState,
        maxBalance,
        maxMultiplier,
        stickyPoints,
        selectedTab,
        actionLabels,
        handleSliderChange,
        handleMultiplierInput,
        handleTakeProfitChange,
        handleStopLossChange,
        handleCollateralAmountChange,
        borrowAndBoost,
        debtAmount,
        collateralValue,
        ltv,
        liquidationPrice,
        health,
    } = data;

    return (
        <Card
            borderRadius={0}
            border="1px solid"
            borderColor={SEMANTIC_COLORS.borderSubtle}
            bg={SEMANTIC_COLORS.bgSecondary}
            p={{ base: SPACING.base, md: SPACING.xl }}
            h="fit-content"
            // maxH="98vh"
            w={{ base: "100%", md: "40vw" }}
            maxW="600px"
            m="0 auto"
            overflowY="auto"
            sx={{
                /* Custom scrollbar */
                '&::-webkit-scrollbar': {
                    width: '8px',
                },
                '&::-webkit-scrollbar-thumb': {
                    background: SEMANTIC_COLORS.borderStrong,
                    borderRadius: 0,
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
            <VStack spacing={SPACING.xl} align="stretch" w="100%" maxW="600px" mx="auto">
                {/* Top: Action, Asset, Manager */}
                {/* Removed the HStack with the title row */}

                {/* Collateral input */}
                <CollateralInput
                    collateralAsset={collateralAsset}
                    collateralPrice={collateralPrice}
                    managedActionState={managedActionState}
                    handleCollateralAmountChange={handleCollateralAmountChange}
                    maxBalance={maxBalance}
                    setManagedActionState={setManagedActionState}
                />
                {/* Multiplier input and slider - moved here */}
                <MultiplierSlider
                    managedActionState={managedActionState}
                    handleMultiplierInput={handleMultiplierInput}
                    maxMultiplier={maxMultiplier}
                    stickyPoints={stickyPoints}
                    handleSliderChange={handleSliderChange}
                />
                {/* Take Profit / Stop Loss Inputs - full width below multiplier */}
                <TakeProfitStopLoss
                    managedActionState={managedActionState}
                    handleTakeProfitChange={handleTakeProfitChange}
                    handleStopLossChange={handleStopLossChange}
                />
                {/* Input components end */}
                {/* Info Card mirroring the image - moved above Deploy button */}
                <PositionInfoCard
                    managedActionState={managedActionState}
                    collateralAsset={collateralAsset}
                    collateralValue={collateralValue}
                    debtPrice={debtPrice}
                    collateralPrice={collateralPrice}
                    liquidationPrice={liquidationPrice}
                    ltv={ltv}
                    health={health}
                />
                {/* Deploy button at the bottom */}
                <ConfirmModal
                    label={actionLabels[selectedTab].toUpperCase()}
                    action={borrowAndBoost}
                    isDisabled={!managedActionState.collateralAmount || !managedActionState.multiplier || Number(managedActionState.collateralAmount) <= 0 || managedActionState.multiplier < 1.01}
                >
                    <ManagedMarketSummary managedActionState={managedActionState} borrowAndBoost={borrowAndBoost} collateralAsset={collateralAsset} debtAmount={debtAmount} collateralPrice={collateralPrice as string} debtPrice={debtPrice as string} />
                </ConfirmModal>
            </VStack>
        </Card>
    );
};

// Placeholder Strategize tab card.
const StrategizePanel = ({ collateralAsset }: { collateralAsset: ManagedMarketActionData['collateralAsset'] }) => {
    return (
        <Card
            borderRadius={0}
            border="1px solid"
            borderColor={SEMANTIC_COLORS.borderSubtle}
            bg={SEMANTIC_COLORS.bgSecondary}
            p={{ base: SPACING.base, md: SPACING.xl }}
            h="fit-content"
            w="vwvw"
            maxW="600px"
            m="0 auto"
            overflowY="auto"
            display="flex"
            flexDirection="column"
            alignItems="center"
        >
            <Text
                fontFamily={TYPOGRAPHY.fontDisplay}
                fontSize={TYPOGRAPHY.h2}
                color={SEMANTIC_COLORS.textPrimary}
            >
                Strategize {collateralAsset?.symbol ? collateralAsset.symbol : ''}
            </Text>
            <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.small}
                color={SEMANTIC_COLORS.textSecondary}
                mt={SPACING.base}
            >
                Not available yet.
            </Text>
        </Card>
    );
};

export { MultiplyPanel, StrategizePanel };
