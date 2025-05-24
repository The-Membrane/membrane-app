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
} from '@chakra-ui/react';
import { getObjectCookie } from '@/helpers/cookies';
import { getChainConfig, supportedChains } from '@/config/chains';
import { useBalanceByAsset } from '@/hooks/useBalance';
import { useAssetByDenom } from '@/hooks/useAssets';
import useWallet from '@/hooks/useWallet';
import { useChainRoute } from '@/hooks/useChainRoute';

// Mock: Replace with real data fetching
const fetchPositions = () => {
  // Try to get from cookies
  const positions = getObjectCookie('positions') || [];
  // If not found, fallback to empty or query all markets (to be implemented)
  // Add a mock position for demonstration
  if (positions.length === 0) {
    return [
      {
        asset: 'WETH',
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

const PositionCard = ({ position }: { position: any }) => (
  <Card p={4} mb={4} borderRadius="xl" border="2px solid #232A3E" bg="#20232C">
    <VStack align="start">
      <Text fontWeight="bold" color="white">{position.asset || 'Asset'}</Text>
      <Text color="whiteAlpha.800">Debt: ${position.debt || '0.00'}</Text>
      <Text color="whiteAlpha.800">Market Value: ${position.marketValue || '0.00'}</Text>
      <Text color="whiteAlpha.800">Borrow APY: {position.borrowAPY || '0.00'}%</Text>
      <Text color="whiteAlpha.800">Liquidation Price: {position.liquidationPrice || '-'}%</Text>
    </VStack>
  </Card>
);

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
    <Box w="100%" maxW="900px" mx="auto" mt={8}>
      {/* Portfolio Title and Stats */}
      <HStack align="center" justify="space-between" mb={8} w="100%">
        <HStack spacing={4} align="center">
          <Avatar boxSize="64px" bg="#1a2330" icon={<Box boxSize="32px" as="span" bgGradient="linear(to-br, #6fffc2, #1a2330)" borderRadius="md" />} />
          <Box>
            <Text fontSize="2xl" fontWeight="bold" color="white">Your Portfolio</Text>
            <Text color="whiteAlpha.600" fontSize="md">Ethereum</Text>
          </Box>
        </HStack>
        <HStack spacing={10}>
          {stats.map((stat, idx) => (
            <Stat key={idx} minW="120px">
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
              <SimpleGrid columns={{ base: 1, md: 2 }} spacing={4} mt={4}>
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
              <SimpleGrid columns={{ base: 1, md: 2 }} spacing={4} mt={4}>
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