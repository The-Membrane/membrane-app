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
} from '@chakra-ui/react';
import { ChevronDownIcon, CloseIcon, SearchIcon } from '@chakra-ui/icons';
import ConnectButton from '../WallectConnect/ConnectButton';

// Example filter options
const depositOptions = [
    'AUSD', 'cbBTC', 'crvUSD', 'DAI', 'EURCV', 'EURE', 'eUSD', 'FRAX', 'USDC', 'USDT', 'WBTC', 'WETH', 'stETH', 'LUSD', 'GUSD', 'TUSD', 'sUSD', 'BUSD', 'USD+', 'alUSD', 'MIM', 'RAI', 'USDP', 'USDN', 'FEI', 'RSV', 'XUSD', 'USDV', 'USDX', 'USDD', 'USDE', 'USDS', 'USDK', 'USDL', 'USDM', 'USDP', 'USDR', 'USDS', 'USDT', 'USDX', 'UST', 'VAI', 'ZUSD',
];

// Example table data
const exampleRows = [
    {
        asset: 'USDC',
        tvl: '$1.59M',
        vaultName: '9S Mount D...USDC Core',
        multiplier: '2.0x',
        cost: '0.15%'
    },
    {
        asset: 'DAI',
        tvl: '$957.9k',
        vaultName: '9S Mount K...uszko USR',
        multiplier: '1.5x',
        cost: '0.10%'
    },
    {
        asset: 'WETH',
        tvl: '$84.1k',
        vaultName: 'Alpha WETH Vault',
        multiplier: '3.0x',
        cost: '0.20%'
    },
    {
        asset: 'FRAX',
        tvl: '$200.07k',
        vaultName: 'Alpha ZCHF Safe Vault',
        multiplier: '1.2x',
        cost: '0.05%'
    },
    {
        asset: 'USDT',
        tvl: '$5.4M',
        vaultName: 'Apostro Resolv USDC',
        multiplier: '2.5x',
        cost: '0.18%'
    },
    {
        asset: 'cbBTC',
        tvl: '$168.29k',
        vaultName: 'Apostro Resolv USR',
        multiplier: '1.8x',
        cost: '0.12%'
    },
];

const EarnHero = () => {
    // State for filter dropdown
    const [selectedDeposits, setSelectedDeposits] = useState<string[]>(['All']);
    const [search, setSearch] = useState('');
    const { isOpen, onOpen, onClose } = useDisclosure();

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
        if (selectedDeposits.includes('All')) return exampleRows;
        return exampleRows.filter(row => selectedDeposits.includes(row.asset));
    }, [selectedDeposits]);

    return (
        <Box
            w="full"
            minH={{ base: '60vh', md: '70vh' }}
            bgGradient="linear(to-b, #181B23 60%, #181B23 100%)"
            borderRadius="2xl"
            px={{ base: 4, md: 12 }}
            py={{ base: 10, md: 20 }}
            display="flex"
            alignItems="center"
            justifyContent="space-between"
            flexDir={{ base: 'column', md: 'row' }}
            position="relative"
        >
            {/* Left: Headline and Connect Button */}
            <Stack spacing={8} maxW="lg" zIndex={2} align={{ base: 'center', md: 'flex-start' }}>
                <Box bg="#23252B" px={4} py={1} borderRadius="md" alignSelf={{ base: 'center', md: 'flex-start' }}>
                    <Text color="whiteAlpha.800" fontSize="sm">
                        Total Deposits <b>$4,000,765,306</b>
                    </Text>
                </Box>
                <Text
                    fontSize={{ base: '3xl', md: '5xl' }}
                    fontWeight="bold"
                    color="white"
                    lineHeight="1.1"
                >
                    Earn on<br />your terms
                </Text>
                <ConnectButton
                    size="lg"
                    borderRadius="2xl"
                    px={8}
                    py={6}
                    fontSize="lg"
                    bgGradient="linear(to-r, #3B5998, #4568DC)"
                    color="white"
                    _hover={{ bgGradient: 'linear(to-r, #4568DC, #3B5998)' }}
                >
                    Connect Wallet
                </ConnectButton>
            </Stack>
            {/* Right: 3D Illustration Placeholder */}
            <Box
                mt={{ base: 16, md: 0 }}
                flex="1"
                display="flex"
                alignItems="center"
                justifyContent="center"
                minW={{ base: '220px', md: '400px' }}
                minH={{ base: '220px', md: '400px' }}
            >
                {/* Placeholder for 3D illustration */}
                <Box
                    as="svg"
                    width={{ base: '220px', md: '340px' }}
                    height={{ base: '220px', md: '340px' }}
                    viewBox="0 0 340 340"
                    fill="none"
                >
                    <ellipse cx="170" cy="250" rx="120" ry="50" fill="#2B3A67" fillOpacity="0.7" />
                    <rect x="70" y="170" width="200" height="80" rx="20" fill="#3B5998" />
                    <ellipse cx="220" cy="120" rx="60" ry="80" fill="#4568DC" />
                </Box>
            </Box>
            {/* Table Header with Filter */}
            <HStack mb={6} justifyContent="flex-start" spacing={8}>
                <HStack>
                    <Text color="whiteAlpha.800" fontWeight="semibold">Deposit:</Text>
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
                            <PopoverContent bg="#23252B" color="white" minW="320px" border="none" boxShadow="xl">
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
            </HStack>
            {/* Table */}
            <Box bg="#23252B" borderRadius="lg" p={4}>
                <Table variant="unstyled" colorScheme="gray">
                    <Thead>
                        <Tr>
                            <Th color="whiteAlpha.700" fontWeight="semibold">Asset</Th>
                            <Th color="whiteAlpha.700" fontWeight="semibold">TVL</Th>
                            <Th color="whiteAlpha.700" fontWeight="semibold">Vault Name</Th>
                            <Th color="whiteAlpha.700" fontWeight="semibold">Multiplier</Th>
                            <Th color="whiteAlpha.700" fontWeight="semibold">Cost</Th>
                        </Tr>
                    </Thead>
                    <Tbody>
                        {filteredRows.map((row, idx) => (
                            <Tr key={idx} _hover={{ bg: '#232A3E' }}>
                                <Td color="white" fontWeight="medium">{row.asset}</Td>
                                <Td color="whiteAlpha.900">{row.tvl}</Td>
                                <Td color="whiteAlpha.900">{row.vaultName}</Td>
                                <Td color="whiteAlpha.900">{row.multiplier}</Td>
                                <Td color="whiteAlpha.900">{row.cost}</Td>
                            </Tr>
                        ))}
                    </Tbody>
                </Table>
                {filteredRows.length === 0 && (
                    <Text color="whiteAlpha.600" textAlign="center" py={8}>No results found.</Text>
                )}
            </Box>
        </Box>
    );
};

export default EarnHero; 