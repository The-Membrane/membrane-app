import React from 'react';
import {
  Box,
  VStack,
  Text,
  HStack,
  Image,
  Input,
  RadioGroup,
  Radio,
  Icon,
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverHeader,
  PopoverBody,
  PopoverArrow,
} from '@chakra-ui/react';
import { InfoIcon } from '@chakra-ui/icons';
import { SEMANTIC_COLORS } from '@/config/semanticColors';
import ConfirmModal from '@/components/ConfirmModal/ConfirmModal';
import { useMarketActionEdit, MarketActionEditProps } from './hooks/useMarketActionEdit';

const DepositCollateralSection = ({ inputCollateralAmount, handleCollateral, userBalance, asset, handleMax }: { inputCollateralAmount: string, handleCollateral: (v: string) => void, userBalance: number, asset: any, handleMax: () => void }) => (
  <Box w="100%" bg={SEMANTIC_COLORS.bgTertiary} borderRadius={0} p={4}>
    <HStack justify="space-between" align="flex-start" w="100%">
      <VStack align="flex-start" spacing={1} flex={1}>
        <Text color={SEMANTIC_COLORS.textSecondary} fontSize="sm" fontWeight="medium">
          Deposit More Collateral
        </Text>
        <Input
          variant="unstyled"
          fontSize="2xl"
          fontWeight="bold"
          color={SEMANTIC_COLORS.textPrimary}
          value={inputCollateralAmount}
          onChange={e => handleCollateral(e.target.value)}
          type="number"
          min={0}
          max={userBalance}
          placeholder="0"
          w="100%"
          _placeholder={{ color: SEMANTIC_COLORS.textTertiary }}
          paddingInlineEnd={"3"}
        />
      </VStack>
      <VStack align="flex-end" spacing={2}>
        <HStack bg={SEMANTIC_COLORS.bgTertiary} borderRadius="full" px={3} py={1} spacing={2}>
          <Image src={asset?.logo} alt={asset?.symbol} boxSize="24px" />
          <Text color={SEMANTIC_COLORS.textPrimary} fontWeight="bold">{asset?.symbol}</Text>
        </HStack>
        <Text
          color="teal.300"
          fontSize="sm"
          fontWeight="bold"
          cursor="pointer"
          _hover={{ textDecoration: 'underline' }}
          onClick={handleMax}
        >
          Max
        </Text>
      </VStack>
    </HStack>
  </Box>
);

const TakeProfitStopLossSection = ({ inputTakeProfit, handleTP, inputStopLoss, handleSL }: { inputTakeProfit: string, handleTP: (v: string) => void, inputStopLoss: string, handleSL: (v: string) => void }) => (
  <HStack w="100%" spacing={4}>
    <VStack flex={1} align="start" spacing={1}>
      <HStack spacing={2}>
        <Text color={SEMANTIC_COLORS.textSecondary} fontSize="sm">Take Profit (TP)</Text>
        <Popover>
          <PopoverTrigger>
            <Icon as={InfoIcon} color={SEMANTIC_COLORS.textTertiary} boxSize={3} cursor="pointer" />
          </PopoverTrigger>
          <PopoverContent bg={SEMANTIC_COLORS.bgTertiary} color={SEMANTIC_COLORS.textPrimary}>
            <PopoverArrow />
            <PopoverHeader fontWeight="bold">Take Profit</PopoverHeader>
            <PopoverBody>
              Set a price target to automatically close your position when the collateral price reaches this level, locking in profits.
            </PopoverBody>
          </PopoverContent>
        </Popover>
      </HStack>
      <Input
        variant="filled"
        value={inputTakeProfit}
        onChange={e => handleTP(e.target.value)}
        placeholder="TP Price"
        color={SEMANTIC_COLORS.textPrimary}
        bg={SEMANTIC_COLORS.bgTertiary}
        _placeholder={{ color: SEMANTIC_COLORS.textTertiary }}
      />
    </VStack>
    <VStack flex={1} align="start" spacing={1}>
      <HStack spacing={2}>
        <Text color={SEMANTIC_COLORS.textSecondary} fontSize="sm">Stop Loss (SL)</Text>
        <Popover>
          <PopoverTrigger>
            <Icon as={InfoIcon} color={SEMANTIC_COLORS.textTertiary} boxSize={3} cursor="pointer" />
          </PopoverTrigger>
          <PopoverContent bg={SEMANTIC_COLORS.bgTertiary} color={SEMANTIC_COLORS.textPrimary}>
            <PopoverArrow />
            <PopoverHeader fontWeight="bold">Stop Loss</PopoverHeader>
            <PopoverBody>
              Set a price target to automatically close your position when the collateral price falls to this level, limiting potential losses.
            </PopoverBody>
          </PopoverContent>
        </Popover>
      </HStack>
      <Input
        variant="filled"
        value={inputStopLoss}
        onChange={e => handleSL(e.target.value)}
        placeholder="SL Price"
        color={SEMANTIC_COLORS.textPrimary}
        bg={SEMANTIC_COLORS.bgTertiary}
        _placeholder={{ color: SEMANTIC_COLORS.textTertiary }}
      />
    </VStack>
  </HStack>
);

