import React, { useState } from 'react';
import { getAssetByDenom } from '@/helpers/chain';
import type { Asset } from '@/helpers/chain';
import { useChainRoute } from '@/hooks/useChainRoute';
import { useBalanceByAsset } from '@/hooks/useBalance';
import { CDT_ASSET, STATIC_ORACLE_POOLS } from '@/config/defaults';
import useWallet from '@/hooks/useWallet';
import { useManagers } from '@/hooks/useManaged';
import useMarketCreation from './useMarketCreation';
import { usePoolInfo } from '@/hooks/useOsmosis';
import { useAssetBySymbol } from '@/hooks/useAssets';
import { MarketCreateState } from '../types';

// Define TWAPPoolInfo type at the top level
type TWAPPoolInfo = { pool_id: number; base_asset_denom: string; quote_asset_denom: string };

// Sticky points for slippage slider
const slippageStickyPoints = [5, 10];

export function useCreateMarketForm(isCreateOpen: boolean) {
    const { chainName } = useChainRoute();

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

    // Seed the debounced input buffer from the committed pool id only when the modal
    // opens. `createMarketState.osmosisPoolId` is intentionally excluded from deps: the
    // reverse effect below commits input -> state (debounced), so also syncing
    // state -> input on every change would make it a two-way binding that could clobber
    // the user's in-progress edit. Keyed on `isCreateOpen` to preserve the open-time init.
    // react-doctor(no-adjust-state-on-prop-change): kept — seeds a debounced, user-editable input buffer on modal-open (an external-trigger init, not a prop mirror), so it can't be derived. Idiomatic fix = remount via `key` on the parent modal (out of scope).
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
    const collateralAsset = useAssetBySymbol(createMarketState.collateralAsset, chainName);
    // Derived: pool is invalid when its base token doesn't match the selected collateral asset.
    // Pure function of token0/collateralAsset — no state chain needed.
    const invalidPoolID = token0 !== collateralAsset?.base;

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

    return {
        createMarketState,
        setCreateMarketState,
        osmosisPoolIdInput,
        setOsmosisPoolIdInput,
        oracles,
        slippageStickyPoints,
        handleSlippageChange,
        interestRateModelProps,
        irModelDescription,
        handleResetIRParams,
        isWhitelistedManager,
        cdtBalance,
        invalidPoolID,
        createMarket,
    };
}
