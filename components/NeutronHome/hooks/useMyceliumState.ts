import { useState, useMemo, useEffect, useRef } from 'react';
import { useBreakpointValue } from '@chakra-ui/react';

// @ts-ignore
import tinycolor from 'tinycolor2';
import { Asset } from '@/helpers/chain';
import useManagedAction from '@/components/ManagedMarkets/hooks/useManagedMarketState';
import useTransformExposure from '@/components/ManagedMarkets/hooks/useIncreasedExposureCard';
import { useBasket } from '@/hooks/useCDP';
import useAppState from '@/persisted-state/useAppState';
import useAssets from '@/hooks/useAssets';
import { Venue } from '../mockVenues';
import { ChartDataPoint } from '../MyceliumGrowthChart';

interface UseMyceliumStateParams {
    logo: string;
    glowColor?: string;
    balance?: string;
    price?: string;
    maxBorrowLTV?: number;
    maxLTV?: string;
    marketContract: string;
    asset?: Asset;
}

const useMyceliumState = ({ logo, glowColor, balance, price, maxBorrowLTV, maxLTV, marketContract, asset }: UseMyceliumStateParams) => {
    // Mock LTVs for common assets (values in 0-1)
    const MOCK_LTVS: Record<string, number> = useMemo(() => ({
        uosmo: 0.55,
        untrn: 0.6,
        uatom: 0.5,
        utia: 0.5,
        ucdt: 0.9,
        umbrn: 0.4,
        uusdc: 0.85,
        uusdt: 0.8,
    }), []);
    const [mode, setMode] = useState<'multiply' | 'de-risk'>('multiply');
    const [amount, setAmount] = useState('');
    const [selectedMultiplier, setSelectedMultiplier] = useState('conservative');
    const [selectedVenue, setSelectedVenue] = useState<Venue | null>(null);
    const carouselNavigateRef = useRef<((index: number) => void) | null>(null);
    const getShowAllStateRef = useRef<(() => boolean) | null>(null);
    const [ltvInputValue, setLtvInputValue] = useState<string>('0.0');
    const inputRef = useRef<HTMLInputElement>(null);
    const isMobile = useBreakpointValue({ base: true, md: false });
    const { appState } = useAppState();
    const { data: basket } = useBasket(appState.rpcUrl);
    const chainAssets = useAssets();
    const { managedActionState, setManagedActionState } = useManagedAction();

    // Selected asset state (default to prop asset)
    const [selectedAssetBase, setSelectedAssetBase] = useState<string | undefined>(asset?.base);
    const availableAssets = useMemo<Asset[]>(() => {
        // TODO(evm-migration): basket is null-stubbed (no aggregate basket view in Cdp.sol);
        // collateral_types has no faithful EVM equivalent here yet, so read defensively.
        const bases: string[] = ((basket as any)?.collateral_types || []).flatMap((ct: any) => {
            const denomOrBase = ct?.denom || ct?.base;
            return denomOrBase ? [denomOrBase] : [];
        });
        if (!chainAssets || !bases.length) return chainAssets || (asset ? [asset] as Asset[] : []);
        const basesSet = new Set(bases);
        return chainAssets.filter((a: Asset) => basesSet.has(a.base));
    }, [basket, (basket as any)?.collateral_types, chainAssets, asset]);

    // Auto-select first available asset if none selected
    useEffect(() => {
        if (availableAssets.length > 0 && !selectedAssetBase) {
            setSelectedAssetBase(availableAssets[0].base);
        }
    }, [availableAssets, selectedAssetBase]);

    const selectedAsset = useMemo<Asset | undefined>(() => {
        const found = availableAssets.find((a: Asset) => a.base === selectedAssetBase);
        return found || availableAssets[0] || asset;
    }, [availableAssets, selectedAssetBase, asset]);
    const symbol = selectedAsset?.symbol || asset?.symbol || 'SYM';
    const logoToShow = selectedAsset?.logo || logo;
    // Resolve maxBorrowLTV from basket collateral_types if available, else mock map, else prop
    const resolvedMaxBorrowLTV = useMemo(() => {
        const ct = (basket as any)?.collateral_types?.find((ct: any) => ct?.denom === selectedAsset?.base || ct?.base === selectedAsset?.base);
        const basketVal = ct?.max_loan_to_value;
        const mockVal = selectedAsset?.base ? MOCK_LTVS[selectedAsset.base] : undefined;
        const v = Number((basketVal ?? mockVal ?? maxBorrowLTV ?? 0));
        return isFinite(v) && v > 0 ? v : 0;
    }, [basket, (basket as any)?.collateral_types, selectedAsset?.base, maxBorrowLTV, MOCK_LTVS]);

    const maxMultiplier = resolvedMaxBorrowLTV > 0 ? 1 / (1 - resolvedMaxBorrowLTV) : 1;

    // Calculate conservative and moderate multipliers as percentages of max
    const conservativeMultiplier = resolvedMaxBorrowLTV > 0 ? (1 / (1 - (resolvedMaxBorrowLTV * 0.4))) : 1;
    const moderateMultiplier = resolvedMaxBorrowLTV > 0 ? (1 / (1 - (resolvedMaxBorrowLTV * 0.7))) : 1;

    // Update managed market state when amount, mode or slider/multiplier choice changes
    useEffect(() => {
        let multiplierValue;
        if (selectedMultiplier === 'max') {
            multiplierValue = maxMultiplier;
        } else if (selectedMultiplier === 'conservative') {
            multiplierValue = conservativeMultiplier;
        } else if (selectedMultiplier === 'moderate') {
            multiplierValue = moderateMultiplier;
        } else {
            multiplierValue = parseFloat(selectedMultiplier);
        }

        if (mode === 'multiply') {
            setManagedActionState({
                collateralAmount: amount,
                multiplier: multiplierValue,
            });
        } else {
            // For de-risk mode, no multiplier
            setManagedActionState({
                collateralAmount: amount,
                multiplier: undefined, // No multiplier for de-risk
            });
        }
    }, [amount, mode, selectedMultiplier, setManagedActionState, maxMultiplier, conservativeMultiplier, moderateMultiplier]);
    const liqPrice = useMemo(() => {
        if (!maxLTV || maxLTV === '—' || !price || price === '0') return '';

        // Calculate liquidation price with 10% LTV buffer
        const maxLTVNum = parseFloat(maxLTV);
        const currentPrice = parseFloat(price);

        var loopLTV = 1 - 1 / managedActionState.multiplier;
        if (maxBorrowLTV && loopLTV > maxBorrowLTV) {
            loopLTV = maxBorrowLTV;
        }
        console.log('loopLTV', loopLTV, maxBorrowLTV, managedActionState.multiplier);
        const bufferLTV = maxLTVNum / (mode === 'de-risk' ? 0.1 : loopLTV);

        // Liquidation price
        const liquidationPrice = currentPrice / bufferLTV;

        return liquidationPrice.toFixed(4);
    }, [maxLTV, price, maxBorrowLTV, managedActionState.multiplier, mode]);
    const buttonColor = glowColor ? tinycolor(glowColor).toHexString() : '#63b3ed';
    const displayBalance = balance !== undefined ? balance : '1000';
    const displayPrice = price !== undefined ? price : '0.00';
    const value = amount && price ? (parseFloat(amount) * parseFloat(displayPrice)).toFixed(2) : '0.00';
    const collateralValue = Number(value);
    const borrowAmount = (Number(value) / 10).toString();
    const { action: transformExposure } = useTransformExposure({
        marketContract: marketContract,
        asset: (selectedAsset ?? asset) as Asset,
        managedActionState: managedActionState,
        maxBorrowLTV: resolvedMaxBorrowLTV ?? 0,
        collateralValue: collateralValue,
        borrowAmount: borrowAmount,
        mode: mode,
        run: true,
    });

    // Sync ltvInputValue when multiplier changes (from slider)
    // but NOT when the user is actively typing in the input
    // no-chain-state-updates FP: not a derived-state chain — ltvInputValue is never a
    // dependency of this effect, the setter's value is already derived from
    // managedActionState.multiplier/resolvedMaxBorrowLTV (both in the deps array below),
    // and the effect legitimately synchronizes local input display to an external DOM
    // condition (document.activeElement), which an effect (not render) must read.
    useEffect(() => {
        const m = managedActionState.multiplier;
        if (!m || m <= 1) {
            if (document.activeElement !== inputRef.current) {
                setLtvInputValue('0.0');
            }
            return;
        }
        const ltv = 1 - 1 / m;
        const clampedLtv = Math.max(0, Math.min(resolvedMaxBorrowLTV, ltv)) * 100;

        // Only update if input is not focused (user is not typing)
        if (document.activeElement !== inputRef.current) {
            setLtvInputValue(clampedLtv.toFixed(1));
        }
    }, [managedActionState.multiplier, resolvedMaxBorrowLTV]);

    // Chart data calculation for 10-year compound growth
    const chartData = useMemo((): ChartDataPoint[] => {
        const amountNum = parseFloat(amount) || 0;
        if (amountNum <= 0) return [];

        const data: ChartDataPoint[] = [];
        const baseAPR = 0.10; // 10%
        const boostedAPR = 0.15; // 15%

        for (let year = 0; year <= 10; year++) {
            const baseAmount = amountNum * Math.pow(1 + baseAPR, year);
            const boostedAmount = amountNum * Math.pow(1 + boostedAPR, year);

            data.push({
                year,
                baseAmount: Math.round(baseAmount * 100) / 100,
                boostedAmount: Math.round(boostedAmount * 100) / 100
            });
        }

        return data;
    }, [amount]);

    return {
        logoToShow,
        symbol,
        amount,
        setAmount,
        value,
        selectedAsset,
        setSelectedAssetBase,
        availableAssets,
        displayBalance,
        mode,
        resolvedMaxBorrowLTV,
        maxMultiplier,
        managedActionState,
        setManagedActionState,
        setSelectedMultiplier,
        ltvInputValue,
        setLtvInputValue,
        inputRef,
        selectedVenue,
        setSelectedVenue,
        carouselNavigateRef,
        getShowAllStateRef,
        chartData,
        transformExposure,
        collateralValue,
        borrowAmount,
    };
};

export default useMyceliumState;