const BorrowCDTSection = ({ inputBorrowAmount, handleBorrow }: { inputBorrowAmount: string, handleBorrow: (v: string) => void }) => (
  /* Borrow CDT Input */
  <VStack align="start" spacing={1} w="100%">
    <HStack spacing={2}>
      <Text color={SEMANTIC_COLORS.textSecondary} fontSize="sm">Borrow CDT</Text>
      <Popover>
        <PopoverTrigger>
          <Icon as={InfoIcon} color={SEMANTIC_COLORS.textTertiary} boxSize={3} cursor="pointer" />
        </PopoverTrigger>
        <PopoverContent bg={SEMANTIC_COLORS.bgTertiary} color={SEMANTIC_COLORS.textPrimary}>
          <PopoverArrow />
          <PopoverHeader fontWeight="bold">Borrow CDT</PopoverHeader>
          <PopoverBody>
            Borrow additional CDT against your collateral. This increases your debt and liquidation risk.
          </PopoverBody>
        </PopoverContent>
      </Popover>
    </HStack>
    <Input
      variant="filled"
      value={inputBorrowAmount}
      onChange={e => handleBorrow(e.target.value)}
      placeholder="0"
      type="number"
      min={0}
      color={SEMANTIC_COLORS.textPrimary}
      bg={SEMANTIC_COLORS.bgTertiary}
      _placeholder={{ color: SEMANTIC_COLORS.textTertiary }}
    />
  </VStack>
);

const RepayCDTSection = ({ inputRepayAmount, handleRepay }: { inputRepayAmount: string, handleRepay: (v: string) => void }) => (
  /* Repay CDT Input */
  <VStack align="start" spacing={1} w="100%">
    <HStack spacing={2}>
      <Text color={SEMANTIC_COLORS.textSecondary} fontSize="sm">Repay CDT</Text>
      <Popover>
        <PopoverTrigger>
          <Icon as={InfoIcon} color={SEMANTIC_COLORS.textTertiary} boxSize={3} cursor="pointer" />
        </PopoverTrigger>
        <PopoverContent bg={SEMANTIC_COLORS.bgTertiary} color={SEMANTIC_COLORS.textPrimary}>
          <PopoverArrow />
          <PopoverHeader fontWeight="bold">Repay CDT</PopoverHeader>
          <PopoverBody>
            Repay your debt by sending CDT to reduce your position&apos;s debt and lower liquidation risk.
          </PopoverBody>
        </PopoverContent>
      </Popover>
    </HStack>
    <Input
      variant="filled"
      value={inputRepayAmount}
      onChange={e => handleRepay(e.target.value)}
      placeholder="0"
      type="number"
      min={0}
      color={SEMANTIC_COLORS.textPrimary}
      bg={SEMANTIC_COLORS.bgTertiary}
      _placeholder={{ color: SEMANTIC_COLORS.textTertiary }}
    />
  </VStack>
);

const PriceInfoSection = ({ collateralPrice, dynamicLiquidationPrice }: { collateralPrice: number, dynamicLiquidationPrice: string }) => (
  /* Current Price & Liquidation Price Box */
  <Box w="100%" bg={SEMANTIC_COLORS.bgTertiary} borderRadius={0} p={3} mt={2} mb={2}>
    <VStack align="stretch" spacing={1}>
      <Text color={SEMANTIC_COLORS.textSecondary} fontSize="sm">Current Price: ${Number(collateralPrice).toFixed(4)}</Text>
      <Text color={SEMANTIC_COLORS.textSecondary} fontSize="sm">Liquidation Price: {dynamicLiquidationPrice !== '-' ? `$${dynamicLiquidationPrice}` : '-'}</Text>
    </VStack>
  </Box>
);

