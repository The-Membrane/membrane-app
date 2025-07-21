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
    Select,
    Tooltip,
    Modal,
    ModalOverlay,
    ModalContent,
    ModalHeader,
    ModalCloseButton,
    ModalBody,
    ModalFooter,
    FormControl,
    FormLabel,
    Slider,
    SliderTrack,
    SliderFilledTrack,
    SliderThumb,
    SliderMark,
    Switch,
    SimpleGrid,
} from '@chakra-ui/react';
import { ChevronDownIcon, CloseIcon, SearchIcon, TriangleDownIcon, TriangleUpIcon, RepeatIcon, InfoOutlineIcon } from '@chakra-ui/icons';
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
import { shiftDigits } from '@/helpers/math';
import { getManagedConfig, getTotalBorrowed } from '@/services/managed';
import { InterestRateModel, InterestRateModelProps, calculateCurrentInterestRate, getInterestRateModelPoints, OracleRow } from './ManagedMarketInfo';
import { useBalanceByAsset } from '@/hooks/useBalance';
import { CDT_ASSET } from '@/config/defaults';
import ConfirmModal from '@/components/ConfirmModal/ConfirmModal';
import useWallet from '@/hooks/useWallet';
import { useManagers } from '@/hooks/useManaged';
import MarketCreateSummary from './MarketCreateSummary';
import useMarketCreation from './hooks/useMarketCreation';
import { usePoolInfo } from '@/hooks/useOsmosis';
import { STATIC_ORACLE_POOLS } from '@/config/defaults';
import { useAssetBySymbol } from '@/hooks/useAssets';

export interface MarketCreateState {
    name: string;
    collateralAsset: string;
    maxBorrowLTV: string;
    liquidationLTV: string;
    borrowFee: string;
    socialLinks: string;
    managerAddress: string;
    maxSlippage: number;
    totalDebtSupplyCap: string | undefined;
    osmosisPoolId: string;
    // Interest rate model params
    baseRate: string;
    rateMax: string;
    postKinkRateMultiplier: string | undefined;
    kinkStartingPointRatio: string | undefined;
    enableKink: boolean;
}

// Helper to format TVL as $X.XXK/M
function formatTvl(val: number): string {
    if (isNaN(val)) return '$0';
    if (val >= 1e6) return `$${(val / 1e6).toFixed(2)}M`;
    if (val >= 1e3) return `$${(val / 1e3).toFixed(2)}K`;
    return `$${val.toFixed(2)}`;
}

// Define TWAPPoolInfo type at the top level
type TWAPPoolInfo = { pool_id: number; base_asset_denom: string; quote_asset_denom: string };

