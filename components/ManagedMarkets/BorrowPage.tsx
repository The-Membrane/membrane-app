// import {
//   Box,
//   Flex,
//   Heading,
//   Text,
//   Button,
//   Tooltip,
//   Table,
//   Thead,
//   Tbody,
//   Tr,
//   Th,
//   Td,
//   VStack,
//   HStack,
//   Spacer,
//   Tag,
//   useColorModeValue,
// } from '@chakra-ui/react';
// import { useRouter } from 'next/router';


// // import Link from "next/link";

// // const filters = [
// //   { label: 'Collateral asset is', value: 'any asset' },
// //   { label: 'Debt asset is', value: 'any asset' },
// //   { label: 'Market is', value: 'any market' },
// // ];

// // const activeFilter = { label: 'Liquidity is', value: '>$100,000' };

// const borrowMarkets = [
//   {
//     slug: "rlp-usr",
//     collateral: { name: "RLP", platform: "Resolv" },
//     debt: { name: "USR", platform: "Resolv" },
//     supplyAPY: "27.84%",
//     borrowAPY: "7.38%",
//     multiplier: "5.69x",
//     lltv: "87.50%",
//     liquidity: "$6.29M",
//   },
//   {
//     slug: "rlp-usdc",
//     collateral: { name: "RLP", platform: "Resolv" },
//     debt: { name: "USDC", platform: "Resolv" },
//     supplyAPY: "27.84%",
//     borrowAPY: "8.93%",
//     multiplier: "5.69x",
//     lltv: "87.50%",
//     liquidity: "$1.08M",
//   },
//   {
//     slug: "rlp-wstusr",
//     collateral: { name: "RLP", platform: "Resolv" },
//     debt: { name: "WSTUSR", platform: "Resolv" },
//     supplyAPY: "27.84%",
//     borrowAPY: "9.73%",
//     multiplier: "5.69x",
//     lltv: "87.50%",
//     liquidity: "$176,958.31",
//   },
//   {
//     slug: "usdopp-wm",
//     collateral: { name: "USD0++", platform: "Euler Yield" },
//     debt: { name: "wM", platform: "Euler Yield" },
//     supplyAPY: "14.08%",
//     borrowAPY: "5.41%",
//     multiplier: "8.31x",
//     lltv: "90.00%",
//     liquidity: "$375,228.74",
//   },
// ];

// const tableData = [
//   {
//     collateral: { name: 'RLP', platform: 'Resolv' },
//     debt: { name: 'USR', platform: 'Resolv' },
//     supplyApy: '27.84%',
//     borrowApy: '7.38%',
//     maxMultiplier: '5.69x',
//     lltv: '87.50%',
//     liquidity: '$6.29M\n6.29M USR',
//   },
//   {
//     collateral: { name: 'RLP', platform: 'Resolv' },
//     debt: { name: 'USDC', platform: 'Resolv' },
//     supplyApy: '27.84%',
//     borrowApy: '8.93%',
//     maxMultiplier: '5.69x',
//     lltv: '87.50%',
//     liquidity: '$1.08M\n1.08M USDC',
//   },
//   {
//     collateral: { name: 'RLP', platform: 'Resolv' },
//     debt: { name: 'WSTUSR', platform: 'Resolv' },
//     supplyApy: '27.84%',
//     borrowApy: '9.73%',
//     maxMultiplier: '5.69x',
//     lltv: '87.50%',
//     liquidity: '$176,958.31\n164,544.46 WSTUSR',
//   },
//   {
//     collateral: { name: 'USDO++', platform: 'Euler Yield' },
//     debt: { name: 'wM', platform: 'Euler Yield' },
//     supplyApy: '14.08%',
//     borrowApy: '5.41%',
//     maxMultiplier: '8.31x',
//     lltv: '90.00%',
//     liquidity: '$375,228.74\n375,228.74 wM',
//   },
// ];


// const filters = [
//   { label: 'Collateral asset is', value: 'any asset' },
//   { label: 'Debt asset is', value: 'any asset' },
//   { label: 'Market is', value: 'any market' },
// ];

// const activeFilter = { label: 'Liquidity is', value: '>$100,000' };


// export default function BorrowPage() {

//   const router = useRouter();

//   const handleRowClick = (slug: string) => {
//     router.push(`/borrow/${slug}`);
//   };