const MultiplierSection = ({ maxMultiplier, inputMultiplier, handleMultiplier, multiplierPlaceholder }: { maxMultiplier: number, inputMultiplier: string | number, handleMultiplier: (v: number) => void, multiplierPlaceholder: string }) => (
  /* Multiplier input with boundaries */
  <VStack align="start" spacing={1} w="100%">
    <HStack spacing={2}>
      <Text color={SEMANTIC_COLORS.textSecondary} fontSize="sm">Change Multiplier (max {maxMultiplier.toFixed(2)}x)</Text>
      <Popover>
        <PopoverTrigger>
          <Icon as={InfoIcon} color={SEMANTIC_COLORS.textTertiary} boxSize={3} cursor="pointer" />
        </PopoverTrigger>
        <PopoverContent bg={SEMANTIC_COLORS.bgTertiary} color={SEMANTIC_COLORS.textPrimary}>
          <PopoverArrow />
          <PopoverHeader fontWeight="bold">Change Multiplier</PopoverHeader>
          <PopoverBody>
            Adjust your position&apos;s leverage multiplier. Higher multipliers increase potential returns but also increase liquidation risk. The max multiplier is calculated using your available LTV space.
          </PopoverBody>
        </PopoverContent>
      </Popover>
    </HStack>
    <Input
      variant="filled"
      value={inputMultiplier}
      onChange={e => handleMultiplier(Number(e.target.value))}
      type="number"
      min={1}
      max={maxMultiplier}
      step={0.01}
      color={SEMANTIC_COLORS.textPrimary}
      bg={SEMANTIC_COLORS.bgTertiary}
      _placeholder={{ color: SEMANTIC_COLORS.textTertiary }}
      placeholder={multiplierPlaceholder}
    />
  </VStack>
);

const ClosePositionSection = ({ closeType, inputClosePercent, handleClosePercent, setInputClosePercent, setManagedActionState }: { closeType: string, inputClosePercent: string | number, handleClosePercent: (v: number) => void, setInputClosePercent: (v: string) => void, setManagedActionState: (v: any) => void }) => (
  /* Close Position Section with RadioGroup */
  <VStack align="start" spacing={1} w="100%">
    <HStack spacing={2}>
      <Text color={SEMANTIC_COLORS.textSecondary} fontSize="sm">Close Position</Text>
      <Popover>
        <PopoverTrigger>
          <Icon as={InfoIcon} color={SEMANTIC_COLORS.textTertiary} boxSize={3} cursor="pointer" />
        </PopoverTrigger>
        <PopoverContent bg={SEMANTIC_COLORS.bgTertiary} color={SEMANTIC_COLORS.textPrimary}>
          <PopoverArrow />
          <PopoverHeader fontWeight="bold">Close Position</PopoverHeader>
          <PopoverBody>
            Close part or all of your position. Partial close reduces your exposure while keeping the position open. Full close completely exits the position & returns your collateral.
          </PopoverBody>
        </PopoverContent>
      </Popover>
    </HStack>
    <RadioGroup
      value={closeType}
      onChange={val => {
        if (val === 'full') {
          setInputClosePercent('100');
          setManagedActionState({ closePercent: 100 });
        } else {
          setInputClosePercent('');
          setManagedActionState({ closePercent: undefined });
        }
      }}
    >
      <HStack>
        <Radio value="partial">Partial Close</Radio>
        <Radio value="full">Full Close</Radio>
        {closeType === 'partial' && (
          <Input
            variant="filled"
            value={inputClosePercent}
            onChange={e => handleClosePercent(Number(e.target.value))}
            type="number"
            min={1}
            max={99}
            step={1}
            color={SEMANTIC_COLORS.textPrimary}
            bg={SEMANTIC_COLORS.bgTertiary}
            w="80px"
            _placeholder={{ color: SEMANTIC_COLORS.textTertiary }}
            placeholder="%"
          />
        )}
      </HStack>
    </RadioGroup>
  </VStack>
);

