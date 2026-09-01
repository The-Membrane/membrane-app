import { useState, useMemo } from 'react';
import { useDisclosure } from '@chakra-ui/react';
import { getAssetByDenom } from '@/helpers/chain';
import type { Asset } from '@/helpers/chain';
import { useAllMarkets } from '@/hooks/useManaged';
import { useChainRoute } from '@/hooks/useChainRoute';
import { useQueries } from '@tanstack/react-query';
import {
    getMarketCollateralPrice,
    getMarketCollateralCost,
    getMarketBalance,
    getManagedConfig,
    getTotalBorrowed,
} from '@/services/managed';
import { useCosmWasmClient } from '@/helpers/cosmwasmClient';
import { shiftDigits } from '@/helpers/math';
import useAppState from '@/persisted-state/useAppState';
import { formatTvl } from '../utils';

export function useManagedTableData() {
    const allMarkets = useAllMarkets();
    const { chainName } = useChainRoute();
    const { appState } = useAppState();
    const { data: client } = useCosmWasmClient(appState.rpcUrl);

    // State for filter dropdown
    const [selectedDeposits, setSelectedDeposits] = useState<string[]>(['All']);
    const [search, setSearch] = useState('');
    const { isOpen, onOpen, onClose } = useDisclosure();

    // Sorting state
    const [sortCol, setSortCol] = useState<'tvl' | 'multiplier' | 'cost' | null>(null);
    const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

    // New: Action selector state
    const [selectedAction, setSelectedAction] = useState<'multiply' | 'lend'>('multiply');

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
        const selectedDepositsSet = new Set(selectedDeposits);
        return derivedRows.filter(row => selectedDepositsSet.has(row.assetSymbol));
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

    return {
        allMarkets,
        chainName,
        selectedDeposits,
        setSelectedDeposits,
        search,
        setSearch,
        filterDisclosure: { isOpen, onOpen, onClose },
        sortCol,
        sortDir,
        handleSort,
        selectedAction,
        setSelectedAction,
        filteredOptions,
        selectedDisplay,
        sortedRows,
    };
}
