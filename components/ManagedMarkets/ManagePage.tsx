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
import { Card, CardBody, CardFooter, CardHeader, Checkbox, FormControl, FormLabel, HStack, Input, Select, Stack, Text } from '@chakra-ui/react';
import { useEffect, useMemo } from 'react';
import useManagerState, { UpdateOverallMarket } from './hooks/useManagerState';
import { Box, Button, Flex, IconButton } from '@chakra-ui/react';
import { CloseIcon } from '@chakra-ui/icons';
import { useState } from 'react';
import { useAssetBySymbol } from '@/hooks/useAssets';
import { useManagedConfig, useManagedMarket, useMarketCollateralDenoms } from '@/hooks/useManaged';
import useAssets, { useAssetByDenom } from '@/hooks/useAssets';
import { useRouter } from 'next/router';
import { DEFAULT_CHAIN } from '@/config/chains';
import { getMarketName } from '@/services/managed';
import useUpdateMarket from './hooks/useUpdateMarket';
import ConfirmModal from '../ConfirmModal';
import ManagedMarketSummary from './ManagedMarketSummary';
import UpdateSummary from './UpdateSummary';
import useUpdateCollateral from './hooks/useUpdateCollateral';

export function WhitelistedAddressInput({
  value,
  onChange,
}: {
  value?: string[] | null;
  onChange: (newList: string[]) => void;
}) {
  const [input, setInput] = useState('');

  const handleAddAddress = () => {
    if (!input.trim()) return;
    const newList = [...(value || []), input.trim()];
    onChange(newList);
    setInput('');
  };

  const handleRemoveAddress = (index: number) => {
    if (!value) return;
    const newList = [...value];
    newList.splice(index, 1); // remove the item
    onChange(newList);
  };

  return (
    <Box>
      <Stack direction="row" mb={2}>
        <Input
          value={input}
          placeholder="Enter address"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleAddAddress();
            }
          }}
        />
        <Button onClick={handleAddAddress}>Add</Button>
      </Stack>

      <Stack spacing={1}>
        {(value || []).map((addr, idx) => (
          <Flex key={idx} align="center" justify="space-between" bg="gray.50" p={2} borderRadius="md">
            <Text fontSize="sm" color="gray.700" isTruncated maxW="80%">
              {addr}
            </Text>
            <IconButton
              size="sm"
              variant="ghost"
              colorScheme="red"
              aria-label="Remove address"
              icon={<CloseIcon boxSize={8} />}
              justifyContent={'end'}
              marginInlineEnd={"4%"}
              onClick={() => handleRemoveAddress(idx)}
            />
          </Flex>
        ))}
      </Stack>
    </Box>
  );
}

interface MarketCardProps {
  title: string;
  initialData: UpdateOverallMarket;
  marketContract: string;
}

export function MarketCard({ title, initialData, marketContract }: MarketCardProps) {
  const { managerState, setManagerState } = useManagerState();
  const [data, setData] = useState<UpdateOverallMarket>(initialData);
  const { action: updateMarket } = useUpdateMarket({
    marketContract: marketContract,
    managerState: managerState,
    run: true,
  });

  const handleChange = (field: keyof UpdateOverallMarket, value: any) => {
    setData((prev) => ({ ...prev, [field]: value }));
  };
  //on data change, update the manager state
  useEffect(() => {
    setManagerState({ updateOverallMarket: data });
  }, [data]);


  const isDisabled = useMemo(() => {
    return JSON.stringify(data) === JSON.stringify(initialData);
  }, [initialData, data]);

  return (
    <Card width="400px">
      <CardHeader fontWeight="bold" fontSize="xl">
        {title}
      </CardHeader>

      <CardBody>
        <Stack spacing={4}>
          <FormControl>
            <FormLabel>Manager Fee (%)</FormLabel>
            <Input
              value={data.manager_fee ?? ''}
              placeholder="Enter manager fee"
              onChange={(e) => handleChange('manager_fee', Number(e.target.value) / 100)}
            />
          </FormControl>

          <FormControl>
            <FormLabel>Debt Supply Cap</FormLabel>
            <Input
              value={data.debt_supply_cap ?? ''}
              placeholder="Enter debt supply cap (CDT)"
              onChange={(e) => handleChange('debt_supply_cap', e.target.value)}
            />
          </FormControl>

          <FormControl>
            <FormLabel>Whitelisted Debt Suppliers</FormLabel>
            <WhitelistedAddressInput
              value={data.whitelisted_debt_suppliers}
              onChange={(newList) => handleChange('whitelisted_debt_suppliers', newList)}
            />
          </FormControl>

          {data.pause_actions &&
            <Checkbox
              isChecked={data.pause_actions ?? false}
              onChange={(e) => handleChange('pause_actions', e.target.checked)}
            >
              Pause Actions
            </Checkbox>}
        </Stack>
      </CardBody>

      <CardFooter justifyContent="space-between" alignItems="center">
        <ConfirmModal
            label={"Edit Market"}
            action={updateMarket}
            isDisabled={isDisabled}
        >
            <UpdateSummary type="market" updateData={managerState.updateOverallMarket ?? {}} action={updateMarket.simulate} />
        </ConfirmModal>
      </CardFooter>
    </Card>
  );
}