const ManagedTable = () => {
    const allMarkets = useAllMarkets();
    const { chainName } = useChainRoute();
    const { data: client } = useCosmWasmClient();
    const router = useRouter();
    // ...other top-level hooks as needed

    // State for filter dropdown
    const [selectedDeposits, setSelectedDeposits] = useState<string[]>(['All']);
    const [search, setSearch] = useState('');
    const [invalidPoolID, setInvalidPoolID] = useState(false);
    const { isOpen, onOpen, onClose } = useDisclosure();

    // Sorting state
    const [sortCol, setSortCol] = useState<'tvl' | 'multiplier' | 'cost' | null>(null);
    const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

    // New: Action selector state
    const [selectedAction, setSelectedAction] = useState<'multiply' | 'lend'>('multiply');

    // Modal state
    const { isOpen: isCreateOpen, onOpen: onCreateOpen, onClose: onCreateClose } = useDisclosure();
    // Get user address and managers (move above createMarketState for default)
    const { address: userAddress } = useWallet();
    const { data: managers } = useManagers();
    const isWhitelistedManager = managers && userAddress && managers.includes(userAddress);

    const cdtBalance = useBalanceByAsset(CDT_ASSET as Asset, userAddress);
    console.log('cdtBalance', cdtBalance);

    // Form state for market creation
    const [createMarketState, setCreateMarketState] = useState<MarketCreateState>({
        name: '',
        collateralAsset: '',
        maxBorrowLTV: '',
        liquidationLTV: '',
        borrowFee: '0',
        socialLinks: '',
        managerAddress: userAddress || '',
        maxSlippage: 1,
        totalDebtSupplyCap: undefined,
        osmosisPoolId: '',
        baseRate: '0',
        rateMax: '0',
        postKinkRateMultiplier: undefined,
        kinkStartingPointRatio: undefined,
        enableKink: false,
    });

    // Update managerAddress if userAddress changes while modal is open
    React.useEffect(() => {
        if (isCreateOpen && userAddress) {
            setCreateMarketState(s => ({ ...s, managerAddress: userAddress }));
        }
    }, [userAddress, isCreateOpen]);

    // Debounced osmosisPoolId input state
    const [osmosisPoolIdInput, setOsmosisPoolIdInput] = useState('');

    React.useEffect(() => {
        setOsmosisPoolIdInput(createMarketState.osmosisPoolId);
    }, [isCreateOpen]);
    React.useEffect(() => {
        const handler = setTimeout(() => {
            setCreateMarketState(s => ({ ...s, osmosisPoolId: osmosisPoolIdInput }));
        }, 500);
        return () => clearTimeout(handler);
    }, [osmosisPoolIdInput]);

    const { data: poolInfo } = usePoolInfo(createMarketState.osmosisPoolId);
    //Ensure token0 is the collateral asset
    const token0 = poolInfo?.pool?.poolAssets?.[0]?.token?.denom || poolInfo?.pool?.token0;
    const token1 = poolInfo?.pool?.poolAssets?.[1]?.token?.denom || poolInfo?.pool?.token1;
    const collateralAsset = useAssetBySymbol(createMarketState.collateralAsset);
    React.useEffect(() => {
        if (token0 !== collateralAsset?.base) {
            console.log('token0', token0, 'collateralAsset', collateralAsset?.base);
            setInvalidPoolID(true);
        } else {
            setInvalidPoolID(false);
        }
    }, [token0, collateralAsset]);

    // Extract inputted pool info and reset arrays if needed
    let allOraclePools: TWAPPoolInfo[] = [];
    let oracles: { name: string; logo: string; poolId: number }[] = [];
    if (createMarketState.osmosisPoolId && poolInfo?.pool) {
      const inputPoolId = poolInfo?.pool?.id || poolInfo?.pool?.poolId;
      const inputBaseDenom = poolInfo?.pool?.poolAssets?.[0]?.token?.denom || poolInfo?.pool?.token0;
      const inputQuoteDenom = poolInfo?.pool?.poolAssets?.[1]?.token?.denom || poolInfo?.pool?.token1;
      // Create TWAPPoolInfo for inputted pool
      const inputPoolTwap = inputPoolId && inputBaseDenom && inputQuoteDenom
        ? { pool_id: Number(inputPoolId), base_asset_denom: inputBaseDenom, quote_asset_denom: inputQuoteDenom }
        : null;
      if (inputPoolTwap) {
        // Only include static pools where base_asset_denom matches the input pool's quote_asset_denom
        const relevantStaticPools = STATIC_ORACLE_POOLS.filter(
            pool => pool.base_asset_denom === inputQuoteDenom
        );
        allOraclePools = [inputPoolTwap, ...relevantStaticPools];
      } else {
        allOraclePools = [];
      }
      // Build oracles array for OracleRow (like ManagedMarketInfo)
      if (allOraclePools.length > 0) {
        allOraclePools.forEach((pool, i) => {
          const isLast = i === allOraclePools.length - 1;
          const baseAsset = getAssetByDenom(pool.base_asset_denom, chainName);
          oracles.push({
            name: baseAsset?.symbol || pool.base_asset_denom,
            logo: baseAsset?.logo || '',
            poolId: pool.pool_id,
          });
          if (isLast) {
            const quoteAsset = getAssetByDenom(pool.quote_asset_denom, chainName);
            oracles.push({
              name: quoteAsset?.symbol || pool.quote_asset_denom,
              logo: quoteAsset?.logo || '',
              poolId: pool.pool_id,
            });
          }
        });
      }
    } else {
      allOraclePools = [];
      oracles = [];
    }

    const { action: createMarket } = useMarketCreation({
        marketCreateState: createMarketState,
        poolsForOsmoTwap: allOraclePools,
        collateralAsset: collateralAsset as Asset,
        isWhitelistedManager: isWhitelistedManager as boolean,
        run: true,
    });

    // Sticky points for slippage slider
    const slippageStickyPoints = [5, 10];
    const handleSlippageChange = (val: number) => {
        // Snap to sticky points if close
        const closest = slippageStickyPoints.find(pt => Math.abs(pt - val) < 1);
        setCreateMarketState(s => ({ ...s, maxSlippage: closest ?? val }));
    };

    // Interest rate model visualization
    // Defaults for IR model
    const baseRateNum = (Number(createMarketState.baseRate) || 0) / 100;
    let rateMaxNum = createMarketState.enableKink ? (Number(createMarketState.rateMax) || 0) / 100 : baseRateNum;
    let kinkMultiplierNum = createMarketState.enableKink ? (Number(createMarketState.postKinkRateMultiplier) || 1) : undefined;
    let kinkPointNum = createMarketState.enableKink ? (Number(createMarketState.kinkStartingPointRatio) || 1) / 100 : undefined;
    if (createMarketState.enableKink && !createMarketState.kinkStartingPointRatio) kinkPointNum = 1;
    if (createMarketState.enableKink && !createMarketState.postKinkRateMultiplier) kinkMultiplierNum = 1;
    const interestRateModelProps = {
        baseRate: baseRateNum,
        rateMax: rateMaxNum,
        kinkMultiplier: kinkMultiplierNum,
        kinkPoint: kinkPointNum,
        currentRatio: 0.5,
        showTitle: false,
    };

    // English description for the IR model
    let irModelDescription = '';
    if (!createMarketState.enableKink) {
        irModelDescription = `The rate is fixed at ${(baseRateNum * 100).toFixed(2)}%.`;
    } else if (createMarketState.enableKink && kinkPointNum === 1 && kinkMultiplierNum === 1) {
        irModelDescription = `The rate gradually increases to ${(rateMaxNum * 100).toFixed(2)}%.`;
    } else if (createMarketState.enableKink) {
        // Calculate max rate for description
        const maxRate = baseRateNum + ((1 - (kinkPointNum ?? 1)) * (kinkMultiplierNum ?? 1));
        irModelDescription = `This rate gradually increases to ${(baseRateNum * 100).toFixed(2)}% & then raises until ${(Math.min(maxRate, rateMaxNum) * 100).toFixed(2)}%.`;
    }

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

    // Fetch managed config and total borrowed for each market
    const configQueries = useQueries({
        queries: (allMarkets || []).map(market => ({
            queryKey: ['managed_market_config', market.address],
            queryFn: () => getManagedConfig(client, market.address),
            enabled: !!market && !!client,
        })),
    });
    const totalBorrowedQueries = useQueries({
        queries: (allMarkets || []).map(market => ({
            queryKey: ['managed_market_total_borrowed', market.address],
            queryFn: () => getTotalBorrowed(client, market.address),
            enabled: !!market && !!client,
        })),
    });

    // Build derived data array
    const derivedRows = useMemo(() => {
        if (!allMarkets) return [];
        return allMarkets.map((market, idx) => {
            const denom = market.params?.collateral_params?.collateral_asset;
            const asset = getAssetByDenom(denom, chainName);
            const price = parseFloat(priceQueries[idx]?.data?.price ?? '0');
            let cost = costQueries[idx]?.data ?? '0';
            let costObj: any = {};
            if (typeof cost === 'string') {
                try {
                    costObj = JSON.parse(cost);
                } catch {
                    costObj = {};
                }
            } else if (typeof cost === 'object' && cost !== null) {
                costObj = cost;
            }
            let multiplier = 1;
            try {
                multiplier = 1 / (1 - Number(market.params?.collateral_params.max_borrow_LTV || 0));
            } catch {
                multiplier = 1;
            }
            // TVL calculation
            const balance = parseFloat(balanceQueries[idx]?.data ?? '0');
            const tvl = balance * price;
            const tvlDisplay = formatTvl(tvl);

            // Lend-specific: get config and totalBorrowed
            const config = configQueries[idx]?.data;
            const totalBorrowed = totalBorrowedQueries[idx]?.data;
            let debtSupplied = 0;
            let debtUtilization = 0;
            if (config && config.total_debt_tokens) {
                debtSupplied = Number(shiftDigits(config.total_debt_tokens, -6));
                if (totalBorrowed && Number(config.total_debt_tokens) > 0) {
                    debtUtilization = Number(totalBorrowed) / Number(config.total_debt_tokens);
                }
            }
            const supplyApr = (Number(costObj.cost ?? cost) * debtUtilization * 0.95) || 0;
            return {
                market,
                assetSymbol: asset?.symbol ?? denom,
                assetLogo: asset?.logo ?? '',
                tvl, // numeric for sorting
                tvlDisplay, // formatted for display
                vaultName: market.name,
                multiplier,
                cost: Number(costObj.cost ?? cost),
                // Lend-specific fields
                debtSupplied,
                supplyApr,
            };
        });
    }, [allMarkets, chainName, priceQueries, costQueries, balanceQueries, configQueries, totalBorrowedQueries]);

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

    // Reset IR params to defaults
    const handleResetIRParams = () => {
        setCreateMarketState(s => ({
            ...s,
            baseRate: '0',
            rateMax: '0',
            postKinkRateMultiplier: undefined,
            kinkStartingPointRatio: undefined,
            enableKink: false,
        }));
    };

    // Add loading and empty state handling
    if (!allMarkets) {
        return <Box display="flex" justifyContent="center" alignItems="center"><Spinner size="xl" color="white" /></Box>;
    }

    return (
        <Box display="flex" flexDirection="column" alignItems="center" py={{ base: 6, md: 12 }}>
            {/* Top bar with Create Market button */}
            <Box w="100%" display="flex" justifyContent={{ base: 'center', md: 'flex-end' }} alignItems="center" mb={4} pr={{ base: 0, md: 16 }}>
                <Button
                    colorScheme="teal"
                    size="md"
                    fontWeight="bold"
                    onClick={onCreateOpen}
                    w={{ base: '60%', md: '20%' }}
                    alignSelf="flex-end"
                >
                    Create Market
                </Button>
            </Box>
            {/* Create Market Modal */}
            <Modal isOpen={isCreateOpen} onClose={onCreateClose} size="6xl" isCentered>
                <ModalOverlay />
                <ModalContent bg="#20232C" color="white" borderRadius="2xl" maxW="900px">
                    <ModalHeader fontWeight="bold">Create New Market</ModalHeader>
                    <ModalCloseButton />
                    <ModalBody>
                        <VStack spacing={6} align="stretch" w="100%">
                            {/* Centered Name Input */}
                            <Box w="100%" display="flex" justifyContent="center" alignItems="center">
                                <FormControl maxW="400px" w="100%">
                                    <Input
                                        placeholder="Market Name (ex: My BTC Market)"
                                        value={createMarketState.name}
                                        onChange={e => setCreateMarketState(s => ({ ...s, name: e.target.value }))}
                                        size="lg"
                                        fontWeight="bold"
                                        fontSize="2xl"
                                        textAlign="center"
                                        bg="#232A3E"
                                        color="white"
                                        borderRadius="xl"
                                        mb={2}
                                    />
                                </FormControl>
                            </Box>
                            <SimpleGrid columns={{ base: 1, md: 2 }} spacing={6}>
                                <FormControl>
                                    <FormLabel>Collateral Asset</FormLabel>
                                    <Input
                                        placeholder="Asset Symbol (ex: BTC)"
                                        value={createMarketState.collateralAsset}
                                        onChange={e => setCreateMarketState(s => ({ ...s, collateralAsset: e.target.value }))}
                                    />
                                </FormControl>
                                <FormControl>
                                    <FormLabel>Max Borrow LTV (%)</FormLabel>
                                    <Input
                                        type="number"
                                        placeholder="0.67"
                                        value={createMarketState.maxBorrowLTV}
                                        onChange={e => setCreateMarketState(s => ({ ...s, maxBorrowLTV: e.target.value }))}
                                    />
                                </FormControl>
                                <FormControl>
                                    <FormLabel>Liquidation LTV (%)</FormLabel>
                                    <Input
                                        type="number"
                                        placeholder="0.8"
                                        value={createMarketState.liquidationLTV}
                                        onChange={e => setCreateMarketState(s => ({ ...s, liquidationLTV: e.target.value }))}
                                    />
                                </FormControl>
                                <FormControl>
                                    <FormLabel>Borrow Fee (%)</FormLabel>
                                    <Input
                                        type="number"
                                        placeholder="0.01"
                                        value={createMarketState.borrowFee}
                                        onChange={e => setCreateMarketState(s => ({ ...s, borrowFee: e.target.value }))}
                                    />
                                </FormControl>
                                <FormControl>
                                    {/* <FormLabel>Osmosis Pool ID</FormLabel> */}
                                    <HStack spacing={1} align="center">
                                        <FormLabel
                                            as="a"
                                            href="https://app.osmosis.zone/pools"
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            // color="teal.300"
                                            cursor="pointer"
                                            mb={0}
                                            _hover={{ textDecoration: 'underline', color: 'teal.200' }}
                                        >
                                            Osmosis Pool ID for Collateral Asset
                                        </FormLabel>
                                        {/* <Tooltip
                                            label="Osmosis Pool ID for a pool with the collateral asset"
                                            hasArrow
                                            portal
                                        >
                                            <Box as="span" display="inline-flex" cursor="pointer" tabIndex={0}>
                                                <Icon as={InfoOutlineIcon} color="whiteAlpha.600" boxSize={4} />
                                            </Box>
                                        </Tooltip> */}
                                    </HStack>
                                    <Input
                                        placeholder="1234"
                                        value={osmosisPoolIdInput}
                                        onChange={e => setOsmosisPoolIdInput(e.target.value)}
                                    />
                                    {/* Oracle Pools Visual */}
                                    {oracles.length > 0 && (
                                      <Box mt={2} mb={2}>
                                        <OracleRow oracles={oracles} />
                                      </Box>
                                    )}
                                </FormControl>
                                <FormControl>
                                    <FormLabel>Social Link</FormLabel>
                                    <Input
                                        placeholder="https://..."
                                        value={createMarketState.socialLinks}
                                        onChange={e => setCreateMarketState(s => ({ ...s, socialLinks: e.target.value }))}
                                    />
                                </FormControl>
                                <FormControl>
                                    <FormLabel>Manager Address</FormLabel>
                                    <Input
                                        placeholder="osmo1..."
                                        value={createMarketState.managerAddress}
                                        onChange={e => setCreateMarketState(s => ({ ...s, managerAddress: e.target.value }))}
                                    />
                                </FormControl>
                                <FormControl>
                                    <FormLabel>Total Debt Supply Cap (CDT)</FormLabel>
                                    <Input
                                        type="number"
                                        placeholder="1000000"
                                        value={createMarketState.totalDebtSupplyCap}
                                        onChange={e => setCreateMarketState(s => ({ ...s, totalDebtSupplyCap: e.target.value }))}
                                    />
                                </FormControl>
                                <FormControl>
                                    <HStack align="center" mb={2}>
                                        <FormLabel mb={0}>Max Slippage (%)</FormLabel>
                                        <Input
                                            type="number"
                                            min={1}
                                            max={25}
                                            step={0.1}
                                            value={createMarketState.maxSlippage}
                                            onChange={e => handleSlippageChange(Number(e.target.value))}
                                            w="100px"
                                            bg="gray.800"
                                            color="white"
                                            textAlign="right"
                                        />
                                    </HStack>
                                    <Box px={2}>
                                        <Slider
                                            min={1}
                                            max={25}
                                            step={0.1}
                                            value={createMarketState.maxSlippage}
                                            onChange={handleSlippageChange}
                                            colorScheme="teal"
                                        >
                                            {slippageStickyPoints.map((pt, i) => (
                                                <SliderMark key={i} value={pt} mt="2" ml={pt === 3 ? "1" : pt === 5 ? "0.5" : pt === 10 ? "0" : "0"} fontSize="sm" color="whiteAlpha.700">
                                                    {pt}%
                                                </SliderMark>
                                            ))}
                                            <SliderMark value={25} mt="2" ml="-6" fontSize="sm" color="whiteAlpha.700">
                                                25%
                                            </SliderMark>
                                            <SliderTrack bg="gray.700">
                                                <SliderFilledTrack bg="teal.400" />
                                            </SliderTrack>
                                            <SliderThumb boxSize={6} />
                                        </Slider>
                                    </Box>
                                </FormControl>
                            </SimpleGrid>
                            {/* Interest Rate Model Section */}
                            <Box bg="#181C23" borderRadius="lg" p={4} mt={2}>
                                <HStack mb={2} spacing={2} align="center">
                                    <Text color="whiteAlpha.800" fontWeight="bold">Interest Rate Model</Text>
                                    <Switch
                                        isChecked={createMarketState.enableKink}
                                        onChange={e => {
                                            const enableKink = e.target.checked;
                                            setCreateMarketState(s => ({
                                                ...s,
                                                enableKink,
                                                postKinkRateMultiplier: enableKink ? (s.postKinkRateMultiplier ?? '') : undefined,
                                                kinkStartingPointRatio: enableKink ? (s.kinkStartingPointRatio ?? '') : undefined,
                                            }));
                                        }}
                                        colorScheme="teal"
                                        size="md"
                                    />
                                    <Text color="whiteAlpha.700" fontSize="sm">Enable Kink</Text>
                                    <Tooltip label="Reset IR Params">
                                        <IconButton
                                            aria-label="Reset IR Params"
                                            icon={<RepeatIcon />}
                                            size="xs"
                                            variant="ghost"
                                            onClick={handleResetIRParams}
                                            ml={1}
                                            minW={0}
                                            width="auto"
                                        />
                                    </Tooltip>
                                </HStack>
                                {/* Visualization */}
                                <Box w="100%" h="200px">
                                    <InterestRateModel {...interestRateModelProps} />
                                </Box>
                                <Box
                                    border="2px solid #3182ce"
                                    borderRadius="lg"
                                    boxShadow="0 0 8px 0 #3182ce55"
                                    p={3}
                                    mb={2}
                                    mt={2}
                                    bg="#20232C"
                                >
                                    <Text color="whiteAlpha.800" fontWeight="semibold">{irModelDescription}</Text>
                                </Box>
                                {/* 2x2 grid for params */}
                                <SimpleGrid columns={2} spacing={4} mt={4}>
                                    <FormControl>
                                        <FormLabel>Base Rate (%)</FormLabel>
                                        <Input
                                            type="number"
                                            placeholder="1"
                                            value={createMarketState.baseRate}
                                            onChange={e => {
                                                if (!createMarketState.enableKink) {
                                                    setCreateMarketState(s => ({ ...s, rateMax: e.target.value, baseRate: e.target.value }))
                                                } else {
                                                    setCreateMarketState(s => ({ ...s, baseRate: e.target.value }))
                                                }
                                            }}
                                        />
                                    </FormControl>
                                    <FormControl>
                                        <FormLabel>Max Rate (%)</FormLabel>
                                        <Input
                                            type="number"
                                            value={createMarketState.enableKink ? createMarketState.rateMax : createMarketState.baseRate}
                                            onChange={e => setCreateMarketState(s => ({ ...s, rateMax: e.target.value }))}
                                            disabled={!createMarketState.enableKink}
                                        />
                                    </FormControl>
                                    {createMarketState.enableKink && (
                                        <FormControl>
                                            <FormLabel>Post-Kink Rate Multiplier (ex: 1.00)</FormLabel>
                                            <Input
                                                type="number"
                                                placeholder="1.5"
                                                value={createMarketState.postKinkRateMultiplier ?? ''}
                                                onChange={e => setCreateMarketState(s => ({ ...s, postKinkRateMultiplier: e.target.value }))}
                                            />
                                        </FormControl>
                                    )}
                                    {createMarketState.enableKink && (
                                        <FormControl>
                                            <FormLabel>Kink Starting Point Ratio (%)</FormLabel>
                                            <Input
                                                type="number"
                                                placeholder="80"
                                                value={createMarketState.kinkStartingPointRatio ?? ''}
                                                onChange={e => setCreateMarketState(s => ({ ...s, kinkStartingPointRatio: e.target.value }))}
                                            />
                                        </FormControl>
                                    )}
                                </SimpleGrid>
                            </Box>
                        </VStack>
                        {/* Non-whitelisted manager notice above footer */}
                        {!isWhitelistedManager && (
                            <Text color="blue.300" fontWeight="bold" mt={4} justifySelf="center">
                                Non-whitelisted Managers pay 25 CDT that is supplied to the market
                            </Text>
                        )}
                    </ModalBody>
                    <ModalFooter gap={7}>
                        <Button onClick={onCreateClose} colorScheme="gray">Cancel</Button>
                        <ConfirmModal
                            label={invalidPoolID ? "Invalid Pool ID" : !isWhitelistedManager && Number(cdtBalance) < 25 ? "Need 25 CDT to Create" : !isWhitelistedManager ? "Create Market (25 CDT)" : "Create"}
                            action={createMarket}
                            isDisabled={invalidPoolID || (!isWhitelistedManager && Number(cdtBalance) < 25)}
                        >
                            <MarketCreateSummary
                                collateralAsset={createMarketState.collateralAsset}
                                maxBorrowLTV={createMarketState.maxBorrowLTV}
                                liquidationLTV={createMarketState.liquidationLTV}
                                borrowFee={createMarketState.borrowFee}
                                managerAddress={createMarketState.managerAddress}
                                maxSlippage={createMarketState.maxSlippage}
                                totalDebtSupplyCap={createMarketState.totalDebtSupplyCap ?? "Uncapped"}
                                osmosisPoolId={createMarketState.osmosisPoolId}
                                baseRate={createMarketState.baseRate}
                                rateMax={createMarketState.rateMax}
                                postKinkRateMultiplier={createMarketState.postKinkRateMultiplier ?? ''}
                                kinkStartingPointRatio={createMarketState.kinkStartingPointRatio ?? ''}
                                enableKink={createMarketState.enableKink}
                                isWhitelistedManager={!!isWhitelistedManager}
                            />
                        </ConfirmModal>
                    </ModalFooter>
                </ModalContent>
            </Modal>
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
                {/* Main content box – no scroll here (scroll only on table area) */}
                <Box
                    w="100%"
                    bg="#20232C"
                    borderRadius="2xl"
                    p={{ base: 4, md: 8 }}
                    minH="70vh"
                    maxH="80vh"
                    display="flex"
                    flexDirection="column"
                    alignItems="center"
                >
                    {/* Deposit Selector stacked on top */}
                    <Box w={{ base: '100%', md: '25%' }} mb={6} alignSelf={"start"} ml={"10%"}>
                        <HStack justifyContent="flex-start" alignItems="center" w="100%" alignSelf={"flex-end"} marginLeft={"1%"}>
                            {/* Action Selector */}
                            <Select
                                value={selectedAction}
                                onChange={e => setSelectedAction(e.target.value as 'multiply' | 'lend')}
                                bg="#23252B"
                                color="white"
                                borderRadius="md"
                                minW="fit-content"
                                w="fit-content"
                                fontWeight="bold"
                                _hover={{ bg: '#23252B' }}
                                size="sm"
                            >
                                <option value="multiply">Multiply</option>
                                <option value="lend">Lend</option>
                            </Select>
                            <Popover isOpen={isOpen} onOpen={onOpen} onClose={onClose} placement="bottom-start" closeOnBlur>
                                <PopoverTrigger>
                                    <Button
                                        rightIcon={<ChevronDownIcon />}
                                        bg="#23252B"
                                        color="white"
                                        borderRadius="md"
                                        minW="120px"
                                        w="50%"
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
                    {/* Scrollable table container */}
                    <Box
                        w={{ base: '100%', md: '85%' }}
                        mx="auto"
                        bg="#23252B"
                        borderRadius="lg"
                        p={4}
                        flex="1"
                        overflowY="auto"
                        overflowX="hidden"
                        sx={{
                            '&::-webkit-scrollbar': { width: '8px' },
                            '&::-webkit-scrollbar-thumb': { background: '#232A3E', borderRadius: '8px' },
                            '&::-webkit-scrollbar-track': { background: 'transparent' },
                        }}
                    >
                        <Table variant="unstyled" colorScheme="gray" fontSize="13px" sx={{ tableLayout: 'fixed', width: '100%' }}>
                            <Thead>
                                <Tr>
                                    <Th color="white" fontWeight="bold" fontSize={{ base: '12px', md: '13px' }}>Asset</Th>
                                    <Th display={{ base: 'none', md: 'table-cell' }} color="white" fontWeight="bold" fontSize="13px" cursor="pointer" onClick={() => handleSort('tvl')}>
                                        <Tooltip
                                            label={selectedAction === 'lend' ? 'Total Value Supplied' : 'Total Value Locked'}
                                            placement="top"
                                            hasArrow
                                            bg="#232A3E"
                                            color="white"
                                            borderRadius="2xl"
                                            p={3}
                                            fontSize="md"
                                        >
                                            <span>{selectedAction === 'lend' ? 'TVS' : 'TVL'} {sortArrow('tvl')}</span>
                                        </Tooltip>
                                    </Th>
                                    <Th display={{ base: 'none', md: 'table-cell' }} color="white" fontWeight="bold" fontSize={{ base: '12px', md: '13px' }}>Vault Name</Th>
                                    <Th color="white" fontWeight="bold" fontSize={{ base: '12px', md: '13px' }} cursor="pointer" onClick={() => handleSort('multiplier')}>
                                        {selectedAction === 'lend' ? 'Supply APR' : 'Multiplier'} {sortArrow('multiplier')}
                                    </Th>
                                    {selectedAction === 'multiply' && (
                                        <Th display={{ base: 'none', md: 'table-cell' }} color="white" fontWeight="bold" fontSize={{ base: '12px', md: '13px' }} cursor="pointer" onClick={() => handleSort('cost')}>
                                            Cost {sortArrow('cost')}
                                        </Th>
                                    )}
                                </Tr>
                            </Thead>
                            <Tbody>
                                {sortedRows.length === 0 ? (
                                    <Tr>
                                        <Td colSpan={selectedAction === 'lend' ? 4 : 5} textAlign="center" color="whiteAlpha.600" py={8}>
                                            No markets available
                                        </Td>
                                    </Tr>
                                ) : (
                                    sortedRows.map((row, idx) => (
                                        <MarketRow
                                            key={row.market.address || idx}
                                            {...row}
                                            selectedAction={selectedAction}
                                            onClick={() => router.push({
                                                pathname: `/${chainName}/isolated/${row.market.address}/${row.assetSymbol}`,
                                                query: { tab: selectedAction },
                                            }, undefined, { shallow: true })}
                                        />
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
    debtSupplied?: number;
    supplyApr?: number;
    selectedAction: 'multiply' | 'lend';
    onClick: () => void;
}

function MarketRow({ assetSymbol, assetLogo, tvlDisplay, vaultName, multiplier, cost, debtSupplied = 0, supplyApr = 0, selectedAction, onClick }: MarketRowProps) {
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
    function formatSupplyApr(val: number | string): string {
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
            {selectedAction === 'lend' ? (
                <Td display={{ base: 'none', md: 'table-cell' }} color="whiteAlpha.900" fontSize="13px">{formatTvl(debtSupplied)}</Td>
            ) : (
                <Td display={{ base: 'none', md: 'table-cell' }} color="whiteAlpha.900" fontSize="13px">{tvlDisplay}</Td>
            )}
            <Td display={{ base: 'none', md: 'table-cell' }} color="whiteAlpha.900" fontSize="13px">{vaultName}</Td>
            {selectedAction === 'lend' ? (
                <Td color="whiteAlpha.900" fontSize="13px">{formatSupplyApr(supplyApr)}</Td>
            ) : (
                <Td color="whiteAlpha.900" fontSize="13px">{formatMultiplier(multiplier)}</Td>
            )}
            {/* No 5th column for lend */}
            {selectedAction === 'multiply' && (
                <Td display={{ base: 'none', md: 'table-cell' }} color="whiteAlpha.900" fontSize="13px">{formatCost(cost)}</Td>
            )}
        </Tr>
    );
}

export default ManagedTable; 