import React, { ChangeEvent } from 'react'
import {
    Card,
    VStack,
    HStack,
    Text,
    Button,
    IconButton,
    Tooltip,
    Tabs,
    TabList,
    TabPanels,
    Tab,
    TabPanel,
} from '@chakra-ui/react'
import { InfoIcon } from '@chakra-ui/icons'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { Asset } from '@/helpers/chain'
import { BoostBreakdown } from './BoostBreakdown'
import { PositionSummary } from './PositionSummary'
import { DepositAmountInput } from './DepositAmountInput'
import { WithdrawAmountInput } from './WithdrawAmountInput'
import { AdjustLoopPanel } from './AdjustLoopPanel'
import { AdjustClosePanel } from './AdjustClosePanel'

interface AdjustPositionFormProps {
    // Position summary
    collateralAmount: number
    currentLoopLevel: number
    userAPR: number
    healthColor: string
    healthLabel: string
    currentLTV: number
    debtAmount: number
    // Tabs
    activeTab: number
    setActiveTab: (index: number) => void
    // Deposit tab
    usdcAsset: Asset | null
    usdcBalance: string
    depositAmount: string
    handleDepositAmountChange: (e: ChangeEvent<HTMLInputElement>) => void
    usdDepositValue: string
    maxDeposit: number
    handleMaxDepositClick: () => void
    isValidDeposit: boolean
    handleDepositSubmit: () => void
    // Withdraw tab
    withdrawAmount: string
    handleWithdrawAmountChange: (e: ChangeEvent<HTMLInputElement>) => void
    usdWithdrawValue: string
    currentEquity: number
    handleMaxWithdrawClick: () => void
    isValidWithdraw: boolean
    handleWithdrawSubmit: () => void
    // Loop tab
    boostMultiplier: number
    handleBoostInputChange: (e: ChangeEvent<HTMLInputElement>) => void
    handleBoostChange: (val: number) => void
    projectedAPR: number
    funnelFillRatio: number
    transmuterUSDCBalance: number
    requiredCapacity: number
    isValidLoop: boolean
    handleLoopSubmit: () => void
    // Close tab
    handleCloseSubmit: () => void
}

// Living Typeface tab styling: mono uppercase label, hairline underline,
// phosphor on the selected tab. Sharp corners, no glow.
const TAB_PROPS = {
    fontFamily: TYPOGRAPHY.fontMono,
    fontSize: TYPOGRAPHY.label,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.12em',
    borderRadius: 0,
    color: SEMANTIC_COLORS.textSecondary,
    transition: TRANSITIONS.colors,
    _selected: {
        color: SEMANTIC_COLORS.primary,
        borderColor: SEMANTIC_COLORS.primary,
    },
    _hover: HOVER_EFFECTS.brighten,
    _focus: FOCUS_STYLES.ring,
}

