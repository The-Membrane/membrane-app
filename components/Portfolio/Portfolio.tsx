import React, { useState, useEffect, useMemo } from 'react';
import {
  Box,
  Tabs,
  TabList,
  TabPanels,
  Tab,
  TabPanel,
  VStack,
  Text,
  SimpleGrid,
  Card,
  HStack,
  Spinner,
  Stat,
  StatLabel,
  StatNumber,
  Avatar,
  Image,
  Button,
  Modal,
  ModalOverlay,
  ModalContent,
  ModalHeader,
  ModalCloseButton,
  ModalBody,
  useDisclosure,
  Switch,
  Input,
  Select,
  RadioGroup,
  Radio,
  Flex,
  Tooltip,
  Icon,
  Portal,
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverHeader,
  PopoverBody,
  PopoverArrow,
  Stack,
} from '@chakra-ui/react';
import { getObjectCookie, setObjectCookie } from '@/helpers/cookies';
import { getChainConfig, supportedChains } from '@/config/chains';
import { useBalanceByAsset } from '@/hooks/useBalance';
import { useAssetByDenom, useAssetBySymbol } from '@/hooks/useAssets';
import useWallet from '@/hooks/useWallet';
import { useChainRoute } from '@/hooks/useChainRoute';
import Divider from '@/components/Divider';
import useManagedAction from '@/components/ManagedMarkets/hooks/useManagedMarketState';
import ConfirmModal from '@/components/ConfirmModal/ConfirmModal';
import { useAllMarkets, useUserPositioninMarket, useMarketCollateralDenoms } from '@/hooks/useManaged';
import { useQuery, useQueries } from '@tanstack/react-query';
import { num } from '@/helpers/num';
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast';
import useCloseAndEditBoostsTx from './hooks/useCloseAndEditBoostsTx';
import { getMarketCollateralDenoms, useMarketNames, getUserPositioninMarket, getManagedMarket, getMarketCollateralCost } from '@/services/managed';
import { getCosmWasmClient, useCosmWasmClient } from '@/helpers/cosmwasmClient';
import useAppState from '@/persisted-state/useAppState';
import useAssets from '@/hooks/useAssets';
import { useMarketDebtPrice, useMarketCollateralCost } from '@/hooks/useManaged';
import { useOraclePrice } from '@/hooks/useOracle';
import { getMarketCollateralPrice } from '@/services/managed';
import { shiftDigits } from '@/helpers/math';
import { useUserUXBoosts } from '@/hooks/useManaged';
import BigNumber from 'bignumber.js';
import ManagedMarketSummary from '@/components/ManagedMarkets/ManagedMarketSummary';
import ClaimButton from '../Nav/ClaimButton'
import SoloLeveling from '../Nav/PointsLevel';
import PointsLeaderboard from '../Home/PointsLeaderboard';
import { useLeaderboardData } from '@/hooks/usePoints';
import { useUserPositions, useBasket } from '@/hooks/useCDP';
import { useUserBoundedIntents } from '../../hooks/useEarnQueries';
import useMintState from '../Mint/hooks/useMintState';
import NextLink from 'next/link';
import useVaultSummary from '../Mint/hooks/useVaultSummary';
import { NeuroCloseModal } from '../Home/NeuroModals';
import { denoms } from '@/config/defaults';
import { PositionResponse } from '@/contracts/codegen/positions/Positions.types';
import { Formatter } from '@/helpers/formatter';
import { InfoIcon } from '@chakra-ui/icons';

// Mock: Replace with real data fetching
// const fetchPositions = () => {
//   // Try to get from cookies
//   const positions = getObjectCookie('positions') || [];
//   // If not found, fallback to empty or query all markets (to be implemented)
//   // Add a mock position for demonstration
//   if (positions.length === 0) {
//     return [
//       {
//         marketAddress: '0x123',
//         marketName: 'Unnamed Market',
//         asset: 'OSMO',
//         debt: '98.52',
//         marketValue: '500.00',
//         borrowAPY: '0.73',
//         liquidationPrice: '+50.00',
//       },
//     ];
//   }
//   return positions;
// };

// Mock: Replace with real data fetching
const fetchYield = (userAddress: string, chainName: string) => {
  // This should check all tokens for the user, filter those with 'debt-suppliers',
  // and match the prefix from chain config
  // For now, return mock data
  return [
    {
      denom: 'osmo/debt-suppliers/0x123',
      amount: '100',
      chain: 'osmosis',
    },
    {
      denom: 'neutron/debt-suppliers/0x456',
      amount: '50',
      chain: 'neutron',
    },
  ];
};

