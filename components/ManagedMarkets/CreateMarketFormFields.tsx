import React from 'react';
import {
    Box,
    HStack,
    Input,
    FormControl,
    FormLabel,
    Slider,
    SliderTrack,
    SliderFilledTrack,
    SliderThumb,
    SliderMark,
    SimpleGrid,
} from '@chakra-ui/react';
import { OracleRow } from './ManagedMarketInfo';
import type { useCreateMarketForm } from './hooks/useCreateMarketForm';
import { SEMANTIC_COLORS } from '@/config/semanticColors';
import { TYPOGRAPHY } from '@/helpers/typography';
import { SPACING } from '@/config/spacing';
import { TRANSITIONS, HOVER_EFFECTS, FOCUS_STYLES } from '@/config/transitions';

interface CreateMarketFormFieldsProps {
    form: ReturnType<typeof useCreateMarketForm>;
}

const FIELD_LABEL = {
    fontFamily: TYPOGRAPHY.fontMono,
    fontSize: TYPOGRAPHY.label,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.28em',
    color: SEMANTIC_COLORS.textSecondary,
};

const FIELD_INPUT = {
    fontFamily: TYPOGRAPHY.fontMono,
    bg: SEMANTIC_COLORS.bgTertiary,
    color: SEMANTIC_COLORS.textPrimary,
    borderRadius: 0,
    border: '1px solid',
    borderColor: SEMANTIC_COLORS.borderSubtle,
    transition: TRANSITIONS.colors,
    sx: { fontVariantNumeric: 'tabular-nums' as const },
    _placeholder: { color: SEMANTIC_COLORS.textTertiary },
    _hover: HOVER_EFFECTS.borderHighlight,
    _focus: FOCUS_STYLES.ring,
};

const SLIDER_MARK = {
    fontFamily: TYPOGRAPHY.fontMono,
    fontSize: TYPOGRAPHY.xs,
    color: SEMANTIC_COLORS.textSecondary,
    sx: { fontVariantNumeric: 'tabular-nums' as const },
};

