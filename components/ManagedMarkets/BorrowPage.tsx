import {
  Box,
  Flex,
  Heading,
  Text,
  Button,
  Tooltip,
  Table,
  Thead,
  Tbody,
  Tr,
  Th,
  Td,
  VStack,
  HStack,
  Spacer,
  Tag,
  useColorModeValue,
} from '@chakra-ui/react';
import { useRouter } from 'next/router';


// import Link from "next/link";

// const filters = [
//   { label: 'Collateral asset is', value: 'any asset' },
//   { label: 'Debt asset is', value: 'any asset' },
//   { label: 'Market is', value: 'any market' },
// ];

// const activeFilter = { label: 'Liquidity is', value: '>$100,000' };

const borrowMarkets = [
  {
    slug: "rlp-usr",
    collateral: { name: "RLP", platform: "Resolv" },
    debt: { name: "USR", platform: "Resolv" },
    supplyAPY: "27.84%",
    borrowAPY: "7.38%",
    multiplier: "5.69x",
    lltv: "87.50%",
    liquidity: "$6.29M",
  },
  {
    slug: "rlp-usdc",
    collateral: { name: "RLP", platform: "Resolv" },
    debt: { name: "USDC", platform: "Resolv" },
    supplyAPY: "27.84%",
    borrowAPY: "8.93%",
    multiplier: "5.69x",
    lltv: "87.50%",
    liquidity: "$1.08M",
  },
  {
    slug: "rlp-wstusr",
    collateral: { name: "RLP", platform: "Resolv" },
    debt: { name: "WSTUSR", platform: "Resolv" },
    supplyAPY: "27.84%",
    borrowAPY: "9.73%",
    multiplier: "5.69x",
    lltv: "87.50%",
    liquidity: "$176,958.31",
  },
  {
    slug: "usdopp-wm",
    collateral: { name: "USD0++", platform: "Euler Yield" },
    debt: { name: "wM", platform: "Euler Yield" },
    supplyAPY: "14.08%",
    borrowAPY: "5.41%",
    multiplier: "8.31x",
    lltv: "90.00%",
    liquidity: "$375,228.74",
  },
];

const tableData = [
  {
    collateral: { name: 'RLP', platform: 'Resolv' },
    debt: { name: 'USR', platform: 'Resolv' },
    supplyApy: '27.84%',
    borrowApy: '7.38%',
    maxMultiplier: '5.69x',
    lltv: '87.50%',
    liquidity: '$6.29M\n6.29M USR',
  },
  {
    collateral: { name: 'RLP', platform: 'Resolv' },
    debt: { name: 'USDC', platform: 'Resolv' },
    supplyApy: '27.84%',
    borrowApy: '8.93%',
    maxMultiplier: '5.69x',
    lltv: '87.50%',
    liquidity: '$1.08M\n1.08M USDC',
  },
  {
    collateral: { name: 'RLP', platform: 'Resolv' },
    debt: { name: 'WSTUSR', platform: 'Resolv' },
    supplyApy: '27.84%',
    borrowApy: '9.73%',
    maxMultiplier: '5.69x',
    lltv: '87.50%',
    liquidity: '$176,958.31\n164,544.46 WSTUSR',
  },
  {
    collateral: { name: 'USDO++', platform: 'Euler Yield' },
    debt: { name: 'wM', platform: 'Euler Yield' },
    supplyApy: '14.08%',
    borrowApy: '5.41%',
    maxMultiplier: '8.31x',
    lltv: '90.00%',
    liquidity: '$375,228.74\n375,228.74 wM',
  },
];


const filters = [
  { label: 'Collateral asset is', value: 'any asset' },
  { label: 'Debt asset is', value: 'any asset' },
  { label: 'Market is', value: 'any market' },
];

const activeFilter = { label: 'Liquidity is', value: '>$100,000' };


