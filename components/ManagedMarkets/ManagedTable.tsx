import React, { useState, useMemo } from 'react';
import {
    Box,
    HStack,
    Stack,
    Text,
    Input,
    Tag,
    TagLabel,
    TagCloseButton,
    Button,
    VStack,
    Checkbox,
    CheckboxGroup,
    useDisclosure,
    Popover,
    PopoverTrigger,
    PopoverContent,
    PopoverBody,
    PopoverArrow,
    PopoverCloseButton,
    PopoverHeader,
    Table,
    Thead,
    Tbody,
    Tr,
    Th,
    Td,
    IconButton,
    Menu,
    MenuButton,
    MenuList,
    MenuItem,
    Portal,
    Icon,
    Spinner,
    Image,
} from '@chakra-ui/react';
import { ChevronDownIcon, CloseIcon, SearchIcon, TriangleDownIcon, TriangleUpIcon } from '@chakra-ui/icons';
import ConnectButton from '../WallectConnect/ConnectButton';
import { useRouter } from 'next/router';
import { getAssetByDenom } from '@/helpers/chain';
import type { Asset } from '@/helpers/chain';
import { useAllMarkets } from '@/hooks/useManaged';
import { useChainRoute } from '@/hooks/useChainRoute';
import { num } from '@/helpers/num';
import { useQueries } from '@tanstack/react-query';
import { getMarketCollateralPrice, getMarketCollateralCost, getMarketBalance } from '@/services/managed';
import { useCosmWasmClient } from '@/helpers/cosmwasmClient';

// Helper to format TVL as $X.XXK/M
function formatTvl(val: number): string {
    if (isNaN(val)) return '$0';
    if (val >= 1e6) return `$${(val / 1e6).toFixed(2)}M`;
    if (val >= 1e3) return `$${(val / 1e3).toFixed(2)}K`;
    return `$${val.toFixed(2)}`;
}

