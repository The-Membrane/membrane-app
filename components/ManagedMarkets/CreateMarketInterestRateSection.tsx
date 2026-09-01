import React from 'react';
import {
    Box,
    HStack,
    Text,
    Input,
    IconButton,
    Tooltip,
    FormControl,
    FormLabel,
    Switch,
    SimpleGrid,
} from '@chakra-ui/react';
import { RepeatIcon } from '@chakra-ui/icons';
import { InterestRateModel } from './ManagedMarketInfo';
import type { useCreateMarketForm } from './hooks/useCreateMarketForm';
import { SEMANTIC_COLORS } from '@/config/semanticColors';
import { TYPOGRAPHY } from '@/helpers/typography';
import { SPACING } from '@/config/spacing';
import { TRANSITIONS, HOVER_EFFECTS, FOCUS_STYLES } from '@/config/transitions';

const IR_INPUT = {
    fontFamily: TYPOGRAPHY.fontMono,
    bg: SEMANTIC_COLORS.bgSecondary,
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

const IR_LABEL = {
    fontFamily: TYPOGRAPHY.fontMono,
    fontSize: TYPOGRAPHY.label,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.28em',
    color: SEMANTIC_COLORS.textSecondary,
};

interface CreateMarketInterestRateSectionProps {
    form: ReturnType<typeof useCreateMarketForm>;
}

const CreateMarketInterestRateSection = ({ form }: CreateMarketInterestRateSectionProps) => {
    const {
        createMarketState,
        setCreateMarketState,
        interestRateModelProps,
        irModelDescription,
        handleResetIRParams,
    } = form;

    return (
        <Box
            bg={SEMANTIC_COLORS.bgTertiary}
            borderRadius={0}
            border="1px solid"
            borderColor={SEMANTIC_COLORS.borderSubtle}
            p={SPACING.base}
            mt={SPACING.sm}
        >
            <HStack mb={SPACING.sm} spacing={SPACING.sm} align="center">
                <Text
                    fontFamily={TYPOGRAPHY.fontDisplay}
                    fontSize={TYPOGRAPHY.h4}
                    color={SEMANTIC_COLORS.textPrimary}
                >
                    Interest Rate Model
                </Text>
                <Switch
                    isChecked={createMarketState.enableKink}
                    onChange={e => {
                        const enableKink = e.target.checked;
                        setCreateMarketState(s => ({
                            ...s,
                            enableKink,
                            postKinkRateMultiplier: enableKink ? (s.postKinkRateMultiplier ?? '') : undefined,
                            kinkStartingPointRatio: enableKink ? (s.kinkStartingPointRatio ?? '') : undefined,
                        }));
                    }}
                    colorScheme="phosphor"
                    size="md"
                    sx={{ '& .chakra-switch__track': { borderRadius: 0 }, '& .chakra-switch__thumb': { borderRadius: 0 } }}
                    _focus={FOCUS_STYLES.ring}
                />
                <Text {...IR_LABEL}>Enable Kink</Text>
                <Tooltip label="Reset IR Params">
                    <IconButton
                        aria-label="Reset IR Params"
                        icon={<RepeatIcon />}
                        size="xs"
                        variant="ghost"
                        onClick={handleResetIRParams}
                        ml={SPACING.xs}
                        minW={0}
                        width="auto"
                        borderRadius={0}
                        color={SEMANTIC_COLORS.textSecondary}
                        transition={TRANSITIONS.colors}
                        _hover={HOVER_EFFECTS.brighten}
                        _focus={FOCUS_STYLES.ring}
                    />
                </Tooltip>
            </HStack>
            {/* Visualization */}
            <Box w="100%" h="200px">
                <InterestRateModel {...interestRateModelProps} />
            </Box>
            <Box
                border="1px solid"
                borderColor={SEMANTIC_COLORS.borderStrong}
                borderRadius={0}
                p={SPACING.md}
                mb={SPACING.sm}
                mt={SPACING.sm}
                bg={SEMANTIC_COLORS.bgSecondary}
            >
                <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.small}
                    color={SEMANTIC_COLORS.textSecondary}
                >
                    {irModelDescription}
                </Text>
            </Box>
            {/* 2x2 grid for params */}
            <SimpleGrid columns={2} spacing={SPACING.base} mt={SPACING.base}>
                <FormControl>
                    <FormLabel {...IR_LABEL}>Base Rate (%)</FormLabel>
                    <Input
                        type="number"
                        placeholder="1"
                        value={createMarketState.baseRate}
                        onChange={e => {
                            if (!createMarketState.enableKink) {
                                setCreateMarketState(s => ({ ...s, rateMax: e.target.value, baseRate: e.target.value }))
                            } else {
                                setCreateMarketState(s => ({ ...s, baseRate: e.target.value }))
                            }
                        }}
                        {...IR_INPUT}
                    />
                </FormControl>
                <FormControl>
                    <FormLabel {...IR_LABEL}>Max Rate (%)</FormLabel>
                    <Input
                        type="number"
                        value={createMarketState.enableKink ? createMarketState.rateMax : createMarketState.baseRate}
                        onChange={e => setCreateMarketState(s => ({ ...s, rateMax: e.target.value }))}
                        disabled={!createMarketState.enableKink}
                        {...IR_INPUT}
                    />
                </FormControl>
                {createMarketState.enableKink && (
                    <FormControl>
                        <FormLabel {...IR_LABEL}>Post-Kink Rate Multiplier (ex: 1.00)</FormLabel>
                        <Input
                            type="number"
                            placeholder="1.5"
                            value={createMarketState.postKinkRateMultiplier ?? ''}
                            onChange={e => setCreateMarketState(s => ({ ...s, postKinkRateMultiplier: e.target.value }))}
                            {...IR_INPUT}
                        />
                    </FormControl>
                )}
                {createMarketState.enableKink && (
                    <FormControl>
                        <FormLabel {...IR_LABEL}>Kink Starting Point Ratio (%)</FormLabel>
                        <Input
                            type="number"
                            placeholder="80"
                            value={createMarketState.kinkStartingPointRatio ?? ''}
                            onChange={e => setCreateMarketState(s => ({ ...s, kinkStartingPointRatio: e.target.value }))}
                            {...IR_INPUT}
                        />
                    </FormControl>
                )}
            </SimpleGrid>
        </Box>
    );
};

export default CreateMarketInterestRateSection;
