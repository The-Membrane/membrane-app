import React, { useState, useEffect } from 'react';
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
} from '@chakra-ui/react';
import { getObjectCookie } from '@/helpers/cookies';
import { getChainConfig, supportedChains } from '@/config/chains';
import { useBalanceByAsset } from '@/hooks/useBalance';
import { useAssetByDenom, useAssetBySymbol } from '@/hooks/useAssets';
import useWallet from '@/hooks/useWallet';
import { useChainRoute } from '@/hooks/useChainRoute';
import Divider from '@/components/Divider';
import useManagedAction from '@/components/ManagedMarkets/hooks/useManagedMarket';
import ConfirmModal from '@/components/ConfirmModal/ConfirmModal';
import { useManagedMarket } from '@/hooks/useManaged';
import { useQuery } from '@tanstack/react-query';
import { num } from '@/helpers/num';
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast';

// Mock: Replace with real data fetching
const fetchPositions = () => {
  // Try to get from cookies
  const positions = getObjectCookie('positions') || [];
  // If not found, fallback to empty or query all markets (to be implemented)
  // Add a mock position for demonstration
  if (positions.length === 0) {
    return [
      {
        marketAddress: '0x123',
        marketName: 'Unnamed Market',
        asset: 'OSMO',
        debt: '98.52',
        marketValue: '500.00',
        borrowAPY: '0.73',
        liquidationPrice: '+50.00',
      },
    ];
  }
  return positions;
};

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

const MarketActionEdit = ({ assetSymbol, position, marketAddress, collateralDenom, maxLTV, debt, collateral, price }: { assetSymbol: string, position: any, marketAddress: string, collateralDenom: string, maxLTV: number, debt: number, collateral: number, price: number }) => {
  const asset = useAssetBySymbol(assetSymbol);
  const { setManagedActionState, managedActionState } = useManagedAction();
  const [closeAll, setCloseAll] = React.useState(false);

  // Max multiplier
  const maxMultiplier = 1 / (1 - maxLTV);

  // Max withdraw logic
  const maxWithdraw = Math.max(0, collateral - (debt / (maxLTV * price)));

  // User balance for deposit
  const userBalance = Number(useBalanceByAsset(asset));

  // Handlers
  const handleToggle = (v: boolean) => setManagedActionState({ deposit: !v });
  const handleCollateral = (v: string) => setManagedActionState({ collateralAmount: v });
  const handleTP = (v: string) => setManagedActionState({ takeProfit: v });
  const handleSL = (v: string) => setManagedActionState({ stopLoss: v });
  const handleMultiplier = (v: number) => setManagedActionState({ multiplier: v });
  const handleCloseAll = (checked: boolean) => {
    setCloseAll(checked);
    setManagedActionState({ closePercent: checked ? 100 : undefined });
  };
  const handleClosePercent = (v: number) => setManagedActionState({ closePercent: v });

  // Build tx action
  const { action } = useCloseAndEditBoostsTx({
    marketContract: marketAddress,
    collateralDenom,
    managedActionState,
    run: true,
  });

  return (
    <VStack spacing={6} align="stretch" w="100%">
      <HStack justify="space-between" align="center">
        <Text color="whiteAlpha.800" fontWeight="medium">
          Collateral Action
        </Text>
        <Switch
          onChange={e => handleToggle(e.target.checked)}
          colorScheme="teal"
        />
      </HStack>
      <Box w="100%" bg="#11161e" borderRadius="lg" p={4}>
        <HStack justify="space-between" align="flex-start" w="100%">
          <VStack align="flex-start" spacing={1} flex={1}>
            <Text color="whiteAlpha.700" fontSize="sm" fontWeight="medium">
              Collateral amount
            </Text>
            <Input
              variant="unstyled"
              fontSize="2xl"
              fontWeight="bold"
              color="white"
              defaultValue={position.collateralAmount || ''}
              onChange={e => handleCollateral(e.target.value)}
              type="number"
              min={0}
              max={maxWithdraw}
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
      {/* Multiplier input with boundaries */}
      <VStack align="start" spacing={1} w="100%">
        <Text color="whiteAlpha.700" fontSize="sm">Multiplier</Text>
        <Input
          variant="filled"
          defaultValue={position.multiplier || 1}
          onChange={e => handleMultiplier(Number(e.target.value))}
          type="number"
          min={1}
          max={maxMultiplier}
          step={0.01}
          color="white"
          bg="#232A3E"
          _placeholder={{ color: 'whiteAlpha.400' }}
        />
      </VStack>
      {/* Close position toggle and input */}
      <HStack w="100%" spacing={4} align="center">
        <Text color="whiteAlpha.700" fontSize="sm">Close Position</Text>
        <Switch isChecked={closeAll} onChange={e => handleCloseAll(e.target.checked)} colorScheme="red" />
        {!closeAll && (
          <Input
            variant="filled"
            value={managedActionState.closePercent || ''}
            onChange={e => handleClosePercent(Number(e.target.value))}
            type="number"
            min={0}
            max={100}
            step={1}
            color="white"
            bg="#232A3E"
            w="80px"
            _placeholder={{ color: 'whiteAlpha.400' }}
            placeholder="%"
          />
        )}
      </HStack>
      {/* ConfirmModal wired to tx action */}
      <ConfirmModal label="Confirm" action={action} isDisabled={false} />
    </VStack>
  );
};

