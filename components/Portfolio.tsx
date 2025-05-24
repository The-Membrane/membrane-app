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
} from '@chakra-ui/react';
import { getObjectCookie } from '@/helpers/cookies';
import { getChainConfig, supportedChains } from '@/config/chains';
import { useBalanceByAsset } from '@/hooks/useBalance';
import { useAssetByDenom, useAssetBySymbol } from '@/hooks/useAssets';
import useWallet from '@/hooks/useWallet';
import { useChainRoute } from '@/hooks/useChainRoute';
import Divider from '@/components/Divider';

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

const PositionCard = ({ position }: { position: any }) => {
  const asset = useAssetBySymbol(position.asset);
  const { isOpen, onOpen, onClose } = useDisclosure();

  return (
    <Card p={4} mb={4} borderRadius="xl" border="2px solid #232A3E" bg="#20232C" width="100%">
      {/* Top section: logo, cluster, symbol, Edit button */}
      <HStack w="100%" justify="space-between" align="center" mb={2}>
        <HStack spacing={3} align="center">
          <Image src={asset?.logo} alt={asset?.symbol} boxSize="36px" borderRadius="full" bg="#181C23" />
          <VStack align="start" spacing={0}>
            <Text color="whiteAlpha.700" fontSize="sm">Re7 Labs Cluster</Text>
            <Text color="white" fontWeight="bold" fontSize="xl">{asset?.symbol || position.asset}</Text>
          </VStack>
        </HStack>
        <Button size="sm" variant="ghost" colorScheme="gray" color="whiteAlpha.700" onClick={onOpen} borderRadius="full" px={4} fontWeight="bold">Edit</Button>
      </HStack>
      <Divider my={2} />
      {/* Stats row */}
      <HStack w="100%" justify="space-between" align="center" mt={2}>
        <VStack flex={1} align="start" spacing={0}>
          <Text color="whiteAlpha.700" fontSize="sm">Your supply</Text>
          <Text color="white" fontWeight="bold" fontSize="lg">500.02141 {asset?.symbol || position.asset}</Text>
        </VStack>
        <VStack flex={1} align="start" spacing={0}>
          <Text color="whiteAlpha.700" fontSize="sm">Supply value</Text>
          <Text color="white" fontWeight="bold" fontSize="lg">$1,028,232.01</Text>
        </VStack>
        <VStack flex={1} align="start" spacing={0}>
          <Text color="whiteAlpha.700" fontSize="sm">Supply APY</Text>
          <Text color="white" fontWeight="bold" fontSize="lg">3.12%</Text>
        </VStack>
        <VStack flex={1} align="start" spacing={0}>
          <Text color="whiteAlpha.700" fontSize="sm">Exposure</Text>
          <HStack>
            <Image src="/images/osmo.svg" alt="osmo" boxSize="20px" />
            <Image src="/images/atom.svg" alt="atom" boxSize="20px" />
          </HStack>
        </VStack>
      </HStack>
      {/* Edit Modal Placeholder */}
      <Modal isOpen={isOpen} onClose={onClose} isCentered>
        <ModalOverlay />
        <ModalContent bg="#20232C" color="white">
          <ModalHeader>Edit Position (Placeholder)</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <Text>Edit functionality coming soon.</Text>
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