interface WhitelistedCollateralSupplierInputProps {
  value?: string[] | null;
  onChange: (newList: string[]) => void;
}

export function WhitelistedCollateralSupplierInput({
  value,
  onChange,
}: WhitelistedCollateralSupplierInputProps) {
  const [input, setInput] = useState('');

  const handleAddSupplier = () => {
    if (!input.trim()) return;

    const newList = [...(value || []), input.trim()];
    onChange(newList);
    setInput(''); // Clear input after adding
  };

  const handleRemoveSupplier = (index: number) => {
    if (!value) return;

    const newList = [...value];
    newList.splice(index, 1); // Remove the supplier at index
    onChange(newList);
  };

  return (
    <Box>
      <Stack direction="row" mb={2}>
        <Input
          value={input}
          placeholder="Enter collateral supplier address"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleAddSupplier();
            }
          }}
        />
        <Button onClick={handleAddSupplier}>Add</Button>
      </Stack>

      <Stack spacing={1}>
        {(value || []).map((addr, idx) => (
          <Flex key={idx} align="center" justify="space-between" bg="gray.50" p={2} borderRadius="md">
            <Text fontSize="sm" color="gray.700" isTruncated maxW="80%">
              {addr}
            </Text>
            <IconButton
              size="sm"
              variant="ghost"
              colorScheme="red"
              aria-label="Remove supplier"
              icon={<CloseIcon boxSize={8} />}
              onClick={() => handleRemoveSupplier(idx)}
            />
          </Flex>
        ))}
      </Stack>
    </Box>
  );
}

export type UpdateCollateralParams = {
  collateral_denom: string;
  max_borrow_LTV?: string;
  liquidation_LTV?: any;
  rate_params?: any;
  borrow_fee?: string;
  whitelisted_collateral_suppliers?: string[] | null;
  borrow_cap?: any;
  max_slippage?: string;
  pool_for_oracle_and_liquidations?: any;
  per_user_debt_cap?: string;
  debt_minimum?: string;
};

interface CollateralCardProps {
  options: Option[];
  initialData: UpdateCollateralParams;
  marketContract: string;
}

interface Option {
  label: string;
  value: string;
}