//   return (
//     <Box bg="gray.900" color="white" minH="100vh" p={6}>
//       {/* Header */}
//       <Flex align="center" gap={4} mb={6}>
//         <Box boxSize="50px" bg="teal.500" borderRadius="12px" />
//         <Box>
//           <Heading fontSize="2xl">Borrow</Heading>
//           <Text fontSize="sm" color="gray.400">
//             Borrow against collateral or multiply your exposure by looping or going long and short.
//           </Text>
//         </Box>
//       </Flex>

//       {/* Filters */}
//       {/* <Flex flexWrap="wrap" gap={2} mb={6}>
//         {filters.map((filter, i) => (
//           <Tag key={i} px={4} py={2} borderRadius="full" bg="gray.700" color="gray.100">
//             {filter.label} <Text fontWeight="bold" ml={2}>{filter.value}</Text>
//           </Tag>
//         ))}
//         <Tag px={4} py={2} borderRadius="full" bg="blue.400" color="black" fontWeight="bold">
//           {activeFilter.label} <Text ml={2}>{activeFilter.value}</Text>
//         </Tag>
//         <Button variant="outline" colorScheme="whiteAlpha" borderColor="gray.600">
//           Add Filter
//         </Button>
//       </Flex> */}

//       {/* Stats */}
//       <Flex mb={4}>
//         <Spacer />
//         <VStack align="end" spacing={1}>
//           <Text fontSize="sm" color="gray.400">Total borrow</Text>
//           <Text fontSize="xl" fontWeight="bold">$613.87M</Text>
//         </VStack>
//         <VStack align="end" spacing={1} ml={8}>
//           <Text fontSize="sm" color="gray.400">Total supply</Text>
//           <Text fontSize="xl" fontWeight="bold">$1.31B</Text>
//         </VStack>
//       </Flex>

//       {/* Table */}
//       <Box overflowX="auto" borderRadius="lg" border="1px solid" borderColor="gray.700">
//         <Table variant="simple" size="md">
//           <Thead>
//             <Tr>
//               {[
//                 { label: 'Collateral asset', tooltip: 'Asset used as collateral' },
//                 { label: 'Debt asset', tooltip: 'Asset you borrow' },
//                 { label: 'Supply APY', tooltip: 'Annual % yield earned by suppliers' },
//                 { label: 'Borrow APY', tooltip: 'Annual % cost to borrow' },
//                 { label: 'Max multiplier', tooltip: 'Max leverage on this pair' },
//                 { label: 'LLTV', tooltip: 'Liquidation Loan-To-Value' },
//                 { label: 'Liquidity', tooltip: 'Available liquidity' },
//               ].map(({ label, tooltip }) => (
//                 <Th key={label}>
//                   <Tooltip label={tooltip} hasArrow fontSize="sm">
//                     <Text cursor="help">{label}</Text>
//                   </Tooltip>
//                 </Th>
//               ))}
//             </Tr>
//           </Thead>
//           <Tbody>
//             {borrowMarkets.map((row, i) => (
//               <Tr
//                 key={row.slug}
//                 // as={Link}
//                 // href={`/managed/${row.slug}`}
//                 onClick={() => handleRowClick(row.slug)}
//                 _hover={{ bg: "gray.700" }}
//                 cursor="pointer">
//                 <Td>
//                   <VStack align="start" spacing={0}>
//                     <Text fontWeight="bold">{row.collateral.name}</Text>
//                     <Text fontSize="sm" color="gray.400">{row.collateral.platform}</Text>
//                   </VStack>
//                 </Td>
//                 <Td>
//                   <VStack align="start" spacing={0}>
//                     <Text fontWeight="bold">{row.debt.name}</Text>
//                     <Text fontSize="sm" color="gray.400">{row.debt.platform}</Text>
//                   </VStack>
//                 </Td>
//                 <Td>{row.supplyAPY}</Td>
//                 <Td>{row.borrowAPY}</Td>
//                 <Td>{row.multiplier}</Td>
//                 <Td>{row.lltv}</Td>
//                 <Td>
//                   {row.liquidity.split("\n").map((line, j) => (
//                     <Text key={j} fontSize={j === 0 ? "md" : "sm"} color={j === 0 ? "white" : "gray.400"}>
//                       {line}
//                     </Text>
//                   ))}
//                 </Td>
//               </Tr>
//             ))}
//           </Tbody>
//         </Table>
//       </Box>
//     </Box>
//   );
// }


import { colors } from '@/config/defaults';
import { Box, Button, Card, CardBody, CardFooter, CardHeader, Checkbox, Flex, FormControl, FormLabel, Input, Stack, Text } from '@chakra-ui/react';
import { useEffect, useState } from 'react';
import { UpdateOverallMarket } from './hooks/useManagerState';