const MarketActionEdit = ({ assetSymbol, position, marketAddress, collateralDenom, maxLTV, collateralPrice, currentLTV, initialLiquidationPrice, onClose }: { assetSymbol: string, position: any, marketAddress: string, collateralDenom: string, maxLTV: number, collateralPrice: number, currentLTV: number, initialLiquidationPrice: string, onClose: () => void }) => {
  const asset = useAssetBySymbol(assetSymbol);
  const { setManagedActionState, managedActionState } = useManagedAction();
  const { chainName } = useChainRoute();
  const { address: userAddress } = useWallet(chainName);
  const { data: uxBoosts } = useUserUXBoosts(marketAddress, collateralDenom, userAddress ?? '');
  const [spread, setSpread] = useState(0.01);

  // Middleman state variables for immediate input updates
  const [inputCollateralAmount, setInputCollateralAmount] = useState(managedActionState.collateralAmount || '');
  const [inputTakeProfit, setInputTakeProfit] = useState(managedActionState.takeProfit || '');
  const [inputStopLoss, setInputStopLoss] = useState(managedActionState.stopLoss || '');
  const [inputMultiplier, setInputMultiplier] = useState(managedActionState.multiplier || '');
  const [inputClosePercent, setInputClosePercent] = useState(managedActionState.closePercent || '');
  const [inputBorrowAmount, setInputBorrowAmount] = useState(managedActionState.borrowAmount || '');
  const [inputRepayAmount, setInputRepayAmount] = useState(managedActionState.repayAmount || '');

  // Max multiplier
  const maxMultiplier = 1 / (1 - (maxLTV - currentLTV));

  // User balance for deposit
  const userBalance = Number(useBalanceByAsset(asset));

  // Calculate dynamic liquidation price
  const inputCollateral = Number(inputCollateralAmount) || 0;
  const decimals = asset?.decimal || 6;
  const baseCollateral = Number(position.collateral_amount) / Math.pow(10, decimals);
  const totalCollateral = baseCollateral + inputCollateral;
  const debt = Number(position.debt_amount) / 1e6; // assuming 6 decimals for debt
  const debtPrice = Number(position.debtPrice) || 1; // fallback to 1 if not available
  let dynamicLiquidationPrice = '-';
  if (totalCollateral > 0 && maxLTV > 0) {
    dynamicLiquidationPrice = ((debt / (totalCollateral * maxLTV)) * debtPrice).toFixed(4);
  }

  // Handlers with 600ms delay
  const timeoutRefs = React.useRef<{ [key: string]: NodeJS.Timeout }>({});

  const handleCollateral = React.useCallback((v: string) => {
    // Update middleman state immediately
    setInputCollateralAmount(v);

    // Update managedActionState after 600ms delay
    if (timeoutRefs.current.collateral) {
      clearTimeout(timeoutRefs.current.collateral);
    }
    timeoutRefs.current.collateral = setTimeout(() => {
      setManagedActionState({ collateralAmount: v });
    }, 600);
  }, []);

  const handleTP = React.useCallback((v: string) => {
    // Update middleman state immediately
    setInputTakeProfit(v);

    // Update managedActionState after 600ms delay
    if (timeoutRefs.current.takeProfit) {
      clearTimeout(timeoutRefs.current.takeProfit);
    }
    timeoutRefs.current.takeProfit = setTimeout(() => {
      setManagedActionState({ takeProfit: v });
    }, 600);
  }, []);

  const handleSL = React.useCallback((v: string) => {
    // Update middleman state immediately
    setInputStopLoss(v);

    // Update managedActionState after 600ms delay
    if (timeoutRefs.current.stopLoss) {
      clearTimeout(timeoutRefs.current.stopLoss);
    }
    timeoutRefs.current.stopLoss = setTimeout(() => {
      setManagedActionState({ stopLoss: v });
    }, 600);
  }, []);

  const handleMultiplier = React.useCallback((v: number) => {
    // Update middleman state immediately
    setInputMultiplier(Math.min(v, maxMultiplier).toFixed(2));

    // Update managedActionState after 600ms delay
    if (timeoutRefs.current.multiplier) {
      clearTimeout(timeoutRefs.current.multiplier);
    }
    timeoutRefs.current.multiplier = setTimeout(() => {
      setManagedActionState({ multiplier: Math.min(v, maxMultiplier) });
    }, 600);
  }, [maxMultiplier]);

  const handleClosePercent = React.useCallback((v: number) => {
    // Update middleman state immediately
    setInputClosePercent(v.toString());

    // Update managedActionState after 600ms delay
    if (timeoutRefs.current.closePercent) {
      clearTimeout(timeoutRefs.current.closePercent);
    }
    timeoutRefs.current.closePercent = setTimeout(() => {
      setManagedActionState({ closePercent: v });
    }, 600);
  }, []);

  const handleBorrow = React.useCallback((v: string) => {
    setInputBorrowAmount(v);
    if (timeoutRefs.current.borrow) {
      clearTimeout(timeoutRefs.current.borrow);
    }
    timeoutRefs.current.borrow = setTimeout(() => {
      setManagedActionState({ borrowAmount: v });
    }, 600);
  }, []);

  const handleRepay = React.useCallback((v: string) => {
    setInputRepayAmount(v);
    if (timeoutRefs.current.repay) {
      clearTimeout(timeoutRefs.current.repay);
    }
    timeoutRefs.current.repay = setTimeout(() => {
      setManagedActionState({ repayAmount: v });
    }, 600);
  }, []);

  const handleMax = () => {
    setInputCollateralAmount(userBalance.toString());
    setManagedActionState({ collateralAmount: userBalance.toString() });
  };

  // Sync middleman state with managedActionState
  React.useEffect(() => {
    setInputCollateralAmount(managedActionState.collateralAmount || '');
    setInputTakeProfit(managedActionState.takeProfit || '');
    setInputStopLoss(managedActionState.stopLoss || '');
    setInputMultiplier(managedActionState.multiplier || '');
    setInputClosePercent(managedActionState.closePercent || '');
    setInputBorrowAmount(managedActionState.borrowAmount || '');
    setInputRepayAmount(managedActionState.repayAmount || '');
  }, [managedActionState]);

  // Build tx action
  const { action } = useCloseAndEditBoostsTx({
    marketContract: marketAddress,
    collateralDenom,
    managedActionState,
    collateralPrice: collateralPrice.toString(),
    currentLTV: currentLTV.toString(),
    maxSpread: spread.toString(),
    decimals: asset?.decimal || 6,
    run: !!(managedActionState.closePercent || managedActionState.collateralAmount || managedActionState.takeProfit || managedActionState.stopLoss || managedActionState.multiplier || managedActionState.borrowAmount || managedActionState.repayAmount),
  });

  React.useEffect(() => {
    if (action.tx?.isSuccess) {
      onClose();
    }
  }, [action.tx.isSuccess, onClose]);

  // console.log('action', action.simulate.error, action.simulate.errorMessage);
  //If slippage is too lwo & it errors, increase it by 1%
  //The slippage error contains "max spread assertion"
  useMemo(() => {
    if (action.simulate.error && (action.simulate.error.message.includes("max spread assertion") || action.simulate.error.message.includes("token amount calculated"))) {
      setSpread((prev) => prev + 0.01)
      console.log("Increasing spread to", spread + 0.01)
    }
  }, [action.simulate.error, spread])
  // Determine close type for radio
  const closeType = Number(managedActionState.closePercent) === 100 ? 'full' : 'partial';
  // console.log('closePercent:', managedActionState.closePercent, 'closeType:', closeType);

  // Multiplier placeholder logic
  let multiplierPlaceholder = "1";
  if (uxBoosts && uxBoosts.loop_ltv) {
    try {
      const loopLtv = Number(uxBoosts.loop_ltv);
      if (!isNaN(loopLtv) && loopLtv !== 0 && loopLtv !== 1) {
        multiplierPlaceholder = (1 / (1 - loopLtv)).toFixed(2);
      }
    } catch { }
  }

  return (
    <VStack spacing={6} align="stretch" w="100%">
      <Box w="100%" bg="#11161e" borderRadius="lg" p={4}>
        <HStack justify="space-between" align="flex-start" w="100%">
          <VStack align="flex-start" spacing={1} flex={1}>
            <Text color="whiteAlpha.700" fontSize="sm" fontWeight="medium">
              Deposit More Collateral
            </Text>
            <Input
              variant="unstyled"
              fontSize="2xl"
              fontWeight="bold"
              color="white"
              value={inputCollateralAmount}
              onChange={e => handleCollateral(e.target.value)}
              type="number"
              min={0}
              max={userBalance}
              placeholder="0"
              w="100%"
              _placeholder={{ color: 'whiteAlpha.400' }}
              paddingInlineEnd={"3"}
            />
          </VStack>
          <VStack align="flex-end" spacing={2}>
            <HStack bg="#1a2330" borderRadius="full" px={3} py={1} spacing={2}>
              <Image src={asset?.logo} alt={asset?.symbol} boxSize="24px" />
              <Text color="white" fontWeight="bold">{asset?.symbol}</Text>
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
      {/* TP/SL Inputs */}
      <HStack w="100%" spacing={4}>
        <VStack flex={1} align="start" spacing={1}>
          <HStack spacing={2}>
            <Text color="whiteAlpha.700" fontSize="sm">Take Profit (TP)</Text>
            <Popover>
              <PopoverTrigger>
                <Icon as={InfoIcon} color="whiteAlpha.600" boxSize={3} cursor="pointer" />
              </PopoverTrigger>
              <PopoverContent bg="#232A3E" color="white">
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
            color="white"
            bg="#232A3E"
            _placeholder={{ color: 'whiteAlpha.400' }}
          />
        </VStack>
        <VStack flex={1} align="start" spacing={1}>
          <HStack spacing={2}>
            <Text color="whiteAlpha.700" fontSize="sm">Stop Loss (SL)</Text>
            <Popover>
              <PopoverTrigger>
                <Icon as={InfoIcon} color="whiteAlpha.600" boxSize={3} cursor="pointer" />
              </PopoverTrigger>
              <PopoverContent bg="#232A3E" color="white">
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
            color="white"
            bg="#232A3E"
            _placeholder={{ color: 'whiteAlpha.400' }}
          />
        </VStack>
      </HStack>

      {/* Borrow CDT Input */}
      <VStack align="start" spacing={1} w="100%">
        <HStack spacing={2}>
          <Text color="whiteAlpha.700" fontSize="sm">Borrow CDT</Text>
          <Popover>
            <PopoverTrigger>
              <Icon as={InfoIcon} color="whiteAlpha.600" boxSize={3} cursor="pointer" />
            </PopoverTrigger>
            <PopoverContent bg="#232A3E" color="white">
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
          color="white"
          bg="#232A3E"
          _placeholder={{ color: 'whiteAlpha.400' }}
        />
      </VStack>

      {/* Repay CDT Input */}
      <VStack align="start" spacing={1} w="100%">
        <HStack spacing={2}>
          <Text color="whiteAlpha.700" fontSize="sm">Repay CDT</Text>
          <Popover>
            <PopoverTrigger>
              <Icon as={InfoIcon} color="whiteAlpha.600" boxSize={3} cursor="pointer" />
            </PopoverTrigger>
            <PopoverContent bg="#232A3E" color="white">
              <PopoverArrow />
              <PopoverHeader fontWeight="bold">Repay CDT</PopoverHeader>
              <PopoverBody>
                Repay your debt by sending CDT to reduce your position's debt and lower liquidation risk.
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
          color="white"
          bg="#232A3E"
          _placeholder={{ color: 'whiteAlpha.400' }}
        />
      </VStack>
      {/* Current Price & Liquidation Price Box */}
      <Box w="100%" bg="#181C23" borderRadius="md" p={3} mt={2} mb={2}>
        <VStack align="stretch" spacing={1}>
          <Text color="whiteAlpha.700" fontSize="sm">Current Price: ${Number(collateralPrice).toFixed(4)}</Text>
          <Text color="whiteAlpha.700" fontSize="sm">Liquidation Price: {dynamicLiquidationPrice !== '-' ? `$${dynamicLiquidationPrice}` : '-'}</Text>
        </VStack>
      </Box>
      {/* Multiplier input with boundaries */}
      <VStack align="start" spacing={1} w="100%">
        <HStack spacing={2}>
          <Text color="whiteAlpha.700" fontSize="sm">Change Multiplier (max {maxMultiplier.toFixed(2)}x)</Text>
          <Popover>
            <PopoverTrigger>
              <Icon as={InfoIcon} color="whiteAlpha.600" boxSize={3} cursor="pointer" />
            </PopoverTrigger>
            <PopoverContent bg="#232A3E" color="white">
              <PopoverArrow />
              <PopoverHeader fontWeight="bold">Change Multiplier</PopoverHeader>
              <PopoverBody>
                Adjust your position's leverage multiplier. Higher multipliers increase potential returns but also increase liquidation risk. The max multiplier is calculated using your available LTV space.
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
          color="white"
          bg="#232A3E"
          _placeholder={{ color: 'whiteAlpha.400' }}
          placeholder={multiplierPlaceholder}
        />
      </VStack>
      {/* Close Position Section with RadioGroup */}
      <VStack align="start" spacing={1} w="100%">
        <HStack spacing={2}>
          <Text color="whiteAlpha.700" fontSize="sm">Close Position</Text>
          <Popover>
            <PopoverTrigger>
              <Icon as={InfoIcon} color="whiteAlpha.600" boxSize={3} cursor="pointer" />
            </PopoverTrigger>
            <PopoverContent bg="#232A3E" color="white">
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
                color="white"
                bg="#232A3E"
                w="80px"
                _placeholder={{ color: 'whiteAlpha.400' }}
                placeholder="%"
              />
            )}
          </HStack>
        </RadioGroup>
      </VStack>
      {/* ConfirmModal wired to tx action */}
      <ConfirmModal label="Confirm" action={action} isDisabled={false} >
        <Box w="100%" bg="#181C23" borderRadius="lg" p={6} mt={0} mb={2}>
          <Text fontWeight="semibold" mb={2}>Edit Summary:</Text>
          <VStack align="stretch" spacing={2} fontSize="xs">
            {managedActionState.collateralAmount && Number(managedActionState.collateralAmount) > 0 && (
              <HStack justify="space-between">
                <Text color="whiteAlpha.700">Deposit Collateral</Text>
                <Text color="white" fontWeight="bold">{managedActionState.collateralAmount} {asset?.symbol}</Text>
              </HStack>
            )}
            {managedActionState.multiplier && managedActionState.multiplier != 1 && (
              <HStack justify="space-between">
                <Text color="whiteAlpha.700">Change Multiplier to</Text>
                <Text color="white" fontWeight="bold">{Number(managedActionState.multiplier).toFixed(2)}x</Text>
              </HStack>
            )}
            {managedActionState.takeProfit && (
              <HStack justify="space-between">
                <Text color="whiteAlpha.700">Set Take Profit @</Text>
                <Text color="white" fontWeight="bold">{managedActionState.takeProfit}</Text>
              </HStack>
            )}
            {managedActionState.stopLoss && (
              <HStack justify="space-between">
                <Text color="whiteAlpha.700">Set Stop Loss @</Text>
                <Text color="white" fontWeight="bold">{managedActionState.stopLoss}</Text>
              </HStack>
            )}
            {managedActionState.closePercent && (
              <HStack justify="space-between">
                <Text color="whiteAlpha.700">Close Position</Text>
                <Text color="white" fontWeight="bold">{managedActionState.closePercent}%</Text>
              </HStack>
            )}
            {managedActionState.borrowAmount && Number(managedActionState.borrowAmount) > 0 && (
              <HStack justify="space-between">
                <Text color="whiteAlpha.700">Borrow CDT</Text>
                <Text color="white" fontWeight="bold">{managedActionState.borrowAmount} CDT</Text>
              </HStack>
            )}
            {managedActionState.repayAmount && Number(managedActionState.repayAmount) > 0 && (
              <HStack justify="space-between">
                <Text color="whiteAlpha.700">Repay CDT</Text>
                <Text color="white" fontWeight="bold">{managedActionState.repayAmount} CDT</Text>
              </HStack>
            )}
          </VStack>
        </Box>
      </ConfirmModal>
    </VStack>
  );
};