export const AdjustPositionForm: React.FC<AdjustPositionFormProps> = ({
    collateralAmount,
    currentLoopLevel,
    userAPR,
    healthColor,
    healthLabel,
    currentLTV,
    debtAmount,
    activeTab,
    setActiveTab,
    usdcAsset,
    usdcBalance,
    depositAmount,
    handleDepositAmountChange,
    usdDepositValue,
    maxDeposit,
    handleMaxDepositClick,
    isValidDeposit,
    handleDepositSubmit,
    withdrawAmount,
    handleWithdrawAmountChange,
    usdWithdrawValue,
    currentEquity,
    handleMaxWithdrawClick,
    isValidWithdraw,
    handleWithdrawSubmit,
    boostMultiplier,
    handleBoostInputChange,
    handleBoostChange,
    projectedAPR,
    funnelFillRatio,
    transmuterUSDCBalance,
    requiredCapacity,
    isValidLoop,
    handleLoopSubmit,
    handleCloseSubmit,
}) => {
    return (
        <Card
            borderRadius={0}
            p={SPACING_PATTERNS.modalPadding}
            w="100%"
        >
            <VStack spacing={SPACING.lg} align="stretch">
                {/* Header */}
                <HStack justify="space-between" align="center">
                    <HStack spacing={SPACING.sm}>
                        <Text
                            fontSize={TYPOGRAPHY.h4}
                            fontWeight={TYPOGRAPHY.bold}
                            color={SEMANTIC_COLORS.textPrimary}
                            fontFamily={TYPOGRAPHY.fontMono}
                            textTransform="uppercase"
                            letterSpacing="0.12em"
                        >
                            Adjust Position
                        </Text>
                        <Tooltip
                            label="Manage your USDC looping position. Deposit, withdraw, adjust loop level, or close your position."
                            hasArrow
                        >
                            <IconButton
                                aria-label="Position Info"
                                icon={<InfoIcon />}
                                size="xs"
                                variant="ghost"
                                color={SEMANTIC_COLORS.textSecondary}
                                transition={TRANSITIONS.colors}
                                _hover={HOVER_EFFECTS.brighten}
                                _active={ACTIVE_EFFECTS.dim}
                                _focus={FOCUS_STYLES.ring}
                            />
                        </Tooltip>
                    </HStack>
                    <BoostBreakdown />
                </HStack>

                {/* Position Summary */}
                <PositionSummary
                    collateralAmount={collateralAmount}
                    currentLoopLevel={currentLoopLevel}
                    userAPR={userAPR}
                    healthColor={healthColor}
                    healthLabel={healthLabel}
                    currentLTV={currentLTV}
                />

                {/* Tabs for Actions */}
                <Tabs index={activeTab} onChange={setActiveTab}>
                    <TabList borderColor={SEMANTIC_COLORS.borderSubtle}>
                        <Tab {...TAB_PROPS}>Deposit</Tab>
                        <Tab {...TAB_PROPS}>Withdraw</Tab>
                        <Tab {...TAB_PROPS}>Loop</Tab>
                        <Tab {...TAB_PROPS}>Close</Tab>
                    </TabList>

                    <TabPanels>
                        {/* Deposit Tab */}
                        <TabPanel px={0} pt={SPACING.lg}>
                            <VStack spacing={SPACING.lg} align="stretch">
                                <DepositAmountInput
                                    depositAmount={depositAmount}
                                    handleDepositAmountChange={handleDepositAmountChange}
                                    usdDepositValue={usdDepositValue}
                                    maxDeposit={maxDeposit}
                                    usdcAsset={usdcAsset}
                                    usdcBalance={usdcBalance}
                                    handleMaxDepositClick={handleMaxDepositClick}
                                />
                                <Button
                                    size="lg"
                                    isDisabled={!isValidDeposit}
                                    onClick={handleDepositSubmit}
                                    transition={TRANSITIONS.colors}
                                    _active={ACTIVE_EFFECTS.dim}
                                    _focus={FOCUS_STYLES.ring}
                                >
                                    Deposit
                                </Button>
                            </VStack>
                        </TabPanel>

                        {/* Withdraw Tab */}
                        <TabPanel px={0} pt={SPACING.lg}>
                            <VStack spacing={SPACING.lg} align="stretch">
                                <WithdrawAmountInput
                                    withdrawAmount={withdrawAmount}
                                    handleWithdrawAmountChange={handleWithdrawAmountChange}
                                    usdWithdrawValue={usdWithdrawValue}
                                    currentEquity={currentEquity}
                                    usdcAsset={usdcAsset}
                                    handleMaxWithdrawClick={handleMaxWithdrawClick}
                                />
                                <Button
                                    size="lg"
                                    isDisabled={!isValidWithdraw}
                                    onClick={handleWithdrawSubmit}
                                    transition={TRANSITIONS.colors}
                                    _active={ACTIVE_EFFECTS.dim}
                                    _focus={FOCUS_STYLES.ring}
                                >
                                    Withdraw
                                </Button>
                            </VStack>
                        </TabPanel>

                        {/* Loop Tab */}
                        <TabPanel px={0} pt={SPACING.lg}>
                            <AdjustLoopPanel
                                currentLoopLevel={currentLoopLevel}
                                boostMultiplier={boostMultiplier}
                                handleBoostInputChange={handleBoostInputChange}
                                handleBoostChange={handleBoostChange}
                                userAPR={userAPR}
                                projectedAPR={projectedAPR}
                                funnelFillRatio={funnelFillRatio}
                                transmuterUSDCBalance={transmuterUSDCBalance}
                                requiredCapacity={requiredCapacity}
                                isValidLoop={isValidLoop}
                                handleLoopSubmit={handleLoopSubmit}
                            />
                        </TabPanel>

                        {/* Close Tab */}
                        <TabPanel px={0} pt={SPACING.lg}>
                            <AdjustClosePanel
                                collateralAmount={collateralAmount}
                                debtAmount={debtAmount}
                                currentEquity={currentEquity}
                                handleCloseSubmit={handleCloseSubmit}
                            />
                        </TabPanel>
                    </TabPanels>
                </Tabs>
            </VStack>
        </Card>
    )
}