export function CollateralCard({ options, initialData, marketContract }: CollateralCardProps) {
  const { managerState, setManagerState } = useManagerState();
  const [data, setData] = useState<UpdateCollateralParams>(initialData);
  // console.log("options", options, options[0]);
  const [selectedCollateral, setSelectedCollateral] = useState(options[0] || { label: '', value: '' });
  
  useEffect(() => {
    if (options.length > 0) {
      setSelectedCollateral(options[0]);
    }
  }, [options]);
  // Move hook call to top level
  const asset = useAssetBySymbol(selectedCollateral.label);

  // Use the update collateral action
  // console.log("selectedCollateral", selectedCollateral.value);
  const { action: updateCollateral } = useUpdateCollateral({
    collateralDenom: selectedCollateral.value,
    marketContract: marketContract,
    managerState: managerState,
    run: true,
  });

  const handleChange = (field: keyof UpdateCollateralParams, value: any) => {
    setData((prev) => ({ ...prev, [field]: value }));
  };

  // Update manager state when data changes
  useEffect(() => {
    setManagerState({ updateCollateralParams: data });
  }, [data]);

  const isDisabled = useMemo(() => {
    return JSON.stringify(data) === JSON.stringify(initialData);
  }, [initialData, data]);

  useEffect(() => {
    if (asset) {
      setData((prev) => ({
        ...prev,
        collateral_denom: asset.base,
      }));
    }
  }, [asset]);

  return (
    <Card width="400px">
      <CardHeader>
        <FormControl>
          <FormLabel>Collateral</FormLabel>
          <div style={{ 
            width: "fit-content", 
            alignSelf: "center", 
            marginTop: "3%" 
          }}><Select 
            options={options} 
            onChange={
              (e) => {
                const opt = options.find(o => o.label === e.target.value);
                if (opt) setSelectedCollateral(opt);
              }
            } 
            value={selectedCollateral.label} />
          </div>
        </FormControl>
      </CardHeader>

      <CardBody>
        <Stack spacing={4}>
          <FormControl>
            <FormLabel>Max Borrow LTV (as %)</FormLabel>
            <Input
              value={data.max_borrow_LTV !== undefined && data.max_borrow_LTV !== '' ? String(Number(data.max_borrow_LTV) * 100) : ''}
              placeholder="Enter max borrow LTV (as %)"
              onChange={(e) => handleChange('max_borrow_LTV', e.target.value === '' ? '' : String(Number(e.target.value) / 100))}
            />
          </FormControl>

          <FormControl>
            <FormLabel>Borrow Fee (as %)</FormLabel>
            <Input
              value={data.borrow_fee !== undefined && data.borrow_fee !== '' ? String(Number(data.borrow_fee) * 100) : ''}
              placeholder="Enter borrow fee (as %)"
              onChange={(e) => handleChange('borrow_fee', e.target.value === '' ? '' : String(Number(e.target.value) / 100))}
            />
          </FormControl>

          <FormControl>
            <FormLabel>Whitelisted Collateral Suppliers</FormLabel>
            <WhitelistedCollateralSupplierInput
              value={data.whitelisted_collateral_suppliers}
              onChange={(newList) => handleChange('whitelisted_collateral_suppliers', newList)}
            />
          </FormControl>

          <FormControl>
            <FormLabel>Per User Debt Cap</FormLabel>
            <Input
              value={data.per_user_debt_cap ?? ''}
              placeholder="Enter per user debt cap (CDT)"
              onChange={(e) => handleChange('per_user_debt_cap', e.target.value)}
            />
          </FormControl>

          <FormControl>
            <FormLabel>Debt Minimum</FormLabel>
            <Input
              value={data.debt_minimum ?? ''}
              placeholder="Enter debt minimum (CDT)"
              onChange={(e) => handleChange('debt_minimum', e.target.value)}
            />
          </FormControl>

          <FormControl>
            <FormLabel>Max Slippage</FormLabel>
            <Input
              value={data.max_slippage ?? ''}
              placeholder="Enter max slippage (decimal)"
              onChange={(e) => handleChange('max_slippage', e.target.value)}
            />
          </FormControl>

          <FormControl>
            <FormLabel>Liquidation LTV (as %)</FormLabel>
            <Input
              value={data.liquidation_LTV?.end_ltv !== undefined && data.liquidation_LTV?.end_ltv !== '' ? String(Number(data.liquidation_LTV.end_ltv) * 100) : ''}
              placeholder="Enter liquidation LTV (as %)"
              onChange={(e) => handleChange('liquidation_LTV', { ...data.liquidation_LTV, end_ltv: e.target.value === '' ? '' : String(Number(e.target.value) / 100) })}
            />
          </FormControl>

          <FormControl>
            <FormLabel>Rate Params (base_rate, rate_max, [rate_multiplier, kink_starting_point_ratio])</FormLabel>
            <Input
              value={data.rate_params ? [data.rate_params.base_rate, data.rate_params.rate_max, data.rate_params.rate_kink?.rate_mulitplier, data.rate_params.rate_kink?.kink_starting_point_ratio].filter(Boolean).join(',') : ''}
              placeholder="e.g. 0.01,0.2,0.5,0.8"
              onChange={(e) => {
                const parts = e.target.value.split(',').map(s => s.trim());
                const [base_rate, rate_max, rate_mulitplier, kink_starting_point_ratio] = parts;
                let rate_params: any = {};
                if (base_rate) rate_params.base_rate = base_rate;
                if (rate_max) rate_params.rate_max = rate_max;
                if (rate_mulitplier && kink_starting_point_ratio) {
                  rate_params.rate_kink = { rate_mulitplier, kink_starting_point_ratio };
                }
                handleChange('rate_params', Object.keys(rate_params).length ? rate_params : undefined);
              }}
            />
          </FormControl>

          <FormControl>
            <FormLabel>Borrow Cap (fixed_cap, cap_borrows_by_liquidity)</FormLabel>
            <Input
              value={data.borrow_cap ? [data.borrow_cap.fixed_cap, data.borrow_cap.cap_borrows_by_liquidity].filter(v => v !== undefined).join(',') : ''}
              placeholder="e.g. 1000000,true"
              onChange={(e) => {
                const [fixed_cap, cap_borrows_by_liquidity] = e.target.value.split(',').map(s => s.trim());
                let borrow_cap: any = {};
                if (fixed_cap) borrow_cap.fixed_cap = fixed_cap;
                if (cap_borrows_by_liquidity !== undefined) borrow_cap.cap_borrows_by_liquidity = cap_borrows_by_liquidity === 'true';
                handleChange('borrow_cap', Object.keys(borrow_cap).length ? borrow_cap : undefined);
              }}
            />
          </FormControl>

          <FormControl>
            <FormLabel>Pool IDs for Oracle and Liquidations (comma separated)</FormLabel>
            <Input
              value={data.pool_for_oracle_and_liquidations ? (Array.isArray(data.pool_for_oracle_and_liquidations) ? data.pool_for_oracle_and_liquidations.map((p: any) => p.poolId).join(',') : data.pool_for_oracle_and_liquidations) : ''}
              placeholder="e.g. 1,2,3"
              onChange={(e) => handleChange('pool_for_oracle_and_liquidations', e.target.value)}
            />
          </FormControl>
        </Stack>
      </CardBody>

      <CardFooter justifyContent="space-between" alignItems="center">
        <ConfirmModal
          label={"Edit Collateral"}
          action={updateCollateral}
          isDisabled={isDisabled}
        >
          <UpdateSummary type="collateral" updateData={managerState.updateCollateralParams ?? { collateral_denom: '' }} action={updateCollateral.simulate} />
        </ConfirmModal>
        {/* <Text
          as="button"
          fontSize="sm"
          color="white"
          fontWeight="bold"
          onClick={onEditMarket}
        >
          ← Edit market
        </Text> */}
      </CardFooter>
    </Card>
  );
}