const CreateMarketFormFields = ({ form }: CreateMarketFormFieldsProps) => {
    const {
        createMarketState,
        setCreateMarketState,
        osmosisPoolIdInput,
        setOsmosisPoolIdInput,
        oracles,
        slippageStickyPoints,
        handleSlippageChange,
    } = form;

    return (
        <SimpleGrid columns={{ base: 1, md: 2 }} spacing={SPACING.lg}>
            <FormControl>
                <FormLabel {...FIELD_LABEL}>Collateral Asset</FormLabel>
                <Input
                    placeholder="Asset Symbol (ex: BTC)"
                    value={createMarketState.collateralAsset}
                    onChange={e => setCreateMarketState(s => ({ ...s, collateralAsset: e.target.value }))}
                    {...FIELD_INPUT}
                />
            </FormControl>
            <FormControl>
                <FormLabel {...FIELD_LABEL}>Max Borrow LTV (%)</FormLabel>
                <Input
                    type="number"
                    placeholder="0.67"
                    value={createMarketState.maxBorrowLTV}
                    onChange={e => setCreateMarketState(s => ({ ...s, maxBorrowLTV: e.target.value }))}
                    {...FIELD_INPUT}
                />
            </FormControl>
            <FormControl>
                <FormLabel {...FIELD_LABEL}>Liquidation LTV (%)</FormLabel>
                <Input
                    type="number"
                    placeholder="0.8"
                    value={createMarketState.liquidationLTV}
                    onChange={e => setCreateMarketState(s => ({ ...s, liquidationLTV: e.target.value }))}
                    {...FIELD_INPUT}
                />
            </FormControl>
            <FormControl>
                <FormLabel {...FIELD_LABEL}>Borrow Fee (%)</FormLabel>
                <Input
                    type="number"
                    placeholder="0.01"
                    value={createMarketState.borrowFee}
                    onChange={e => setCreateMarketState(s => ({ ...s, borrowFee: e.target.value }))}
                    {...FIELD_INPUT}
                />
            </FormControl>
            <FormControl>
                {/* <FormLabel>Osmosis Pool ID</FormLabel> */}
                <HStack spacing={SPACING.xs} align="center">
                    <FormLabel
                        as="a"
                        href="https://app.osmosis.zone/pools"
                        target="_blank"
                        rel="noopener noreferrer"
                        {...FIELD_LABEL}
                        cursor="pointer"
                        mb={0}
                        transition={TRANSITIONS.colors}
                        _hover={{ textDecoration: 'underline', color: SEMANTIC_COLORS.primary }}
                        _focus={FOCUS_STYLES.ring}
                    >
                        Osmosis Pool ID for Collateral Asset
                    </FormLabel>
                    {/* <Tooltip
                        label="Osmosis Pool ID for a pool with the collateral asset"
                        hasArrow
                        portal
                    >
                        <Box as="span" display="inline-flex" cursor="pointer" tabIndex={0}>
                            <Icon as={InfoOutlineIcon} color="whiteAlpha.600" boxSize={4} />
                        </Box>
                    </Tooltip> */}
                </HStack>
                <Input
                    placeholder="1234"
                    value={osmosisPoolIdInput}
                    onChange={e => setOsmosisPoolIdInput(e.target.value)}
                    {...FIELD_INPUT}
                />
                {/* Oracle Pools Visual */}
                {oracles.length > 0 && (
                    <Box mt={SPACING.sm} mb={SPACING.sm}>
                        <OracleRow oracles={oracles} />
                    </Box>
                )}
            </FormControl>
            <FormControl>
                <FormLabel {...FIELD_LABEL}>Social Link</FormLabel>
                <Input
                    placeholder="https://..."
                    value={createMarketState.socialLinks}
                    onChange={e => setCreateMarketState(s => ({ ...s, socialLinks: e.target.value }))}
                    {...FIELD_INPUT}
                />
            </FormControl>
            <FormControl>
                <FormLabel {...FIELD_LABEL}>Manager Address</FormLabel>
                <Input
                    placeholder="osmo1..."
                    value={createMarketState.managerAddress}
                    onChange={e => setCreateMarketState(s => ({ ...s, managerAddress: e.target.value }))}
                    {...FIELD_INPUT}
                />
            </FormControl>
            <FormControl>
                <FormLabel {...FIELD_LABEL}>Total Debt Supply Cap (CDT)</FormLabel>
                <Input
                    type="number"
                    placeholder="1000000"
                    value={createMarketState.totalDebtSupplyCap}
                    onChange={e => setCreateMarketState(s => ({ ...s, totalDebtSupplyCap: e.target.value }))}
                    {...FIELD_INPUT}
                />
            </FormControl>
            <FormControl>
                <HStack align="center" mb={SPACING.sm}>
                    <FormLabel mb={0} {...FIELD_LABEL}>Max Slippage (%)</FormLabel>
                    <Input
                        type="number"
                        min={1}
                        max={25}
                        step={0.1}
                        value={createMarketState.maxSlippage}
                        onChange={e => handleSlippageChange(Number(e.target.value))}
                        w="100px"
                        textAlign="right"
                        {...FIELD_INPUT}
                    />
                </HStack>
                <Box px={SPACING.sm}>
                    <Slider
                        min={1}
                        max={25}
                        step={0.1}
                        value={createMarketState.maxSlippage}
                        onChange={handleSlippageChange}
                    >
                        {slippageStickyPoints.map((pt, i) => (
                            <SliderMark key={pt} value={pt} mt="2" ml={pt === 3 ? "1" : pt === 5 ? "0.5" : pt === 10 ? "0" : "0"} {...SLIDER_MARK}>
                                {pt}%
                            </SliderMark>
                        ))}
                        <SliderMark value={25} mt="2" ml="-6" {...SLIDER_MARK}>
                            25%
                        </SliderMark>
                        <SliderTrack bg={SEMANTIC_COLORS.bgTertiary} borderRadius={0}>
                            <SliderFilledTrack bg={SEMANTIC_COLORS.primary} />
                        </SliderTrack>
                        <SliderThumb boxSize={6} borderRadius={0} bg={SEMANTIC_COLORS.textPrimary} _focus={FOCUS_STYLES.ring} />
                    </Slider>
                </Box>
            </FormControl>
        </SimpleGrid>
    );
};

export default CreateMarketFormFields;