const PositionCard = ({ position, chainName, assets, marketName, maxLTV, debtPrice, collateralPrice, collateralCost, cdtMarketPrice }: { position: any, chainName: string, assets: any[], marketName: string, maxLTV: number, debtPrice?: number, collateralPrice?: string, collateralCost?: string, cdtMarketPrice: string }) => {
  const [editState, setEditState] = React.useState(position);
  const asset = useAssetByDenom(editState.asset, chainName, assets);
  const { isOpen, onOpen, onClose } = useDisclosure();

  // Reset editState whenever the modal opens
  React.useEffect(() => {
    if (isOpen) {
      setEditState(position);
    }
  }, [isOpen, position]);

  // Get asset price from prices list
  const assetPrice = new BigNumber(collateralPrice || 0);

  //Calc current LTV
  const debt = num(shiftDigits(position.debt_amount, -6));
  const collateral = num(shiftDigits(position.collateral_amount, -(asset?.decimal || 6)));
  const cdtPrice = new BigNumber(cdtMarketPrice || 0);

  const currentLTV = collateral.gt(0) && assetPrice.gt(0) ? debt.times(cdtPrice).div(collateral.times(assetPrice)) : new BigNumber(0);

  // Calculate liquidation price (if possible)
  let liquidationPrice = '-';
  if (maxLTV > 0 && currentLTV.gt(0) && assetPrice.gt(0)) {
    liquidationPrice = Formatter.toNearestNonZero(assetPrice.times(currentLTV.div(maxLTV)).toNumber());
  }

  // Borrow APY from collateralCost
  const borrowAPY = collateralCost ? Number(collateralCost).toFixed(2) : '0.00';

  return (
    <Card p={4} mb={4} borderRadius="xl" border="2px solid #232A3E" bg="#20232C" width="100%">
      {/* Top section: logo, cluster, symbol, Edit button */}
      <HStack w="100%" justify="space-between" align="center" mb={2}>
        <HStack spacing={3} align="center">
          <Image src={asset?.logo} alt={asset?.symbol} boxSize="36px" borderRadius="full" bg="#181C23" />
          <VStack align="start" spacing={0}>
            <NextLink href={`/${chainName}/isolated/${editState.marketAddress}/${asset?.symbol || editState.asset}?tab=multiply`}>
              <Text
                color="whiteAlpha.700"
                fontSize="sm"
                cursor="pointer"
                _hover={{ color: 'teal.300', textDecoration: 'underline' }}
              >
                {marketName}
              </Text>
            </NextLink>
            <Text color="white" fontWeight="bold" fontSize="xl">{asset?.symbol || editState.asset}</Text>
          </VStack>
        </HStack>
        <Button
          size="xs"
          variant="ghost"
          colorScheme="gray"
          color="whiteAlpha.700"
          onClick={onOpen}
          borderRadius="full"
          px={2}
          fontWeight="bold"
          width="20%"
          pt={2}
          minW={"auto"}
          h={"24px"}
        >
          Edit
        </Button>
      </HStack>
      <Divider my={2} />
      {/* Stats row: Market Value, Debt, Borrow APY, Liquidation Price */}
      <HStack w="100%" justify="space-between" align="center" mt={2}>
        <VStack flex={1} align="start" spacing={0}>
          <Text color="whiteAlpha.700" fontSize="sm">Market Value</Text>
          <Text color="white" fontWeight="bold" fontSize="lg">${(collateral.times(assetPrice)).toFixed(2)}</Text>
        </VStack>
        <VStack flex={1} align="start" spacing={0}>
          <Text color="whiteAlpha.700" fontSize="sm">Debt</Text>
          <Text color="white" fontWeight="bold" fontSize="lg">${debt.times(cdtPrice).toFixed(2) || '0.00'}</Text>
        </VStack>
        <VStack flex={1} align="start" spacing={0}>
          <Text color="whiteAlpha.700" fontSize="sm">Borrow APY</Text>
          <Text color="white" fontWeight="bold" fontSize="lg">{borrowAPY}%</Text>
        </VStack>
        <VStack flex={1} align="start" spacing={0}>
          <Text color="whiteAlpha.700" fontSize="sm">Liquidation Price</Text>
          <Text color="white" fontWeight="bold" fontSize="lg">${liquidationPrice}</Text>
        </VStack>
      </HStack>
      {/* Edit Modal */}
      <Modal isOpen={isOpen} onClose={onClose} isCentered>
        <ModalOverlay pointerEvents="none" />
        <ModalContent bg="#20232C" color="white" pointerEvents="auto">
          <ModalHeader>Edit Position</ModalHeader>
          <ModalCloseButton />
          <ModalBody zIndex={1000}>
            <MarketActionEdit assetSymbol={asset?.symbol || editState.asset} position={editState} marketAddress={editState.marketAddress} collateralDenom={editState.asset} maxLTV={maxLTV} collateralPrice={assetPrice.toNumber()} currentLTV={currentLTV.toNumber()} initialLiquidationPrice={liquidationPrice} onClose={onClose} />
          </ModalBody>
        </ModalContent>
      </Modal>
    </Card>
  );
};

