import React from 'react';
import {
    Box,
    Text,
    Input,
    Button,
    VStack,
    Modal,
    ModalOverlay,
    ModalContent,
    ModalHeader,
    ModalCloseButton,
    ModalBody,
    ModalFooter,
    FormControl,
} from '@chakra-ui/react';
import ConfirmModal from '@/components/ConfirmModal/ConfirmModal';
import MarketCreateSummary from './MarketCreateSummary';
import CreateMarketFormFields from './CreateMarketFormFields';
import CreateMarketInterestRateSection from './CreateMarketInterestRateSection';
import type { useCreateMarketForm } from './hooks/useCreateMarketForm';
import { SEMANTIC_COLORS } from '@/config/semanticColors';
import { TYPOGRAPHY } from '@/helpers/typography';
import { SPACING, SPACING_PATTERNS } from '@/config/spacing';
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions';

interface CreateMarketModalProps {
    isOpen: boolean;
    onClose: () => void;
    form: ReturnType<typeof useCreateMarketForm>;
}

const CreateMarketModal = ({ isOpen, onClose, form }: CreateMarketModalProps) => {
    const {
        createMarketState,
        setCreateMarketState,
        isWhitelistedManager,
        cdtBalance,
        invalidPoolID,
        createMarket,
    } = form;

    return (
        <Modal isOpen={isOpen} onClose={onClose} size="6xl" isCentered>
            <ModalOverlay />
            <ModalContent
                bg={SEMANTIC_COLORS.bgSecondary}
                color={SEMANTIC_COLORS.textPrimary}
                borderRadius={0}
                border="1px solid"
                borderColor={SEMANTIC_COLORS.borderSubtle}
                maxW="900px"
            >
                <ModalHeader fontFamily={TYPOGRAPHY.fontDisplay} fontWeight={TYPOGRAPHY.medium}>Create New Market</ModalHeader>
                <ModalCloseButton borderRadius={0} _focus={FOCUS_STYLES.ring} />
                <ModalBody pb={SPACING_PATTERNS.modalPadding}>
                    <VStack spacing={SPACING.lg} align="stretch" w="100%">
                        {/* Centered Name Input */}
                        <Box w="100%" display="flex" justifyContent="center" alignItems="center">
                            <FormControl maxW="400px" w="100%">
                                <Input
                                    placeholder="Market Name (ex: My BTC Market)"
                                    value={createMarketState.name}
                                    onChange={e => setCreateMarketState(s => ({ ...s, name: e.target.value }))}
                                    size="lg"
                                    fontFamily={TYPOGRAPHY.fontMono}
                                    fontWeight={TYPOGRAPHY.medium}
                                    fontSize={TYPOGRAPHY.h3}
                                    textAlign="center"
                                    bg={SEMANTIC_COLORS.bgTertiary}
                                    color={SEMANTIC_COLORS.textPrimary}
                                    borderRadius={0}
                                    border="1px solid"
                                    borderColor={SEMANTIC_COLORS.borderSubtle}
                                    transition={TRANSITIONS.colors}
                                    _placeholder={{ color: SEMANTIC_COLORS.textTertiary }}
                                    _hover={HOVER_EFFECTS.borderHighlight}
                                    _focus={FOCUS_STYLES.ring}
                                    mb={SPACING.sm}
                                />
                            </FormControl>
                        </Box>
                        <CreateMarketFormFields form={form} />
                        {/* Interest Rate Model Section */}
                        <CreateMarketInterestRateSection form={form} />
                    </VStack>
                    {/* Non-whitelisted manager notice above footer */}
                    {!isWhitelistedManager && (
                        <Text
                            color={SEMANTIC_COLORS.warning}
                            fontFamily={TYPOGRAPHY.fontMono}
                            fontSize={TYPOGRAPHY.small}
                            fontWeight={TYPOGRAPHY.medium}
                            mt={SPACING.base}
                            justifySelf="center"
                        >
                            Non-whitelisted Managers pay 25 CDT that is supplied to the market
                        </Text>
                    )}
                </ModalBody>
                <ModalFooter pt={SPACING_PATTERNS.modalPadding} gap={SPACING_PATTERNS.buttonGroupGap}>
                    <Button
                        onClick={onClose}
                        variant="outline"
                        borderRadius={0}
                        transition={TRANSITIONS.colors}
                        _hover={HOVER_EFFECTS.borderHighlight}
                        _active={ACTIVE_EFFECTS.dim}
                        _focus={FOCUS_STYLES.ring}
                    >
                        Cancel
                    </Button>
                    <ConfirmModal
                        label={invalidPoolID ? "Invalid Pool ID" : !isWhitelistedManager && Number(cdtBalance) < 25 ? "Need 25 CDT to Create" : !isWhitelistedManager ? "Create Market (25 CDT)" : "Create"}
                        action={createMarket}
                        isDisabled={invalidPoolID || (!isWhitelistedManager && Number(cdtBalance) < 25)}
                    >
                        <MarketCreateSummary
                            collateralAsset={createMarketState.collateralAsset}
                            maxBorrowLTV={createMarketState.maxBorrowLTV}
                            liquidationLTV={createMarketState.liquidationLTV}
                            borrowFee={createMarketState.borrowFee}
                            managerAddress={createMarketState.managerAddress}
                            maxSlippage={createMarketState.maxSlippage}
                            totalDebtSupplyCap={createMarketState.totalDebtSupplyCap ?? "Uncapped"}
                            osmosisPoolId={createMarketState.osmosisPoolId}
                            baseRate={createMarketState.baseRate}
                            rateMax={createMarketState.rateMax}
                            postKinkRateMultiplier={createMarketState.postKinkRateMultiplier ?? ''}
                            kinkStartingPointRatio={createMarketState.kinkStartingPointRatio ?? ''}
                            enableKink={createMarketState.enableKink}
                            isWhitelistedManager={!!isWhitelistedManager}
                        />
                    </ConfirmModal>
                </ModalFooter>
            </ModalContent>
        </Modal>
    );
};

export default CreateMarketModal;