const PositionCard = ({ position }: { position: any }) => {
  const [editState, setEditState] = React.useState(position);
  const asset = useAssetBySymbol(editState.asset);
  const { isOpen, onOpen, onClose } = useDisclosure();

//   const handleEditSave = (newState: any) => {
//     setEditState(newState);
//     onClose();
//   };

  return (
    <Card p={4} mb={4} borderRadius="xl" border="2px solid #232A3E" bg="#20232C" width="100%">
      {/* Top section: logo, cluster, symbol, Edit button */}
      <HStack w="100%" justify="space-between" align="center" mb={2}>
        <HStack spacing={3} align="center">
          <Image src={asset?.logo} alt={asset?.symbol} boxSize="36px" borderRadius="full" bg="#181C23" />
          <VStack align="start" spacing={0}>
            <Text color="whiteAlpha.700" fontSize="sm">{editState.marketName}</Text>
            <Text color="white" fontWeight="bold" fontSize="xl">{asset?.symbol || editState.asset}</Text>
          </VStack>
        </HStack>
        <Button size="sm" variant="ghost" colorScheme="gray" color="whiteAlpha.700" onClick={onOpen} borderRadius="full" px={4} fontWeight="bold">Edit</Button>
      </HStack>
      <Divider my={2} />
      {/* Stats row: Debt, Market Value, Borrow APY, Liquidation Price */}
      <HStack w="100%" justify="space-between" align="center" mt={2}>
        <VStack flex={1} align="start" spacing={0}>
          <Text color="whiteAlpha.700" fontSize="sm">Debt</Text>
          <Text color="white" fontWeight="bold" fontSize="lg">${editState.debt || '0.00'}</Text>
        </VStack>
        <VStack flex={1} align="start" spacing={0}>
          <Text color="whiteAlpha.700" fontSize="sm">Market Value</Text>
          <Text color="white" fontWeight="bold" fontSize="lg">${editState.marketValue || '0.00'}</Text>
        </VStack>
        <VStack flex={1} align="start" spacing={0}>
          <Text color="whiteAlpha.700" fontSize="sm">Borrow APY</Text>
          <Text color="white" fontWeight="bold" fontSize="lg">{editState.borrowAPY || '0.00'}%</Text>
        </VStack>
        <VStack flex={1} align="start" spacing={0}>
          <Text color="whiteAlpha.700" fontSize="sm">Liquidation Price</Text>
          <Text color="white" fontWeight="bold" fontSize="lg">{editState.liquidationPrice || '-'}</Text>
        </VStack>
      </HStack>
      {/* Edit Modal Placeholder */}
      <Modal isOpen={isOpen} onClose={onClose} isCentered>
        <ModalOverlay />
        <ModalContent bg="#20232C" color="white">
          <ModalHeader>Edit Position</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <MarketActionEdit assetSymbol={asset?.symbol || editState.asset} position={editState} marketAddress={editState.marketAddress} collateralDenom={editState.collateralDenom} maxLTV={editState.maxLTV} debt={editState.debt} collateral={editState.collateral} price={editState.price} />
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

const Portfolio: React.FC = () => {
  const [tabIndex, setTabIndex] = useState(0);
  const [positions, setPositions] = useState<any[]>([]);
  const [yieldData, setYieldData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // Get chainName and userAddress from hooks
  const { chainName } = useChainRoute();
  const { address: userAddress } = useWallet(chainName);

  // Mock stats values
  const stats = [
    { label: 'Your rewards', value: '$12,540.33' },
    { label: 'Your debt', value: '$600,00.04' },
    { label: 'Your supply', value: '$2,00,000.77' },
    { label: 'Net asset value', value: '$1,400,000.73' },
  ];

  useEffect(() => {
    setLoading(true);
    if (tabIndex === 0) {
      // Positions
      const pos = fetchPositions();
      setPositions(pos);
      setLoading(false);
    } else {
      // Yield
      const yld = fetchYield(userAddress!, chainName);
      setYieldData(yld);
      setLoading(false);
    }
  }, [tabIndex, userAddress, chainName]);

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
            <Stat key={idx}>
              <StatLabel color="whiteAlpha.700" fontSize="md">{stat.label}</StatLabel>
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
            {loading ? (
              <Spinner color="white" />
            ) : positions.length === 0 ? (
              <Text color="whiteAlpha.700" mt={8}>No positions found.</Text>
            ) : (
              <SimpleGrid columns={{ base: 1, md: 1 }} spacing={4} mt={4}>
                {positions.map((position, idx) => (
                  <PositionCard key={idx} position={position} />
                ))}
              </SimpleGrid>
            )}
          </TabPanel>
          <TabPanel px={0}>
            {loading ? (
              <Spinner color="white" />
            ) : yieldData.length === 0 ? (
              <Text color="whiteAlpha.700" mt={8}>No yield data found.</Text>
            ) : (
              <SimpleGrid columns={{ base: 1, md: 1 }} spacing={4} mt={4}>
                {yieldData.map((yieldItem, idx) => (
                  <YieldCard key={idx} yieldItem={yieldItem} />
                ))}
              </SimpleGrid>
            )}
          </TabPanel>
        </TabPanels>
      </Tabs>
    </Box>
  );
};

export default Portfolio; 