const MintCard = ({ position, chainName, cdtMarketPrice }: { position: any, chainName: string, cdtMarketPrice: string }) => {
  const { isOpen, onOpen, onClose } = useDisclosure();
  const { setMintState } = useMintState();

  const { data: summary } = useVaultSummary({ positionNumber: position.positionNumber })
  const { ltv, liqudationLTV, tvl, debtAmount } = summary || {
    debtAmount: 0,
    cost: 0,
    tvl: 0,
    ltv: 0,
    borrowLTV: 0,
    liquidValue: 0,
    liqudationLTV: 0,
  }

  // console.log(`MintCard #${position.positionNumber} Summary:`, summary);
  // console.log(`MintCard #${position.positionNumber} LTV:`, ltv);
  // console.log(`MintCard #${position.positionNumber} Liquidation LTV:`, liqudationLTV);

  const health = useMemo(() => {
    if (ltv === 0) return 100
    const healthValue = num(1).minus(num(ltv).dividedBy(liqudationLTV)).times(100).dp(0).toNumber()
    // console.log(`MintCard #${position.positionNumber} Calculated Health:`, healthValue);
    return healthValue;
  }, [ltv, liqudationLTV, position.positionNumber]);

  return (
    <Card p={4} mb={4} borderRadius="xl" border="2px solid #232A3E" bg="#20232C" width="100%">
      {/* Top section: using a generic icon for now */}
      <HStack w="100%" justify="space-between" align="center" mb={2}>
        <HStack spacing={3} align="center">
          <Image src="/images/cdt.svg" alt="CDT Logo" boxSize="36px" />
          <VStack align="start" spacing={0}>
            <Text color="whiteAlpha.700" fontSize="sm">CDP</Text>
            <Text color="white" fontWeight="bold" fontSize="xl">#{position.positionNumber}</Text>
          </VStack>
        </HStack>
        <HStack width="30%">
          <Button
            size="xs"
            variant="ghost"
            colorScheme="gray"
            color="whiteAlpha.700"
            as={NextLink}
            href={`/${chainName}/mint`}
            onClick={() => setMintState({ positionNumber: position.positionNumber })}
            borderRadius="full"
            px={2}
            fontWeight="bold"
            width="50%"
            pt={2}
            minW={"auto"}
            h={"24px"}
          >
            Edit
          </Button>
          <Button
            size="xs"
            variant="ghost"
            colorScheme="gray"
            color="whiteAlpha.700"
            onClick={onOpen}
            borderRadius="full"
            px={2}
            fontWeight="bold"
            width="50%"
            pt={2}
            minW={"auto"}
            h={"24px"}
          >
            Close
          </Button>
        </HStack>
      </HStack>
      <Divider my={2} />
      {/* Stats row: TVL, Debt, Health */}
      <HStack w="100%" justify="space-between" align="center" mt={2}>
        <VStack flex={1} align="start" spacing={0}>
          <Text color="whiteAlpha.700" fontSize="sm">TVL</Text>
          <Text color="white" fontWeight="bold" fontSize="lg">${tvl.toFixed(2)}</Text>
        </VStack>
        <VStack flex={1} align="start" spacing={0}>
          <Text color="whiteAlpha.700" fontSize="sm">Debt</Text>
          <Text color="white" fontWeight="bold" fontSize="lg">{debtAmount.toFixed(2)} CDT</Text>
        </VStack>
        <VStack flex={1} align="start" spacing={0}>
          <Text color="whiteAlpha.700" fontSize="sm">Health</Text>
          <Text color="white" fontWeight="bold" fontSize="lg">
            {Math.min(health, 100) === -Infinity ? "N/A" : `${Math.min(health, 100)}%`}
          </Text>
        </VStack>
      </HStack>
      {/* Edit Modal */}
      <Modal isOpen={isOpen} onClose={onClose} isCentered size="xl">
        <ModalOverlay />
        <NeuroCloseModal
          isOpen={isOpen}
          onClose={onClose}
          position={position.position}
          debtAmount={debtAmount}
          positionNumber={position.positionNumber}
          cdtMarketPrice={cdtMarketPrice}
        />
      </Modal>
    </Card>
  );
};