const EditSummarySection = ({ action, managedActionState, asset }: { action: any, managedActionState: any, asset: any }) => (
  /* ConfirmModal wired to tx action */
  <ConfirmModal label="Confirm" action={action} isDisabled={false} >
    <Box w="100%" bg={SEMANTIC_COLORS.bgTertiary} borderRadius={0} p={6} mt={0} mb={2}>
      <Text fontWeight="semibold" mb={2}>Edit Summary:</Text>
      <VStack align="stretch" spacing={2} fontSize="xs">
        {managedActionState.collateralAmount && Number(managedActionState.collateralAmount) > 0 && (
          <HStack justify="space-between">
            <Text color={SEMANTIC_COLORS.textSecondary}>Deposit Collateral</Text>
            <Text color={SEMANTIC_COLORS.textPrimary} fontWeight="bold">{managedActionState.collateralAmount} {asset?.symbol}</Text>
          </HStack>
        )}
        {managedActionState.multiplier && managedActionState.multiplier != 1 && (
          <HStack justify="space-between">
            <Text color={SEMANTIC_COLORS.textSecondary}>Change Multiplier to</Text>
            <Text color={SEMANTIC_COLORS.textPrimary} fontWeight="bold">{Number(managedActionState.multiplier).toFixed(2)}x</Text>
          </HStack>
        )}
        {managedActionState.takeProfit && (
          <HStack justify="space-between">
            <Text color={SEMANTIC_COLORS.textSecondary}>Set Take Profit @</Text>
            <Text color={SEMANTIC_COLORS.textPrimary} fontWeight="bold">{managedActionState.takeProfit}</Text>
          </HStack>
        )}
        {managedActionState.stopLoss && (
          <HStack justify="space-between">
            <Text color={SEMANTIC_COLORS.textSecondary}>Set Stop Loss @</Text>
            <Text color={SEMANTIC_COLORS.textPrimary} fontWeight="bold">{managedActionState.stopLoss}</Text>
          </HStack>
        )}
        {managedActionState.closePercent && (
          <HStack justify="space-between">
            <Text color={SEMANTIC_COLORS.textSecondary}>Close Position</Text>
            <Text color={SEMANTIC_COLORS.textPrimary} fontWeight="bold">{managedActionState.closePercent}%</Text>
          </HStack>
        )}
        {managedActionState.borrowAmount && Number(managedActionState.borrowAmount) > 0 && (
          <HStack justify="space-between">
            <Text color={SEMANTIC_COLORS.textSecondary}>Borrow CDT</Text>
            <Text color={SEMANTIC_COLORS.textPrimary} fontWeight="bold">{managedActionState.borrowAmount} CDT</Text>
          </HStack>
        )}
        {managedActionState.repayAmount && Number(managedActionState.repayAmount) > 0 && (
          <HStack justify="space-between">
            <Text color={SEMANTIC_COLORS.textSecondary}>Repay CDT</Text>
            <Text color={SEMANTIC_COLORS.textPrimary} fontWeight="bold">{managedActionState.repayAmount} CDT</Text>
          </HStack>
        )}
      </VStack>
    </Box>
  </ConfirmModal>
);

const MarketActionEdit = (props: MarketActionEditProps) => {
  const {
    asset,
    inputCollateralAmount,
    handleCollateral,
    userBalance,
    handleMax,
    inputTakeProfit,
    handleTP,
    inputStopLoss,
    handleSL,
    inputBorrowAmount,
    handleBorrow,
    inputRepayAmount,
    handleRepay,
    dynamicLiquidationPrice,
    maxMultiplier,
    inputMultiplier,
    handleMultiplier,
    multiplierPlaceholder,
    closeType,
    inputClosePercent,
    handleClosePercent,
    setInputClosePercent,
    setManagedActionState,
    action,
    managedActionState,
  } = useMarketActionEdit(props);

  return (
    <VStack spacing={6} align="stretch" w="100%">
      <DepositCollateralSection
        inputCollateralAmount={inputCollateralAmount}
        handleCollateral={handleCollateral}
        userBalance={userBalance}
        asset={asset}
        handleMax={handleMax}
      />
      {/* TP/SL Inputs */}
      <TakeProfitStopLossSection
        inputTakeProfit={inputTakeProfit}
        handleTP={handleTP}
        inputStopLoss={inputStopLoss}
        handleSL={handleSL}
      />
      <BorrowCDTSection inputBorrowAmount={inputBorrowAmount} handleBorrow={handleBorrow} />
      <RepayCDTSection inputRepayAmount={inputRepayAmount} handleRepay={handleRepay} />
      <PriceInfoSection collateralPrice={props.collateralPrice} dynamicLiquidationPrice={dynamicLiquidationPrice} />
      <MultiplierSection
        maxMultiplier={maxMultiplier}
        inputMultiplier={inputMultiplier}
        handleMultiplier={handleMultiplier}
        multiplierPlaceholder={multiplierPlaceholder}
      />
      <ClosePositionSection
        closeType={closeType}
        inputClosePercent={inputClosePercent}
        handleClosePercent={handleClosePercent}
        setInputClosePercent={setInputClosePercent}
        setManagedActionState={setManagedActionState}
      />
      <EditSummarySection action={action} managedActionState={managedActionState} asset={asset} />
    </VStack>
  );
};

export default MarketActionEdit;