interface ManagePageProps {
  marketAddress?: string;
}

const ManagePage: React.FC<ManagePageProps> = ({ marketAddress }) => {
  const router = useRouter();
  const chainName = router.query.chainName as string || DEFAULT_CHAIN;
  // const handleEditCollateral = () => {
  //   console.log('Swapping to edit collateral view...');
  //   // You can implement the view swap here
  // };
  // const handleEditMarket = () => {
  //   console.log('Swapping to edit market view...');
  //   // You can implement the view swap here
  // };

  // Get market name
  const marketName = getMarketName(marketAddress as string);
  
  // Fetch all assets for the selected chain
  const assets = useAssets(chainName);
  // Fetch supported collateral denoms for this market
  const { data: collateralDenoms } = useMarketCollateralDenoms(marketAddress || '');
  // console.log("collateralDenoms", collateralDenoms);

  // Map denoms to asset info for options
  const collateralOptions = useMemo(() => {
    if (!assets || !collateralDenoms) return [];
    return collateralDenoms.map(denom => {
      const asset = assets.find(a => a.base === denom);
      return asset ? { label: asset.symbol, value: asset.base } : { label: denom, value: denom };
    });
  }, [assets, collateralDenoms]);
  console.log("collateralOptions", collateralOptions);


  const defaultUpdateOverallMarket: UpdateOverallMarket = {
    pause_actions: false,
    manager_fee: '',
    whitelisted_debt_suppliers: [],
    debt_supply_cap: '',
  };

  return (
    <HStack spacing={4} direction="row" align="stretch">
      <Box p={8}>
        <MarketCard
          title={marketName}
          initialData={defaultUpdateOverallMarket}
          marketContract={marketAddress || ''}
          // onEditCollateral={handleEditCollateral}
        />
      </Box>
      <Box p={8}>
        <CollateralCard
          options={collateralOptions}
          initialData={{ collateral_denom: collateralOptions[0]?.value || '' }}
          marketContract={marketAddress || ''}
          // onEditMarket={handleEditMarket}
        />
      </Box>
    </HStack>
  );
};

export default ManagePage;