interface Param {
  label: string;
  value: string;
  current: string;
}

var updateOverallMarketParams = [
  { label: 'Pause Actions', value: '', current: 'false' },  // Example default
  { label: 'Manager Fee', value: '', current: '0.01' },     // Example 1% fee
  { label: 'Whitelisted Debt Suppliers', value: '', current: '["addr1", "addr2"]' },
  { label: 'Debt Supply Cap', value: '', current: '1000000' },
  { label: 'Per User Debt Cap', value: '', current: '10000' },
];

var updateCollateralParams = [
  { label: 'Max Borrow LTV', value: '', current: '0.75' },
  { label: 'Liquidation LTV Ramp', value: '', current: '{"min": 0.85, "max": 0.9}' },
  { label: 'Rate Params', value: '', current: '{"base_rate": "0.02", "slope1": "0.1", "slope2": "0.5"}' },
  { label: 'Borrow Fee', value: '', current: '0.005' },
  { label: 'Whitelisted Collateral Suppliers', value: '', current: '["addr1", "addr2"]' },
  { label: 'Borrow Cap', value: '', current: '{"global_cap": "5000000", "per_user_cap": "50000"}' },
  { label: 'Max Slippage', value: '', current: '0.02' },
  { label: 'Pool for Oracle and Liquidations', value: '', current: '{"pool_id": "123", "oracle": "oracle_addr"}' },
];



interface MarketCardProps {
  title: string;
  initialData: UpdateOverallMarket;
  onEditCollateral: () => void;
}

export function MarketCard({ title, initialData, onEditCollateral }: MarketCardProps) {
  const [data, setData] = useState<UpdateOverallMarket>(initialData);

  const handleChange = (field: keyof UpdateOverallMarket, value: any) => {
    setData((prev) => ({ ...prev, [field]: value }));
  };

  return (
    <Card width="400px">
      <CardHeader fontWeight="bold" fontSize="xl">
        {title}
      </CardHeader>

      <CardBody>
        <Stack spacing={4}>
          <FormControl>
            <FormLabel>Manager Fee</FormLabel>
            <Input
              value={data.manager_fee ?? ''}
              placeholder="Enter manager fee"
              onChange={(e) => handleChange('manager_fee', e.target.value)}
            />
          </FormControl>

          <FormControl>
            <FormLabel>Whitelisted Debt Suppliers (comma separated)</FormLabel>
            <Input
              value={data.whitelisted_debt_suppliers?.join(', ') ?? ''}
              placeholder="Enter addresses"
              onChange={(e) =>
                handleChange(
                  'whitelisted_debt_suppliers',
                  e.target.value.split(',').map((addr) => addr.trim())
                )
              }
            />
          </FormControl>

          <FormControl>
            <FormLabel>Debt Supply Cap</FormLabel>
            <Input
              value={data.debt_supply_cap ?? ''}
              placeholder="Enter debt supply cap"
              onChange={(e) => handleChange('debt_supply_cap', e.target.value)}
            />
          </FormControl>

          <FormControl>
            <FormLabel>Per User Debt Cap</FormLabel>
            <Input
              value={data.per_user_debt_cap ?? ''}
              placeholder="Enter per user debt cap"
              onChange={(e) => handleChange('per_user_debt_cap', e.target.value)}
            />
          </FormControl>

          <Checkbox
            isChecked={data.pause_actions ?? false}
            onChange={(e) => handleChange('pause_actions', e.target.checked)}
          >
            Pause Actions
          </Checkbox>
        </Stack>
      </CardBody>

      <CardFooter justifyContent="space-between" alignItems="center">
        <Button colorScheme="blue" onClick={() => console.log('Save:', data)}>
          Edit
        </Button>
        <Text
          as="button"
          fontSize="sm"
          color="white"
          fontWeight="bold"
          onClick={onEditCollateral}
        >
          Edit collateral →
        </Text>
      </CardFooter>
    </Card>
  );
}


export default function ManagePage() {

  const handleEditCollateral = () => {
    console.log('Swapping to edit collateral view...');
    // You can implement the view swap here
  };

  const defaultUpdateOverallMarket: UpdateOverallMarket = {
    pause_actions: false,
    manager_fee: '',
    whitelisted_debt_suppliers: [],
    debt_supply_cap: '',
    per_user_debt_cap: ''
  };

  return (
    <Box p={8}>
      <MarketCard
        title="E-Market"
        params={defaultUpdateOverallMarket}
        onEditCollateral={handleEditCollateral}
      />
    </Box>
  );
}