export default function BorrowPage() {

  const router = useRouter();

  const handleRowClick = (slug: string) => {
    router.push(`/borrow/${slug}`);
  };

  return (
    <Box bg="gray.900" color="white" minH="100vh" p={6}>
      {/* Header */}
      <Flex align="center" gap={4} mb={6}>
        <Box boxSize="50px" bg="teal.500" borderRadius="12px" />
        <Box>
          <Heading fontSize="2xl">Borrow</Heading>
          <Text fontSize="sm" color="gray.400">
            Borrow against collateral or multiply your exposure by looping or going long and short.
          </Text>
        </Box>
      </Flex>

      {/* Filters */}
      {/* <Flex flexWrap="wrap" gap={2} mb={6}>
        {filters.map((filter, i) => (
          <Tag key={i} px={4} py={2} borderRadius="full" bg="gray.700" color="gray.100">
            {filter.label} <Text fontWeight="bold" ml={2}>{filter.value}</Text>
          </Tag>
        ))}
        <Tag px={4} py={2} borderRadius="full" bg="blue.400" color="black" fontWeight="bold">
          {activeFilter.label} <Text ml={2}>{activeFilter.value}</Text>
        </Tag>
        <Button variant="outline" colorScheme="whiteAlpha" borderColor="gray.600">
          Add Filter
        </Button>
      </Flex> */}

      {/* Stats */}
      <Flex mb={4}>
        <Spacer />
        <VStack align="end" spacing={1}>
          <Text fontSize="sm" color="gray.400">Total borrow</Text>
          <Text fontSize="xl" fontWeight="bold">$613.87M</Text>
        </VStack>
        <VStack align="end" spacing={1} ml={8}>
          <Text fontSize="sm" color="gray.400">Total supply</Text>
          <Text fontSize="xl" fontWeight="bold">$1.31B</Text>
        </VStack>
      </Flex>

      {/* Table */}
      <Box overflowX="auto" borderRadius="lg" border="1px solid" borderColor="gray.700">
        <Table variant="simple" size="md">
          <Thead>
            <Tr>
              {[
                { label: 'Collateral asset', tooltip: 'Asset used as collateral' },
                { label: 'Debt asset', tooltip: 'Asset you borrow' },
                { label: 'Supply APY', tooltip: 'Annual % yield earned by suppliers' },
                { label: 'Borrow APY', tooltip: 'Annual % cost to borrow' },
                { label: 'Max multiplier', tooltip: 'Max leverage on this pair' },
                { label: 'LLTV', tooltip: 'Liquidation Loan-To-Value' },
                { label: 'Liquidity', tooltip: 'Available liquidity' },
              ].map(({ label, tooltip }) => (
                <Th key={label}>
                  <Tooltip label={tooltip} hasArrow fontSize="sm">
                    <Text cursor="help">{label}</Text>
                  </Tooltip>
                </Th>
              ))}
            </Tr>
          </Thead>
          <Tbody>
            {borrowMarkets.map((row, i) => (
              <Tr
                key={row.slug}
                // as={Link}
                // href={`/managed/${row.slug}`}
                onClick={() => handleRowClick(row.slug)}
                _hover={{ bg: "gray.700" }}
                cursor="pointer">
                <Td>
                  <VStack align="start" spacing={0}>
                    <Text fontWeight="bold">{row.collateral.name}</Text>
                    <Text fontSize="sm" color="gray.400">{row.collateral.platform}</Text>
                  </VStack>
                </Td>
                <Td>
                  <VStack align="start" spacing={0}>
                    <Text fontWeight="bold">{row.debt.name}</Text>
                    <Text fontSize="sm" color="gray.400">{row.debt.platform}</Text>
                  </VStack>
                </Td>
                <Td>{row.supplyAPY}</Td>
                <Td>{row.borrowAPY}</Td>
                <Td>{row.multiplier}</Td>
                <Td>{row.lltv}</Td>
                <Td>
                  {row.liquidity.split("\n").map((line, j) => (
                    <Text key={j} fontSize={j === 0 ? "md" : "sm"} color={j === 0 ? "white" : "gray.400"}>
                      {line}
                    </Text>
                  ))}
                </Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </Box>
    </Box>
  );
}