const ManagedTable = () => {
    const allMarkets = useAllMarkets();
    const { chainName } = useChainRoute();
    const { data: client } = useCosmWasmClient();
    const router = useRouter();
    // ...other top-level hooks as needed

    // State for filter dropdown
    const [selectedDeposits, setSelectedDeposits] = useState<string[]>(['All']);
    const [search, setSearch] = useState('');
    const { isOpen, onOpen, onClose } = useDisclosure();

    // Sorting state
    const [sortCol, setSortCol] = useState<'tvl' | 'multiplier' | 'cost' | null>(null);
    const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

    // Sorting handler
    const handleSort = (col: 'tvl' | 'multiplier' | 'cost') => {
        if (sortCol === col) {
            if (sortDir === 'desc') {
                setSortDir('asc');
            } else if (sortDir === 'asc') {
                setSortCol(null);
                setSortDir('desc'); // or null, but keep as 'desc' for default
            }
        } else {
            setSortCol(col);
            setSortDir('desc');
        }
    };

    // Dynamically get deposit options from allMarkets
    const depositOptions = useMemo(() => {
        if (!allMarkets) return [];
        // Get unique asset symbols from allMarkets
        const symbols = allMarkets.map(market => {
            const denom = market.params?.collateral_params?.collateral_asset;
            const asset = getAssetByDenom(denom, chainName);
            return asset?.symbol ?? denom;
        });
        // Remove duplicates and falsy values
        return Array.from(new Set(symbols.filter(Boolean)));
    }, [allMarkets, chainName]);

    // Filtered options for search
    const filteredOptions = useMemo(() => {
        if (!search) return depositOptions;
        return depositOptions.filter(opt => opt.toLowerCase().includes(search.toLowerCase()));
    }, [search, depositOptions]);

    // Displayed string for selected
    const selectedDisplay = useMemo(() => {
        if (selectedDeposits.includes('All')) return 'All';
        if (selectedDeposits.length <= 2) return selectedDeposits.join(', ');
        return `${selectedDeposits.slice(0, 2).join(', ')} & ${selectedDeposits.length - 2} more`;
    }, [selectedDeposits]);

    // Prepare queries for all markets
    const priceQueries = useQueries({
        queries: (allMarkets || []).map(market => {
            const denom = market.params?.collateral_params?.collateral_asset;
            return {
                queryKey: ['managed_market_collateral_price', client, market.address, denom],
                queryFn: () => getMarketCollateralPrice(client, market.address, denom),
                enabled: !!market && !!client,
            };
        }),
    });
    const costQueries = useQueries({
        queries: (allMarkets || []).map(market => {
            const denom = market.params?.collateral_params?.collateral_asset;
            return {
                queryKey: ['managed_market_collateral_cost', client, market.address, denom],
                queryFn: () => getMarketCollateralCost(client!, market.address, denom),
                enabled: !!market && !!client,
            };
        }),
    });
    // Add balance queries for TVL
    const balanceQueries = useQueries({
        queries: (allMarkets || []).map(market => {
            const denom = market.params?.collateral_params?.collateral_asset;
            const asset = getAssetByDenom(denom, chainName);
            return {
                queryKey: ['market_balance', chainName, market.address, denom, client],
                queryFn: () => getMarketBalance(client!, asset as Asset, market.address),
                enabled: !!asset && !!market && !!chainName && !!market.address && !!client,
            };
        }),
    });

    // Build derived data array
    const derivedRows = useMemo(() => {
        if (!allMarkets) return [];
        return allMarkets.map((market, idx) => {
            const denom = market.params?.collateral_params?.collateral_asset;
            const asset = getAssetByDenom(denom, chainName);
            const price = parseFloat(priceQueries[idx]?.data?.price ?? '0');
            const cost = costQueries[idx]?.data ?? '0';
            let multiplier = 1;
            try {
                multiplier = 1 / (1 - Number(market.params?.collateral_params.max_borrow_LTV || 0));
            } catch {
                multiplier = 1;
            }
            // TVL calculation
            const balance = parseFloat(balanceQueries[idx]?.data ?? '0');
            const tvl = balance * price;
            console.log('tvl', tvl, balanceQueries, price);
            const tvlDisplay = formatTvl(tvl);
            return {
                market,
                assetSymbol: asset?.symbol ?? denom,
                assetLogo: asset?.logo ?? '',
                tvl, // numeric for sorting
                tvlDisplay, // formatted for display
                vaultName: market.name,
                multiplier,
                cost,
            };
        });
    }, [allMarkets, chainName, priceQueries, costQueries, balanceQueries]);

    // Filtering
    const filteredRows = useMemo(() => {
        if (!derivedRows) return [];
        if (selectedDeposits.includes('All')) return derivedRows;
        return derivedRows.filter(row => selectedDeposits.includes(row.assetSymbol));
    }, [derivedRows, selectedDeposits]);

    // Sorting
    const sortedRows = useMemo(() => {
        if (!filteredRows) return [];
        if (!sortCol) return filteredRows;
        const rows = [...filteredRows];
        rows.sort((a, b) => {
            let aVal: number = 0, bVal: number = 0;
            if (sortCol === 'tvl') {
                aVal = typeof a.tvl === 'number' ? a.tvl : parseFloat(a.tvl);
                bVal = typeof b.tvl === 'number' ? b.tvl : parseFloat(b.tvl);
            } else if (sortCol === 'multiplier') {
                aVal = typeof a.multiplier === 'number' ? a.multiplier : parseFloat(a.multiplier);
                bVal = typeof b.multiplier === 'number' ? b.multiplier : parseFloat(b.multiplier);
            } else if (sortCol === 'cost') {
                aVal = typeof a.cost === 'number' ? a.cost : parseFloat(a.cost);
                bVal = typeof b.cost === 'number' ? b.cost : parseFloat(b.cost);
            }
            if (aVal === bVal) return 0;
            if (sortDir === 'asc') return aVal - bVal;
            return bVal - aVal;
        });
        return rows;
    }, [filteredRows, sortCol, sortDir]);

    // Arrow icon for sort direction
    const sortArrow = (col: 'tvl' | 'multiplier' | 'cost') => {
        if (sortCol !== col) return null;
        return sortDir === 'asc' ? (
            <Icon as={TriangleUpIcon} ml={1} boxSize={3} />
        ) : (
            <Icon as={TriangleDownIcon} ml={1} boxSize={3} />
        );
    };

    // Add loading and empty state handling
    if (!allMarkets) {
        return <Box w="100vw" minH="100vh" display="flex" justifyContent="center" alignItems="center"><Spinner size="xl" color="white" /></Box>;
    }

    return (
        <Box w="100vw" minH="100vh" display="flex" justifyContent="center" alignItems="flex-start" py={{ base: 6, md: 12 }}>
            {/* Outer border effect container */}
            <Box
                w={{ base: '98vw' }}
                borderRadius="2xl"
                p={{ base: 1.5, md: 2.5 }}
                bgGradient="linear(135deg, #232A3E 0%, #232A3E 100%)"
                display="flex"
                justifyContent="center"
                alignItems="center"
                boxShadow="0 0 0 4px #232A3E"
            >
                {/* Main content box with scrollable area */}
                <Box
                    w="100%"
                    bg="#20232C"
                    borderRadius="2xl"
                    p={{ base: 4, md: 8 }}
                    minH="70vh"
                    maxH="80vh"
                    overflowY="auto"
                    sx={{
                        '&::-webkit-scrollbar': { width: '8px' },
                        '&::-webkit-scrollbar-thumb': { background: '#232A3E', borderRadius: '8px' },
                        '&::-webkit-scrollbar-track': { background: 'transparent' },
                    }}
                    display="flex"
                    flexDirection="column"
                    alignItems="center"
                >
                    {/* Deposit Selector stacked on top */}
                    <Box w={{ base: '100%', md: '25%' }} mb={6} alignSelf={"start"} ml={"10%"}>
                        <HStack justifyContent="flex-start" alignItems="center" w="100%" alignSelf={"flex-end"} marginLeft={"1%"}>
                            <Text color="white" fontWeight="bold">Multiply:</Text>
                            <Popover isOpen={isOpen} onOpen={onOpen} onClose={onClose} placement="bottom-start" closeOnBlur>
                                <PopoverTrigger>
                                    <Button
                                        rightIcon={<ChevronDownIcon />}
                                        bg="#23252B"
                                        color="white"
                                        borderRadius="md"
                                        minW="120px"
                                        _hover={{ bg: '#23252B' }}
                                        onClick={onOpen}
                                    >
                                        {selectedDisplay}
                                    </Button>
                                </PopoverTrigger>
                                <Portal>
                                    <PopoverContent bg="#23252B" color="white" minW="220px" border="none" boxShadow="xl">
                                        <PopoverArrow bg="#23252B" />
                                        <PopoverCloseButton />
                                        <PopoverHeader borderBottom="1px solid #333" pb={2}>
                                            <Input
                                                placeholder="Search for deposit asset"
                                                value={search}
                                                onChange={e => setSearch(e.target.value)}
                                                bg="#23252B"
                                                color="white"
                                                borderColor="#333"
                                                _placeholder={{ color: 'whiteAlpha.600' }}
                                                size="sm"
                                                mb={2}
                                                autoFocus
                                            />
                                        </PopoverHeader>
                                        <PopoverBody maxH="300px" overflowY="auto" px={0}>
                                            <VStack align="stretch" spacing={0}>
                                                <Checkbox
                                                    colorScheme="blue"
                                                    isChecked={selectedDeposits.includes('All')}
                                                    onChange={() => setSelectedDeposits(['All'])}
                                                    px={4}
                                                    py={2}
                                                >
                                                    All
                                                </Checkbox>
                                                {filteredOptions.map(opt => (
                                                    <Checkbox
                                                        key={opt}
                                                        colorScheme="blue"
                                                        isChecked={selectedDeposits.includes(opt)}
                                                        onChange={() => {
                                                            let newSelected = selectedDeposits.filter(s => s !== 'All');
                                                            if (newSelected.includes(opt)) {
                                                                newSelected = newSelected.filter(s => s !== opt);
                                                            } else {
                                                                newSelected = [...newSelected, opt];
                                                            }
                                                            setSelectedDeposits(newSelected.length === 0 ? ['All'] : newSelected);
                                                        }}
                                                        px={4}
                                                        py={2}
                                                    >
                                                        {opt}
                                                    </Checkbox>
                                                ))}
                                            </VStack>
                                        </PopoverBody>
                                    </PopoverContent>
                                </Portal>
                            </Popover>
                        </HStack>
                    </Box>
                    {/* Table centered and 85% width */}
                    <Box w={{ base: '100%', md: '85%' }} mx="auto" bg="#23252B" borderRadius="lg" p={4}>
                        <Table variant="unstyled" colorScheme="gray" fontSize="13px">
                            <Thead>
                                <Tr>
                                    <Th color="white" fontWeight="bold" fontSize="13px">Asset</Th>
                                    <Th color="white" fontWeight="bold" fontSize="13px" cursor="pointer" onClick={() => handleSort('tvl')}>TVL {sortArrow('tvl')}</Th>
                                    <Th color="white" fontWeight="bold" fontSize="13px">Vault Name</Th>
                                    <Th color="white" fontWeight="bold" fontSize="13px" cursor="pointer" onClick={() => handleSort('multiplier')}>Multiplier {sortArrow('multiplier')}</Th>
                                    <Th color="white" fontWeight="bold" fontSize="13px" cursor="pointer" onClick={() => handleSort('cost')}>Cost {sortArrow('cost')}</Th>
                                </Tr>
                            </Thead>
                            <Tbody>
                                {sortedRows.length === 0 ? (
                                    <Tr>
                                        <Td colSpan={5} textAlign="center" color="whiteAlpha.600" py={8}>
                                            No markets available
                                        </Td>
                                    </Tr>
                                ) : (
                                    sortedRows.map((row, idx) => (
                                        <MarketRow key={row.market.address || idx} {...row} onClick={() => router.push({
                                            pathname: `/${chainName}/managed/${row.market.address}/${row.assetSymbol}`,
                                            query: { tab: 'multiply' }
                                        }, undefined, { shallow: true })} />
                                    ))
                                )}
                            </Tbody>
                        </Table>
                    </Box>
                </Box>
            </Box>
        </Box>
    );
};