const YieldCard = ({ yieldItem }: { yieldItem: any }) => (
  <Card p={4} mb={4} borderRadius="xl" border="2px solid #232A3E" bg="#20232C">
    <VStack align="start">
      <Text fontWeight="bold" color="white">{yieldItem.denom}</Text>
      <Text color="whiteAlpha.800">Amount: {yieldItem.amount}</Text>
      <Text color="whiteAlpha.800">Chain: {yieldItem.chain}</Text>
    </VStack>
  </Card>
);

const CheckClaims = () => {
  const [enabled, setEnabled] = useState(false)
  return (
    <Box mt={10} mb={10} display="flex" justifyContent="center">
      {!enabled ? (
        <Button onClick={() => setEnabled(true)} w="20%" minW={"fit-content"}>
          Check for Claims
        </Button>
      ) : (
        <ClaimButton enabled={enabled} setEnabled={setEnabled} />
      )}
    </Box>
  )
}

const Portfolio: React.FC = () => {
  const [tabIndex, setTabIndex] = useState(0);
  const [yieldData, setYieldData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [initialMarkets, setInitialMarkets] = useState<{ address: string; name: string }[]>([]);

  // Get chainName and userAddress from hooks
  const { chainName } = useChainRoute();
  const { address: userAddress } = useWallet(chainName);
  const { appState } = useAppState();
  const { data: cosmwasmClient } = useCosmWasmClient(appState.rpcUrl);
  const assets = useAssets(chainName);
  const allMarketsData = useAllMarkets();

  // Get CDP positions
  const { data: basketPositions } = useUserPositions();
  const { data: userIntents } = useUserBoundedIntents();
  const { data: basket } = useBasket(appState.rpcUrl);

  const neuroGuardIntents = useMemo(() => {
    if (!userIntents?.[0]?.intent?.intents?.purchase_intents) return [];
    return userIntents[0].intent.intents.purchase_intents
      .filter((intent: any) => intent.position_id !== undefined);
  }, [userIntents]);

  const cdpPositions = useMemo(() => {
    if (basketPositions && basketPositions[0] && basketPositions[0].positions) {
      return basketPositions[0].positions
        .map((position: any, index: number) => ({ position, positionNumber: index + 1 }))
        .filter(({ position }: { position: any }) =>
          neuroGuardIntents.find((intent: any) => (intent.position_id ?? 0).toString() === position.position_id) === undefined
        );
    }
    return [];
  }, [basketPositions, neuroGuardIntents]);

  const cdpSummariesQueries = useQueries({
    queries: cdpPositions.map((p: any) => ({
      queryKey: ['vaultSummary', p.positionNumber],
      queryFn: () => useVaultSummary({ positionNumber: p.positionNumber }),
    })),
  });

  const cdpSummaries = useMemo(() => cdpSummariesQueries.map(q => q.data), [cdpSummariesQueries]);

  // On mount, read userMarkets cookie for fast initial UI
  useEffect(() => {
    const cachedMarkets = getObjectCookie('userMarkets') || [];
    setInitialMarkets(cachedMarkets.map((address: string) => ({ address, name: 'Cached Market' })));
  }, []);

  const marketsToQuery = useMemo(() => {
    if (allMarketsData && allMarketsData.length > 0) {
      return allMarketsData;
    }
    return initialMarkets;
  }, [allMarketsData, initialMarkets]);

  // Get all prices (oracle)
  const { data: prices = [] } = useOraclePrice();
  const cdtMarketPrice = prices?.find((price) => price.denom === denoms.CDT[0])?.price || basket?.credit_price?.price || "1";

  // Get debt price (use first static market)
  const { data: debtPriceData } = useMarketDebtPrice(marketsToQuery[0]?.address);
  const debtPrice = debtPriceData?.price ? Number(debtPriceData.price) : undefined;

  // 1. Fetch all collateral denoms for all static markets using useQueries
  const collateralDenomsQueries = useQueries({
    queries: marketsToQuery.map((market: any) => ({
      queryKey: ['collateral_denoms', market.address, cosmwasmClient],
      queryFn: () => {
        if (!cosmwasmClient || !market.address) return Promise.resolve([]);
        return getMarketCollateralDenoms(cosmwasmClient, market.address);
      },
      enabled: !!cosmwasmClient && !!market.address,
      staleTime: 1000 * 60 * 5,
    })),
  });

  // 2. Once all collateral denoms are loaded, build all (market, collateral) pairs
  const allMarketCollateralPairs = marketsToQuery.flatMap((market: any, mIdx: number) => {
    const q = collateralDenomsQueries[mIdx];
    if (!q || q.isLoading || q.isError || !Array.isArray(q.data)) return [];
    return q.data.map((collateralDenom: string) => ({ market, collateralDenom }));
  });

  // 3. Fetch all user positions for all (market, collateral) pairs using useQueries
  const userPositionQueries = useQueries({
    queries: allMarketCollateralPairs.map(({ market, collateralDenom }: { market: any, collateralDenom: string }) => ({
      queryKey: ['user_position', market.address, collateralDenom, userAddress, cosmwasmClient],
      queryFn: () => {
        if (!cosmwasmClient) return Promise.resolve([]);
        return getUserPositioninMarket(cosmwasmClient, market.address, collateralDenom, userAddress || '');
      },
      enabled: !!userAddress,
      staleTime: 1000 * 60 * 2,
    })),
  });

  // 4. Aggregate all positions
  const positions = userPositionQueries
    .flatMap((q, idx) => {
      if (q.isLoading || q.isError || !Array.isArray(q.data)) return [];
      const { market, collateralDenom } = allMarketCollateralPairs[idx];
      return q.data
        .map((pos: any) => ({
          ...pos.position,
          user: pos.user,
          marketAddress: market.address,
          marketName: market.name,
          asset: collateralDenom,
        }))
        .filter((p: any) => p && Number(p.collateral_amount) > 0);
    });

  // After full query, update displayedMarkets and cookie if needed
  useMemo(() => {
    if (positions.length > 0) {
      const newMarkets = [...new Set(positions.map((p) => p.marketAddress))];
      const currentMarkets = getObjectCookie('userMarkets') || [];

      if (JSON.stringify(newMarkets.sort()) !== JSON.stringify(currentMarkets.sort())) {
        if (appState.setCookie) {
          setObjectCookie('userMarkets', newMarkets, 30);
        }
      }
    }
  }, [positions, appState.setCookie]);

  // Use the batch hook to get all market names
  const marketNames = useMarketNames(positions.map(p => p.marketAddress));

  // Fetch collateral prices for all positions
  const collateralPriceQueries = useQueries({
    queries: positions.map((position) => ({
      queryKey: ['collateral_price', position.marketAddress, position.asset],
      queryFn: () => {
        if (!cosmwasmClient || !position.marketAddress || !position.asset) return Promise.resolve(undefined);
        return getMarketCollateralPrice(cosmwasmClient, position.marketAddress, position.asset);
      },
      enabled: !!cosmwasmClient && !!position.marketAddress && !!position.asset,
      staleTime: 1000 * 60 * 5,
    })),
  });

  // Fetch collateral costs for all positions
  const collateralCostQueries = useQueries({
    queries: positions.map((position) => ({
      queryKey: ['collateral_cost', position.marketAddress, position.asset],
      queryFn: () => {
        if (!cosmwasmClient || !position.marketAddress || !position.asset) return Promise.resolve(undefined);
        return getMarketCollateralCost(cosmwasmClient, position.marketAddress, position.asset);
      },
      enabled: !!cosmwasmClient && !!position.marketAddress && !!position.asset,
      staleTime: 1000 * 60 * 5,
    })),
  });

  // Fetch maxLTV for all positions
  const maxLTVQueries = useQueries({
    queries: positions.map((position) => ({
      queryKey: ['maxLTV', position.marketAddress, position.asset, cosmwasmClient],
      queryFn: () => {
        if (!cosmwasmClient || !position.marketAddress || !position.asset) return Promise.resolve(undefined);
        return getManagedMarket(cosmwasmClient, position.marketAddress, position.asset);
      },
      enabled: !!cosmwasmClient && !!position.marketAddress && !!position.asset,
      staleTime: 1000 * 60 * 5,
    })),
  });

  useEffect(() => {
    if (tabIndex === 0) {
      setLoading(
        collateralDenomsQueries.some((q) => q.isLoading) ||
        userPositionQueries.some((q) => q.isLoading)
      );
    } else {
      setLoading(true);
      // Yield
      const yld = fetchYield(userAddress!, chainName);
      setYieldData(yld);
      setLoading(false);
    }
  }, [tabIndex, userAddress, chainName, collateralDenomsQueries, userPositionQueries]);

  // Compute global stats from filteredPositions
  const cdpMetrics = useMemo(() => {
    if (!cdpPositions.length || !prices.length || !assets.length || !cdtMarketPrice) {
      return { tvl: new BigNumber(0), debt: new BigNumber(0) };
    }

    let totalTvl = new BigNumber(0);
    let totalDebt = new BigNumber(0);

    cdpPositions.forEach((cdp: any) => {
      // Calculate Debt in USD
      const debtAmount = num(shiftDigits(cdp.position.credit_amount, -6));
      totalDebt = totalDebt.plus(debtAmount.times(cdtMarketPrice));

      // Calculate TVL
      cdp.position.collateral_assets.forEach((collateral: any) => {
        const assetInfo = assets.find(a => a.base === collateral.asset.info.native_token.denom);
        const priceInfo = prices.find(p => p.denom === collateral.asset.info.native_token.denom);

        if (assetInfo && priceInfo) {
          const collateralAmount = shiftDigits(collateral.asset.amount, -(assetInfo.decimal || 6));
          const collateralValue = num(collateralAmount).times(priceInfo.price);
          totalTvl = totalTvl.plus(collateralValue);
        }
      });
    });

    return { tvl: totalTvl, debt: totalDebt };
  }, [cdpPositions, prices, assets, cdtMarketPrice]);

  const tvl = positions.reduce((acc, p: any) => {
    const assetPrice = prices?.find((pr) => pr.denom === p.asset)?.price || 0;
    const asset = assets.find((a: any) => a.base === p.asset);
    const decimals = asset?.decimal || 6;
    return acc.plus(num(shiftDigits(p.collateral_amount, -decimals)).times(assetPrice));
  }, new BigNumber(0)).plus(cdpMetrics.tvl);
  const totalDebt = positions.reduce((acc, p: any) => acc.plus(num(shiftDigits(p.debt_amount, -6))), new BigNumber(0)).plus(cdpMetrics.debt);
  const netAssetValue = tvl.minus(totalDebt);

  const stats = [
    { label: 'Your TVL', value: `$${tvl.toFixed(2)}` },
    { label: 'Your debt', value: `$${totalDebt.toFixed(2)}` },
    { label: 'Net asset value', value: `$${netAssetValue.toFixed(2)}` },
  ];
  // Mock stats values
  // const stats = [
  //   { label: 'Your TVL', value: '$2,00,000.77' },
  //   { label: 'Your debt', value: '$600,00.04' },
  //   { label: 'Net asset value', value: '$1,400,000.73' },
  // ];
  const { data: leaderboardData } = useLeaderboardData();
  const [isLeaderboardOpen, setIsLeaderboardOpen] = useState(false);
  return (
    <>
      <Box w="90vw" mx="auto" mt={0}>
        {/* Portfolio Title, Stats, Tabs, etc. */}
        <CheckClaims />
        <Stack
          direction={{ base: 'column', lg: 'row' }}
          align={{ base: 'flex-start', lg: 'center' }}
          justify="space-between"
          mb={8}
          w="100%"
          spacing={{ base: 4, lg: 0 }}
        >
          <HStack spacing={4} align="center" minW="fit-content">
            <Avatar boxSize="64px" bg="#1a2330" icon={<Box boxSize="32px" as="span" bgGradient="linear(to-br, #6fffc2, #1a2330)" borderRadius="md" />} />
            <Box>
              <Text fontSize="2xl" fontWeight="bold" color="white" textAlign="left">Your Portfolio</Text>
              <Text color="whiteAlpha.600" fontSize="md">{chainName.charAt(0).toUpperCase() + chainName.slice(1)}</Text>
            </Box>
          </HStack>
          <HStack spacing={{ base: 4, md: 10 }} minW="fit-content" flexWrap="wrap">
            {stats.map((stat, idx) => (
              <Stat key={idx} minW={{ base: '120px', md: '12vw' }}>
                <StatLabel
                  color="whiteAlpha.700"
                  fontSize="md"
                  minWidth="fit-content"
                  display="inline-block"
                >
                  {stat.label}
                </StatLabel>
                <StatNumber color="white" fontWeight="bold" fontSize="xl">{stat.value}</StatNumber>
              </Stat>
            ))}
          </HStack>
        </Stack>
        <Tabs index={tabIndex} onChange={setTabIndex} variant="unstyled">
          <TabList borderBottom="1px solid #232A3E">
            <Tab fontWeight="bold" color={tabIndex === 0 ? 'white' : 'whiteAlpha.600'}>Positions</Tab>
            <Tab fontWeight="bold" color={tabIndex === 1 ? 'white' : 'whiteAlpha.600'}>Yield</Tab>
          </TabList>
          <TabPanels>
            <TabPanel px={0}>
              {loading && positions.length === 0 && cdpPositions.length === 0 ? (
                <Box display="flex" justifyContent="center" alignItems="center" minH="200px" w="100%">
                  <Spinner color="white" />
                </Box>
              ) : (positions.length === 0 && cdpPositions.length === 0) ? (
                <Text color="whiteAlpha.700" mt={8} textAlign="center">No positions found.</Text>
              ) : (
                <SimpleGrid columns={{ base: 1, md: 1 }} spacing={4} mt={4}>
                  {positions.map((position, idx) => (
                    <PositionCard
                      key={idx}
                      position={position}
                      chainName={chainName}
                      assets={assets || []}
                      marketName={marketNames[idx]}
                      debtPrice={debtPrice}
                      collateralPrice={collateralPriceQueries[idx]?.data?.price}
                      collateralCost={collateralCostQueries[idx]?.data}
                      maxLTV={Number(maxLTVQueries[idx]?.data?.[0]?.collateral_params.max_borrow_LTV) || 0}
                      cdtMarketPrice={cdtMarketPrice}
                    />
                  ))}
                  {cdpPositions.map((cdp: { position: PositionResponse, positionNumber: number }) => (
                    <MintCard key={cdp.positionNumber} position={cdp} chainName={chainName} cdtMarketPrice={cdtMarketPrice} />
                  ))}
                </SimpleGrid>
              )}
            </TabPanel>
            <TabPanel px={0}>
              <Card p={4} mb={4} borderRadius="xl" border="2px solid #232A3E" bg="#20232C">
                <VStack align="start">
                  <Text color="whiteAlpha.700" mt={2} fontWeight="bold">Not available.</Text>
                </VStack>
              </Card>
            </TabPanel>
          </TabPanels>
        </Tabs>
        {/* Points Card as part of the stack, full width */}
        <Box
          w={{ base: '100%', md: '40%' }}
          mt={12}
          bg="#20232C"
          borderRadius="2xl"
          boxShadow="-2px -2px 16px 0px rgba(0,0,0,0.4)"
          border="2px solid #232A3E"
          p={0}
          overflow="hidden"
        >
          <Box display="flex" flexDirection="column">
            <Box p={6} pb={2} w="100%" mx="auto">
              <Text fontSize="xl" fontWeight="bold" color="white" mb={4}>
                Your Points
              </Text>
              <SoloLeveling />
            </Box>
            {/* <Divider my={0} /> */}
            <Box flex={1} overflowY="auto" px={4} py={2}>
              <Text
                color="teal.300"
                cursor="pointer"
                onClick={() => setIsLeaderboardOpen(!isLeaderboardOpen)}
                mb={2}
                textAlign="center"
                fontWeight="bold"
              >
                {isLeaderboardOpen ? 'Close Leaderboard' : 'Open Leaderboard'}
              </Text>
              {isLeaderboardOpen && <PointsLeaderboard data={leaderboardData} />}
            </Box>
          </Box>
        </Box>
      </Box>
    </>
  );
};

export default Portfolio; 