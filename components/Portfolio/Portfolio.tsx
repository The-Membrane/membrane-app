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
} from '@chakra-ui/react';
import { getObjectCookie, setObjectCookie } from '@/helpers/cookies';
import { getChainConfig, supportedChains } from '@/config/chains';
import { useBalanceByAsset } from '@/hooks/useBalance';
import { useAssetByDenom, useAssetBySymbol } from '@/hooks/useAssets';
import useWallet from '@/hooks/useWallet';
import { useChainRoute } from '@/hooks/useChainRoute';
import Divider from '@/components/Divider';
import useManagedAction from '@/components/ManagedMarkets/hooks/useManagedMarket';
import ConfirmModal from '@/components/ConfirmModal/ConfirmModal';
import { useAllMarkets, useUserPositioninMarket, useMarketCollateralDenoms } from '@/hooks/useManaged';
import { useQuery, useQueries } from '@tanstack/react-query';
import { num } from '@/helpers/num';
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast';
import useCloseAndEditBoostsTx from './hooks/useCloseAndEditBoostsTx';
import { getMarketCollateralDenoms, useMarketNames, getUserPositioninMarket, getManagedMarket } from '@/services/managed';
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

const MarketActionEdit = ({ assetSymbol, position, marketAddress, collateralDenom, maxLTV, collateralPrice, currentLTV, initialLiquidationPrice }: { assetSymbol: string, position: any, marketAddress: string, collateralDenom: string, maxLTV: number, collateralPrice: number, currentLTV: number, initialLiquidationPrice: string }) => {
  const asset = useAssetBySymbol(assetSymbol);
  const { setManagedActionState, managedActionState } = useManagedAction();
  const { chainName } = useChainRoute();
  const { address: userAddress } = useWallet(chainName);
  const { data: uxBoosts } = useUserUXBoosts(marketAddress, collateralDenom, userAddress ?? '');
  const [spread, setSpread] = useState(0.01);
  // Max multiplier
  const maxMultiplier = 1 / (1 - maxLTV);

  // User balance for deposit
  const userBalance = Number(useBalanceByAsset(asset));

  // Calculate dynamic liquidation price
  const inputCollateral = Number(managedActionState.collateralAmount) || 0;
  const decimals = asset?.decimal || 6;
  const baseCollateral = Number(position.collateral_amount) / Math.pow(10, decimals);
  const totalCollateral = baseCollateral + inputCollateral;
  const debt = Number(position.debt_amount) / 1e6; // assuming 6 decimals for debt
  const debtPrice = Number(position.debtPrice) || 1; // fallback to 1 if not available
  let dynamicLiquidationPrice = '-';
  if (totalCollateral > 0 && maxLTV > 0) {
    dynamicLiquidationPrice = ((debt / (totalCollateral * maxLTV)) * debtPrice).toFixed(4);
  }

  // Handlers
  const handleCollateral = (v: string) => setManagedActionState({ collateralAmount: v });
  const handleTP = (v: string) => setManagedActionState({ takeProfit: v });
  const handleSL = (v: string) => setManagedActionState({ stopLoss: v });
  const handleMultiplier = (v: number) => setManagedActionState({ multiplier: v });
  const handleClosePercent = (v: number) => setManagedActionState({ closePercent: v });
  const handleMax = () => setManagedActionState({ collateralAmount: userBalance.toString() });

  // Build tx action
  const { action } = useCloseAndEditBoostsTx({
    marketContract: marketAddress,
    collateralDenom,
    managedActionState,
    collateralPrice: collateralPrice.toString(),
    currentLTV: currentLTV.toString(),
    maxSpread: spread.toString(),
    run: !!(managedActionState.closePercent || managedActionState.collateralAmount || managedActionState.takeProfit || managedActionState.stopLoss || managedActionState.multiplier),
  });

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
    } catch {}
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
              value={managedActionState.collateralAmount || ''}
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
          <Text color="whiteAlpha.700" fontSize="sm">Take Profit (TP)</Text>
          <Input
            variant="filled"
            defaultValue={position.takeProfit || ''}
            onChange={e => handleTP(e.target.value)}
            placeholder="TP Price"
            color="white"
            bg="#232A3E"
            _placeholder={{ color: 'whiteAlpha.400' }}
          />
        </VStack>
        <VStack flex={1} align="start" spacing={1}>
          <Text color="whiteAlpha.700" fontSize="sm">Stop Loss (SL)</Text>
          <Input
            variant="filled"
            defaultValue={position.stopLoss || ''}
            onChange={e => handleSL(e.target.value)}
            placeholder="SL Price"
            color="white"
            bg="#232A3E"
            _placeholder={{ color: 'whiteAlpha.400' }}
          />
        </VStack>
      </HStack>
      {/* Current Price & Liquidation Price Box */}
      <Box w="100%" bg="#181C23" borderRadius="md" p={3} mt={2} mb={2}>
        <VStack align="stretch" spacing={1}>
          <Text color="whiteAlpha.700" fontSize="sm">Current Price: ${Number(collateralPrice).toFixed(4)}</Text>
          <Text color="whiteAlpha.700" fontSize="sm">Liquidation Price: {dynamicLiquidationPrice !== '-' ? `$${dynamicLiquidationPrice}` : '-'}</Text>
        </VStack>
      </Box>
      {/* Multiplier input with boundaries */}
      <VStack align="start" spacing={1} w="100%">
        <Text color="whiteAlpha.700" fontSize="sm">Multiplier</Text>
        <Input
          variant="filled"
          value={managedActionState.multiplier != 1 ? managedActionState.multiplier : ''}
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
        <Text color="whiteAlpha.700" fontSize="sm">Close Position</Text>
        <RadioGroup
          value={closeType}
          onChange={val => {
            if (val === 'full') setManagedActionState({ closePercent: 100 });
            else setManagedActionState({ closePercent: undefined });
          }}
        >
          <HStack>
            <Radio value="partial">Partial Close</Radio>
            <Radio value="full">Full Close</Radio>
            {closeType === 'partial' && (
              <Input
                variant="filled"
                value={managedActionState.closePercent || ''}
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
            { managedActionState.multiplier && managedActionState.multiplier != 1 && (
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
          </VStack>
        </Box>
      </ConfirmModal>
    </VStack>
  );
};

const PositionCard = ({ position, chainName, assets, marketName, maxLTV, debtPrice, collateralPrice }: { position: any, chainName: string, assets: any[], marketName: string, maxLTV: number, debtPrice?: number, collateralPrice?: string }) => {
  const [editState, setEditState] = React.useState(position);
  const asset = useAssetByDenom(editState.asset, chainName, assets);
  const { isOpen, onOpen, onClose } = useDisclosure();

  // Get asset price from prices list
  const assetPrice = collateralPrice ? Number(collateralPrice) : 0;

  // Calculate liquidation price (if possible)
  let liquidationPrice = '-';
  if (debtPrice && position.debt_amount && position.collateral_amount && maxLTV) {
    const debt = Number(position.debt_amount);
    const collateral = Number(position.collateral_amount);
    if (collateral > 0 && maxLTV > 0) {
      liquidationPrice = ((debt / (collateral * maxLTV)) * debtPrice).toFixed(4);
    }
  }
  //Calc current LTV
  const debt = num(shiftDigits(position.debt_amount, -6));
  const collateral = num(shiftDigits(position.collateral_amount, -(asset?.decimals || 6)));
  const assetPriceNum = Number(collateralPrice) || 0;
  const debtPriceNum = Number(debtPrice) || 0;
  const currentLTV = collateral.gt(0) && assetPriceNum > 0 ? debt.times(debtPriceNum).div(collateral.times(assetPriceNum)).toNumber() : 0;

  // Borrow APY from collateralCost
  const borrowAPY = collateralPrice ? Number(collateralPrice).toFixed(2) : '0.00';

  return (
    <Card p={4} mb={4} borderRadius="xl" border="2px solid #232A3E" bg="#20232C" width="100%">
      {/* Top section: logo, cluster, symbol, Edit button */}
      <HStack w="100%" justify="space-between" align="center" mb={2}>
        <HStack spacing={3} align="center">
          <Image src={asset?.logo} alt={asset?.symbol} boxSize="36px" borderRadius="full" bg="#181C23" />
          <VStack align="start" spacing={0}>
            <Text color="whiteAlpha.700" fontSize="sm">{marketName}</Text>
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
          <Text color="white" fontWeight="bold" fontSize="lg">${(shiftDigits(position.collateral_amount, -6).times(assetPrice)).toFixed(2)}</Text>
        </VStack>
        <VStack flex={1} align="start" spacing={0}>
          <Text color="whiteAlpha.700" fontSize="sm">Debt</Text>
          <Text color="white" fontWeight="bold" fontSize="lg">${shiftDigits(position.debt_amount, -6).toFixed(2) || '0.00'}</Text>
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
      {/* Edit Modal Placeholder */}
      <Modal isOpen={isOpen} onClose={onClose} isCentered>
        <ModalOverlay />
        <ModalContent bg="#20232C" color="white">
          <ModalHeader>Edit Position</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <MarketActionEdit assetSymbol={asset?.symbol || editState.asset} position={editState} marketAddress={editState.marketAddress} collateralDenom={editState.asset} maxLTV={maxLTV} collateralPrice={collateralPrice ? Number(collateralPrice) : 0} currentLTV={currentLTV} initialLiquidationPrice={liquidationPrice} />
          </ModalBody>
        </ModalContent>
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

// Query all static markets and all their collaterals for user positions
const STATIC_MARKETS = [
  { address: 'osmo1fucs2qtlwspwd3ahadqyyhxshurvku2gvxddrl0enp6j6y5dszjq96awy7', name: 'Market 1' },
  { address: 'osmo1fftkmw6hwsw54aw9l0jfxkzzysvq23h6vqgk8cx32aedy6jxucmqpz27zj', name: 'Market 2' },
  // Add more static markets as needed
];

const Portfolio: React.FC = () => {
  const [tabIndex, setTabIndex] = useState(0);
  const [yieldData, setYieldData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [initialMarkets, setInitialMarkets] = useState<string[]>([]);
  const [displayedMarkets, setDisplayedMarkets] = useState<string[]>([]);

  // Get chainName and userAddress from hooks
  const { chainName } = useChainRoute();
  const { address: userAddress } = useWallet(chainName);
  const { data: cosmwasmClient } = useCosmWasmClient();
  const assets = useAssets(chainName);
  const { appState } = useAppState();

  // On mount, read userMarkets cookie for fast initial UI
  useEffect(() => {
    const cachedMarkets = getObjectCookie('userMarkets') || [];
    setInitialMarkets(cachedMarkets);
    setDisplayedMarkets(cachedMarkets);
  }, []);

  // Get all prices (oracle)
  const { data: prices = [] } = useOraclePrice();

  // Get debt price (use first static market)
  const { data: debtPriceData } = useMarketDebtPrice(STATIC_MARKETS[0].address);
  const debtPrice = debtPriceData?.price ? Number(debtPriceData.price) : undefined;

  // 1. Fetch all collateral denoms for all static markets using useQueries
  const collateralDenomsQueries = useQueries({
    queries: STATIC_MARKETS.map((market) => ({
      queryKey: ['collateral_denoms', market.address, cosmwasmClient],
      queryFn: () => {
        if (!cosmwasmClient) return Promise.resolve([]);
        return getMarketCollateralDenoms(cosmwasmClient, market.address);
      },
      staleTime: 1000 * 60 * 5,
    })),
  });

  // 2. Once all collateral denoms are loaded, build all (market, collateral) pairs
  const allMarketCollateralPairs = STATIC_MARKETS.flatMap((market, mIdx) => {
    const q = collateralDenomsQueries[mIdx];
    if (!q || q.isLoading || q.isError || !Array.isArray(q.data)) return [];
    return q.data.map((collateralDenom: string) => ({ market, collateralDenom }));
  });

  // 3. Fetch all user positions for all (market, collateral) pairs using useQueries
  const userPositionQueries = useQueries({
    queries: allMarketCollateralPairs.map(({ market, collateralDenom }) => ({
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
      const newMarkets = positions.map(p => p.marketAddress);
      // Only update if different
      if (
        newMarkets.length !== displayedMarkets.length ||
        !newMarkets.every((m, i) => m === displayedMarkets[i])
      ) {
        setDisplayedMarkets(newMarkets);
        if (appState.setCookie) {
          setObjectCookie('userMarkets', newMarkets, 30); // 30 days
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions, appState.setCookie]);

  // Use the batch hook to get all market names
  const marketNames = useMarketNames(positions.map(p => p.marketAddress));

  // Filter positions to only those in displayedMarkets (for initial render)
  const filteredPositions = displayedMarkets.length > 0
    ? positions.filter(p => displayedMarkets.includes(p.marketAddress))
    : positions;

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
  const tvl = filteredPositions.reduce((acc, p) => {
    const assetPrice = prices?.find((pr) => pr.denom === p.asset)?.price || 0;
    return acc.plus(num(shiftDigits(p.collateral_amount, -6)).times(assetPrice));
  }, new BigNumber(0));
  const totalDebt = filteredPositions.reduce((acc, p) => acc.plus(num(shiftDigits(p.debt_amount, -6))), new BigNumber(0));
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
  return (
    <Box w="90vw" mx="auto" mt={8}>
      {/* Portfolio Title and Stats */}
      <HStack align="center" justify="space-between" mb={8} w="100%">
        <HStack spacing={4} align="center">
          <Avatar boxSize="64px" bg="#1a2330" icon={<Box boxSize="32px" as="span" bgGradient="linear(to-br, #6fffc2, #1a2330)" borderRadius="md" />} />
          <Box>
            <Text fontSize="2xl" fontWeight="bold" color="white">Your Portfolio</Text>
            <Text color="whiteAlpha.600" fontSize="md">{chainName.charAt(0).toUpperCase() + chainName.slice(1)}</Text>
          </Box>
        </HStack>
        <HStack spacing={10}>
          {stats.map((stat, idx) => (
            <Stat key={idx} width="12vw">
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
      </HStack>
      <Tabs index={tabIndex} onChange={setTabIndex} variant="unstyled">
        <TabList borderBottom="1px solid #232A3E">
          <Tab fontWeight="bold" color={tabIndex === 0 ? 'white' : 'whiteAlpha.600'}>Positions</Tab>
          <Tab fontWeight="bold" color={tabIndex === 1 ? 'white' : 'whiteAlpha.600'}>Yield</Tab>
        </TabList>
        <TabPanels>
          <TabPanel px={0}>
            {loading && filteredPositions.length === 0 ? (
              <Spinner color="white" />
            ) : filteredPositions.length === 0 ? (
              <Text color="whiteAlpha.700" mt={8}>No positions found.</Text>
            ) : (
              <SimpleGrid columns={{ base: 1, md: 1 }} spacing={4} mt={4}>
                {filteredPositions.map((position, idx) => (
                  <PositionCard
                    key={idx}
                    position={position}
                    chainName={chainName}
                    assets={assets || []}
                    marketName={marketNames[idx]}
                    debtPrice={debtPrice}
                    collateralPrice={collateralPriceQueries[idx]?.data?.price}
                    maxLTV={Number(maxLTVQueries[idx]?.data?.[0]?.collateral_params.liquidation_LTV) || 0}
                  />
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
    </Box>
  );
};

export default Portfolio; 