// Add types for MarketRow props
interface MarketRowProps {
    market: any;
    assetSymbol: string;
    assetLogo: string;
    tvl: number;
    tvlDisplay: string;
    vaultName: string;
    multiplier: number | string;
    cost: number | string;
    onClick: () => void;
}

function MarketRow({ assetSymbol, assetLogo, tvlDisplay, vaultName, multiplier, cost, onClick }: MarketRowProps) {
    function formatMultiplier(val: number | string): string {
        let n = typeof val === 'number' ? val : parseFloat(val as string);
        if (isNaN(n)) return '0x';
        return `${n.toFixed(2)}x`;
    }
    function formatCost(val: number | string): string {
        let n = typeof val === 'number' ? val : parseFloat(val as string);
        if (isNaN(n)) return '0%';
        return `${(n * 100).toFixed(2)}%`;
    }
    return (
        <Tr onClick={onClick} _hover={{ bg: '#2D3748', cursor: 'pointer' }}>
            <Td color="white" fontWeight="medium" fontSize="13px">
                <HStack spacing={2}>
                    {assetLogo && <Image src={assetLogo} alt={assetSymbol} boxSize="20px" borderRadius="full" bg="#181C23" />}
                    <span>{assetSymbol}</span>
                </HStack>
            </Td>
            <Td color="whiteAlpha.900" fontSize="13px">{tvlDisplay}</Td>
            <Td color="whiteAlpha.900" fontSize="13px">{vaultName}</Td>
            <Td color="whiteAlpha.900" fontSize="13px">{formatMultiplier(multiplier)}</Td>
            <Td color="whiteAlpha.900" fontSize="13px">{formatCost(cost)}</Td>
        </Tr>
    );
}

export default ManagedTable; 