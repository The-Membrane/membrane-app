import { useState, useEffect, useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import BigNumber from 'bignumber.js';
import { getObjectCookie, setObjectCookie } from '@/helpers/cookies';
import { useChainRoute } from '@/hooks/useChainRoute';
import useWallet from '@/hooks/useWallet';
import useAppState from '@/persisted-state/useAppState';
import { useCosmWasmClient } from '@/helpers/cosmwasmClient';
import useAssets from '@/hooks/useAssets';
import { useAllMarkets, useMarketDebtPrice } from '@/hooks/useManaged';
import { useUserPositions, useBasket } from '@/hooks/useCDP';
import { useUserBoundedIntents } from '@/hooks/useEarnQueries';
import { useOraclePrice } from '@/hooks/useOracle';
import { getMarketCollateralDenoms, useMarketNames, getUserPositioninMarket, getManagedMarket, getMarketCollateralCost, getMarketCollateralPrice } from '@/services/managed';
import { num } from '@/helpers/num';
import { shiftDigits } from '@/helpers/math';
import { denoms } from '@/config/defaults';

export const usePortfolioData = () => {
  const [tabIndex, setTabIndex] = useState(0);
  const [initialMarkets, setInitialMarkets] = useState<{ address: string; name: string }[]>([]);

  // Get chainName and userAddress from hooks
  const { chainName } = useChainRoute();
  const { address: userAddress } = useWallet();
  const { appState } = useAppState();
  const { data: cosmwasmClient } = useCosmWasmClient(appState.rpcUrl);
  const assets = useAssets(chainName);
  const allMarketsData = useAllMarkets();

  // Get CDP positions
  const { data: basketPositions } = useUserPositions();
  const { data: userIntents } = useUserBoundedIntents();
  const { data: basket } = useBasket(appState.rpcUrl);

  const neuroGuardIntents = useMemo(() => {
    if (!userIntents?.[0]?.intent?.intents?.purchase_intents) return [];
    return userIntents[0].intent.intents.purchase_intents
      .filter((intent: any) => intent.position_id !== undefined);
  }, [userIntents]);

  const cdpPositions = useMemo(() => {
    // TODO(evm-migration): useUserPositions now returns the flat EvmUserPosition[] (no nested
    // `.positions` / CosmWasm `collateral_assets`); read defensively until re-modeled.
    const bp = basketPositions as any
    if (bp && bp[0] && bp[0].positions) {
      return bp[0].positions
        .map((position: any, index: number) => ({ position, positionNumber: index + 1 }))
        .filter(({ position }: { position: any }) =>
          neuroGuardIntents.find((intent: any) => (intent.position_id ?? 0).toString() === position.position_id) === undefined
        );
    }
    return [];
  }, [basketPositions, neuroGuardIntents]);

  // On mount, read userMarkets cookie for fast initial UI
  useEffect(() => {
    const cachedMarkets = getObjectCookie('userMarkets') || [];
    setInitialMarkets(cachedMarkets.map((address: string) => ({ address, name: 'Cached Market' })));
  }, []);

  const marketsToQuery = useMemo(() => {
    if (allMarketsData && allMarketsData.length > 0) {
      return allMarketsData;
    }
    return initialMarkets;
  }, [allMarketsData, initialMarkets]);

  // Get all prices (oracle)
  const { data: prices = [] } = useOraclePrice();
  // TODO(evm-migration): basket is null-stubbed; credit_price has no EVM equivalent here yet.
  const cdtMarketPrice = prices?.find((price) => price.denom === denoms.CDT[0])?.price || (basket as any)?.credit_price?.price || "1";

  // Get debt price (use first static market)
  const { data: debtPriceData } = useMarketDebtPrice(marketsToQuery[0]?.address);
  const debtPrice = debtPriceData?.price ? Number(debtPriceData.price) : undefined;

  // 1. Fetch all collateral denoms for all static markets using useQueries
  const collateralDenomsQueries = useQueries({
    queries: marketsToQuery.map((market: any) => ({
      queryKey: ['collateral_denoms', market.address, cosmwasmClient],
      queryFn: () => {
        if (!cosmwasmClient || !market.address) return Promise.resolve([]);
        return getMarketCollateralDenoms(cosmwasmClient, market.address);
      },
      enabled: !!cosmwasmClient && !!market.address,
      staleTime: 1000 * 60 * 5,
    })),
  });

  // 2. Once all collateral denoms are loaded, build all (market, collateral) pairs
  const allMarketCollateralPairs = marketsToQuery.flatMap((market: any, mIdx: number) => {
    const q = collateralDenomsQueries[mIdx];
    if (!q || q.isLoading || q.isError || !Array.isArray(q.data)) return [];
    return q.data.map((collateralDenom: string) => ({ market, collateralDenom }));
  });

  // 3. Fetch all user positions for all (market, collateral) pairs using useQueries
  const userPositionQueries = useQueries({
    queries: allMarketCollateralPairs.map(({ market, collateralDenom }: { market: any, collateralDenom: string }) => ({
      queryKey: ['user_position', market.address, collateralDenom, userAddress, cosmwasmClient],
      queryFn: () => {
        if (!cosmwasmClient) return Promise.resolve([]);
        return getUserPositioninMarket(cosmwasmClient, market.address, collateralDenom, userAddress || '');
      },
      enabled: !!userAddress,
      staleTime: 1000 * 60 * 2,
    })),
  });

  // 4. Aggregate all positions
  const positions = userPositionQueries
    .flatMap((q, idx) => {
      if (q.isLoading || q.isError || !Array.isArray(q.data)) return [];
      const { market, collateralDenom } = allMarketCollateralPairs[idx];
      return q.data.flatMap((pos: any) => {
        const p = {
          ...pos.position,
          user: pos.user,
          marketAddress: market.address,
          marketName: market.name,
          asset: collateralDenom,
        };
        return p && Number(p.collateral_amount) > 0 ? [p] : [];
      });
    });

  // After full query, update displayedMarkets and cookie if needed
  useMemo(() => {
    if (positions.length > 0) {
      const newMarkets = [...new Set(positions.map((p) => p.marketAddress))];
      const currentMarkets = getObjectCookie('userMarkets') || [];

      if (JSON.stringify(newMarkets.sort()) !== JSON.stringify(currentMarkets.sort())) {
        if (appState.setCookie) {
          setObjectCookie('userMarkets', newMarkets, 30);
        }
      }
    }
  }, [positions, appState.setCookie]);

  // Use the batch hook to get all market names
  const marketNames = useMarketNames(positions.map(p => p.marketAddress));

  // Fetch collateral prices for all positions
  const collateralPriceQueries = useQueries({
    queries: positions.map((position) => ({
      queryKey: ['collateral_price', position.marketAddress, position.asset],
      queryFn: () => {
        if (!cosmwasmClient || !position.marketAddress || !position.asset) return Promise.resolve(undefined);
        return getMarketCollateralPrice(cosmwasmClient, position.marketAddress, position.asset);
      },
      enabled: !!cosmwasmClient && !!position.marketAddress && !!position.asset,
      staleTime: 1000 * 60 * 5,
    })),
  });

  // Fetch collateral costs for all positions
  const collateralCostQueries = useQueries({
    queries: positions.map((position) => ({
      queryKey: ['collateral_cost', position.marketAddress, position.asset],
      queryFn: () => {
        if (!cosmwasmClient || !position.marketAddress || !position.asset) return Promise.resolve(undefined);
        return getMarketCollateralCost(cosmwasmClient, position.marketAddress, position.asset);
      },
      enabled: !!cosmwasmClient && !!position.marketAddress && !!position.asset,
      staleTime: 1000 * 60 * 5,
    })),
  });

  // Fetch maxLTV for all positions
  const maxLTVQueries = useQueries({
    queries: positions.map((position) => ({
      queryKey: ['maxLTV', position.marketAddress, position.asset, cosmwasmClient],
      queryFn: () => {
        if (!cosmwasmClient || !position.marketAddress || !position.asset) return Promise.resolve(undefined);
        return getManagedMarket(cosmwasmClient, position.marketAddress, position.asset);
      },
      enabled: !!cosmwasmClient && !!position.marketAddress && !!position.asset,
      staleTime: 1000 * 60 * 5,
    })),
  });

  // Derived loading state (pure function of tabIndex + query loading states — no state chain).
  // Non-CDP tabs have no async work here, so they are never loading.
  const loading = tabIndex === 0
    ? (collateralDenomsQueries.some((q) => q.isLoading) ||
       userPositionQueries.some((q) => q.isLoading))
    : false;

  // Compute global stats from filteredPositions
  const cdpMetrics = useMemo(() => {
    if (!cdpPositions.length || !prices?.length || !assets.length || !cdtMarketPrice) {
      return { tvl: new BigNumber(0), debt: new BigNumber(0) };
    }

    let totalTvl = new BigNumber(0);
    let totalDebt = new BigNumber(0);

    cdpPositions.forEach((cdp: any) => {
      // Calculate Debt in USD
      const debtAmount = num(shiftDigits(cdp.position.credit_amount, -6));
      totalDebt = totalDebt.plus(debtAmount.times(cdtMarketPrice));

      // Calculate TVL
      cdp.position.collateral_assets.forEach((collateral: any) => {
        const assetInfo = assets.find(a => a.base === collateral.asset.info.native_token.denom);
        const priceInfo = prices?.find(p => p.denom === collateral.asset.info.native_token.denom);

        if (assetInfo && priceInfo) {
          const collateralAmount = shiftDigits(collateral.asset.amount, -(assetInfo.decimal || 6));
          const collateralValue = num(collateralAmount).times(priceInfo.price);
          totalTvl = totalTvl.plus(collateralValue);
        }
      });
    });

    return { tvl: totalTvl, debt: totalDebt };
  }, [cdpPositions, prices, assets, cdtMarketPrice]);

  const tvl = positions.reduce((acc, p: any) => {
    const assetPrice = prices?.find((pr) => pr.denom === p.asset)?.price || 0;
    const asset = assets.find((a: any) => a.base === p.asset);
    const decimals = asset?.decimal || 6;
    return acc.plus(num(shiftDigits(p.collateral_amount, -decimals)).times(assetPrice));
  }, new BigNumber(0)).plus(cdpMetrics.tvl);
  const totalDebt = positions.reduce((acc, p: any) => acc.plus(num(shiftDigits(p.debt_amount, -6))), new BigNumber(0)).plus(cdpMetrics.debt);
  const netAssetValue = tvl.minus(totalDebt);

  const stats = [
    { label: 'Your TVL', value: `$${tvl.toFixed(2)}` },
    { label: 'Your debt', value: `$${totalDebt.toFixed(2)}` },
    { label: 'Net asset value', value: `$${netAssetValue.toFixed(2)}` },
  ];

  return {
    tabIndex,
    setTabIndex,
    loading,
    chainName,
    assets,
    positions,
    cdpPositions,
    marketNames,
    debtPrice,
    collateralPriceQueries,
    collateralCostQueries,
    maxLTVQueries,
    cdtMarketPrice,
    stats,
  };
};

export default usePortfolioData;
