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
} from '@chakra-ui/react';
import { ChevronDownIcon, CloseIcon, SearchIcon, TriangleDownIcon, TriangleUpIcon } from '@chakra-ui/icons';
import ConnectButton from '../WallectConnect/ConnectButton';
import { useRouter } from 'next/router';
import { useMarketsTableData } from '@/hooks/useManaged';

// Example filter options
const depositOptions = [
    'USDC', 'DAI', 'WETH', 'FRAX', 'USDT', 'cbBTC'
];

// Helper to parse TVL string to number
function parseTvl(val: string): number {
    if (!val) return 0;
    let n = val.replace(/[$,]/g, '').toUpperCase();
    if (n.endsWith('M')) return parseFloat(n) * 1e6;
    if (n.endsWith('K')) return parseFloat(n) * 1e3;
    return parseFloat(n);
}

// Helper to parse Multiplier string to number
function parseMultiplier(val: string): number {
    if (!val) return 0;
    return parseFloat(val.replace('x', ''));
}

// Helper to parse Cost string to number
function parseCost(val: string): number {
    if (!val) return 0;
    return parseFloat(val.replace('%', ''));
}

const ManagedTable = () => {
    // Use real table data
    const tableData = useMarketsTableData();

    // State for filter dropdown
    const [selectedDeposits, setSelectedDeposits] = useState<string[]>(['All']);
    const [search, setSearch] = useState('');
    const { isOpen, onOpen, onClose } = useDisclosure();

    // Sorting state
    const [sortCol, setSortCol] = useState<'tvl' | 'multiplier' | 'cost' | null>(null);
    const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

    // Filtered options for search
    const filteredOptions = useMemo(() => {
        if (!search) return depositOptions;
        return depositOptions.filter(opt => opt.toLowerCase().includes(search.toLowerCase()));
    }, [search]);

    // Handle selection logic
    const handleSelect = (option: string) => {
        if (option === 'All') {
            setSelectedDeposits(['All']);
        } else {
            let newSelected = selectedDeposits.filter(s => s !== 'All');
            if (newSelected.includes(option)) {
                newSelected = newSelected.filter(s => s !== option);
            } else {
                newSelected = [...newSelected, option];
            }
            setSelectedDeposits(newSelected.length === 0 ? ['All'] : newSelected);
        }
    };

    // Displayed string for selected
    const selectedDisplay = useMemo(() => {
        if (selectedDeposits.includes('All')) return 'All';
        if (selectedDeposits.length <= 2) return selectedDeposits.join(', ');
        return `${selectedDeposits.slice(0, 2).join(', ')} & ${selectedDeposits.length - 2} more`;
    }, [selectedDeposits]);

    // Filter table rows by selectedDeposits
    const filteredRows = useMemo(() => {
        if (!tableData) return [];
        if (selectedDeposits.includes('All')) return tableData;
        return tableData.filter(row => selectedDeposits.includes(row.asset));
    }, [selectedDeposits, tableData]);

    // Sort rows if needed
    const sortedRows = useMemo(() => {
        if (!filteredRows) return [];
        if (!sortCol) return filteredRows;
        const rows = [...filteredRows];
        rows.sort((a, b) => {
            let aVal: number = 0, bVal: number = 0;
            if (sortCol === 'tvl') {
                aVal = parseTvl(a.tvl);
                bVal = parseTvl(b.tvl);
            } else if (sortCol === 'multiplier') {
                aVal = parseMultiplier(a.multiplier);
                bVal = parseMultiplier(b.multiplier);
            } else if (sortCol === 'cost') {
                aVal = parseCost(a.cost);
                bVal = parseCost(b.cost);
            }
            if (aVal === bVal) return 0;
            if (sortDir === 'asc') return aVal - bVal;
            return bVal - aVal;
        });
        return rows;
    }, [filteredRows, sortCol, sortDir]);

    // Handle header click
    const handleSort = (col: 'tvl' | 'multiplier' | 'cost') => {
        if (sortCol === col) {
            setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
        } else {
            setSortCol(col);
            setSortDir('desc');
        }
    };

    // Arrow icon for sort direction
    const sortArrow = (col: 'tvl' | 'multiplier' | 'cost') => {
        if (sortCol !== col) return null;
        return sortDir === 'asc' ? (
            <Icon as={TriangleUpIcon} ml={1} boxSize={3} />
        ) : (
            <Icon as={TriangleDownIcon} ml={1} boxSize={3} />
        );
    };

    const router = useRouter();

    // Handler for row click
    const handleRowClick = (row: any) => {
        // TODO: Replace '0x1234' and 'OSMO' with real market address and asset symbol from row when available
        router.push(`/0x1234/OSMO/multiply`);
        // router.push(`/${row.marketAddress}/${row.asset}/multiply`);
    };

    // Add loading and empty state handling
    if (tableData === undefined || tableData === null) {
        return <Box w="100vw" minH="100vh" display="flex" justifyContent="center" alignItems="center"><Spinner size="xl" color="white" /></Box>;
    }

    return (
        <Box w="100vw" minH="100vh" display="flex" justifyContent="center" alignItems="flex-start" py={{ base: 6, md: 12 }}>
            {/* Outer border effect container */}
            <Box
                w={{ base: '98vw' }}
                // maxW="1200px"
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
                        /* Custom scrollbar */
                        '&::-webkit-scrollbar': {
                            width: '8px',
                        },
                        '&::-webkit-scrollbar-thumb': {
                            background: '#232A3E',
                            borderRadius: '8px',
                        },
                        '&::-webkit-scrollbar-track': {
                            background: 'transparent',
                        },
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
                                                    onChange={() => handleSelect('All')}
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
                                                        onChange={() => handleSelect(opt)}
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
                                    <Th
                                        color="white"
                                        fontWeight="bold"
                                        fontSize="13px"
                                        cursor="pointer"
                                        onClick={() => handleSort('tvl')}
                                        userSelect="none"
                                    >
                                        TVL {sortArrow('tvl')}
                                    </Th>
                                    <Th color="white" fontWeight="bold" fontSize="13px">Vault Name</Th>
                                    <Th
                                        color="white"
                                        fontWeight="bold"
                                        fontSize="13px"
                                        cursor="pointer"
                                        onClick={() => handleSort('multiplier')}
                                        userSelect="none"
                                    >
                                        Multiplier {sortArrow('multiplier')}
                                    </Th>
                                    <Th
                                        color="white"
                                        fontWeight="bold"
                                        fontSize="13px"
                                        cursor="pointer"
                                        onClick={() => handleSort('cost')}
                                        userSelect="none"
                                    >
                                        Cost {sortArrow('cost')}
                                    </Th>
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
                                        <Tr
                                            key={idx}
                                            _hover={{
                                                bg: '#2D3748',
                                                boxShadow: '0 4px 16px 0 rgba(0,0,0,0.25)',
                                                cursor: 'pointer',
                                                transform: 'translateY(-2px) scale(1.01)',
                                                zIndex: 1,
                                            }}
                                            transition="all 0.15s cubic-bezier(.4,0,.2,1)"
                                            onClick={() => handleRowClick(row)}
                                        >
                                            <Td color="white" fontWeight="medium" fontSize="13px">{row.asset}</Td>
                                            <Td color="whiteAlpha.900" fontSize="13px">{row.tvl}</Td>
                                            <Td color="whiteAlpha.900" fontSize="13px">{row.vaultName}</Td>
                                            <Td color="whiteAlpha.900" fontSize="13px">{row.multiplier}</Td>
                                            <Td color="whiteAlpha.900" fontSize="13px">{row.cost}</Td>
                                        </Tr>
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

export default ManagedTable; 