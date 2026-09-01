import React, { useEffect } from 'react';
import { useAssetBySymbol } from '@/hooks/useAssets';
import { useBalanceByAsset } from '@/hooks/useBalance';
import { useManagedMarket, useMarketDebtPrice, useMarketCollateralPrice } from '@/hooks/useManaged';
import { num, shiftDigits } from '@/helpers/num';
import useManagedAction from './useManagedMarketState';
import { useRouter } from 'next/router';
import useBorrowAndBoost from './useBorrowAndBoost';
import { useChainRoute } from '@/hooks/useChainRoute';

// Lifts the ManagedMarketAction data fetching, effects, handlers and derived
// calculations out of the component so the render tree can be split into focused
// subcomponents. Behavior is preserved verbatim.
const actionLabels = ["Multiply", "Lend"];//, "Strategize"];
const actionMap = ['multiply', 'lend'];//, 'strategize'];

const useManagedMarketActionData = (marketAddress: string, collateralSymbol: string) => {
    const { chainName } = useChainRoute();
    //Get collateral asset from symbol
    const collateralAsset = useAssetBySymbol(collateralSymbol, chainName);
    //Get market details
    const { data: market } = useManagedMarket(marketAddress, collateralAsset?.base || "");
    // const { data: config } = useManagedConfig(marketAddress);
    //Get collateral price
    const { data: collateralPriceData } = useMarketCollateralPrice(marketAddress, collateralAsset?.base || "");
    const { data: debtPriceData } = useMarketDebtPrice(marketAddress);
    const collateralPrice = collateralPriceData?.price || "0";
    const debtPrice = debtPriceData?.price || "0";
    // Get asset details and balance
    // (Assume assets array is available or fetched elsewhere, or use placeholder)
    // const assetDetails = useAssetByDenom(asset.base, 'osmosis', assets)
    // For now, use asset.logo

    // Zustand state (no selectedAction)
    const {
        managedActionState,
        setManagedActionState
    } = useManagedAction();

    // Placeholder: get max from balance (assume 100 for now)
    // const max = useBalanceByAsset(assetDetails)
    const maxBalance = useBalanceByAsset(collateralAsset);

    // Calculate max multiplier
    const maxBorrowLTV = parseFloat(market?.[0]?.collateral_params?.max_borrow_LTV || '0.67');
    const maxMultiplier = 1 / (1 - maxBorrowLTV);
    const liquidationLTV = parseFloat(market?.[0]?.collateral_params?.liquidation_LTV || '0');

    const STICKY_THRESHOLD = (maxMultiplier - 1) * 0.1;

    // Sticky points for slider
    const stickyPoints = [1, 1 + (maxMultiplier - 1) * 0.25, 1 + (maxMultiplier - 1) * 0.5, 1 + (maxMultiplier - 1) * 0.75, maxMultiplier];

    // Router for shallow routing
    const router = useRouter();
    const { tab: routeTab } = router.query;

    // Ensure ?tab=multiply is always present if missing
    useEffect(() => {
        if (!routeTab) {
            router.replace(
                {
                    pathname: router.pathname,
                    query: { ...router.query, tab: 'multiply' },
                },
                undefined,
                { shallow: true }
            );
        }
    }, [routeTab, router]);

    // Derive selected tab index from query param
    let selectedTab = 0;
    if (typeof routeTab === 'string') {
        const idx = actionMap.indexOf(routeTab);
        if (idx !== -1) selectedTab = idx;
    }

    // Snap slider to sticky points if close, else allow smooth
    const handleSliderChange = (val: number) => {
        const closest = stickyPoints.find(pt => Math.abs(pt - val) < STICKY_THRESHOLD);
        setManagedActionState({ multiplier: closest ?? val });
    };

    // Handle manual input for multiplier
    const handleMultiplierInput = (e: React.ChangeEvent<HTMLInputElement>) => {
        let val = parseFloat(e.target.value);
        if (isNaN(val)) val = 1;
        if (val < 1) val = 1;
        if (val > maxMultiplier) val = maxMultiplier;
        setManagedActionState({ multiplier: val });
    };

    // Handle Take Profit and Stop Loss input changes
    const handleTakeProfitChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        e.preventDefault();
        const val = e.target.value;
        if (val === '' || /^\d*\.?\d*$/.test(val)) setManagedActionState({ takeProfit: val });
    };
    const handleStopLossChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        e.preventDefault();
        const val = e.target.value;
        if (val === '' || /^\d*\.?\d*$/.test(val)) setManagedActionState({ stopLoss: val });
    };

    // Handle collateral amount input
    const handleCollateralAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setManagedActionState({ collateralAmount: e.target.value });
    };

    // Handle selected action/tab: update route shallowly with query param
    const handleTabChange = (idx: number) => {
        const newAction = actionMap[idx];
        const currentPath = router.asPath.split('?')[0];
        router.replace(
            {
                pathname: currentPath,
                query: { tab: newAction },
            },
            undefined,
            { shallow: true }
        );
    };

    // Add useBorrowAndBoost for Multiply action
    const { action: borrowAndBoost, debtAmount } = useBorrowAndBoost({
        marketContract: marketAddress,
        asset: collateralAsset!,
        managedActionState,
        maxBorrowLTV: maxBorrowLTV,
        run: selectedTab === 0, // Only run for Multiply tab
    });

    //Log borrowAndBoost errors
    // console.log("borrowAndBoost", borrowAndBoost.tx.error, borrowAndBoost.simulate.error, borrowAndBoost.simulate.errorMessage);

    // --- Calculations for LTV, Liquidation Price, Health ---
    const safeDebtAmountTokens = shiftDigits(debtAmount, -6).toString() || '0';
    const safeCollateralAmount = managedActionState.collateralAmount || '0';
    const safeliquidationLTV = isNaN(liquidationLTV) ? 0 : liquidationLTV;
    const safeCollateralPrice = collateralPrice || "0";
    const safeDebtPrice = debtPrice || "0";
    const collateralValue = num(safeCollateralAmount).times(safeCollateralPrice); // USD value
    const debtValue = num(safeDebtAmountTokens).times(safeDebtPrice); // USD value
    const ltv = debtValue && collateralValue.gt(0)
        ? debtValue.div(collateralValue).toNumber()
        : 0;
    // Liquidation price: price of collateral that would cause LTV to reach maxBorrowLTV
    // LTV = DebtValue / (CollateralAmount * CollateralPrice) = maxBorrowLTV
    // => CollateralPrice = DebtValue / (CollateralAmount * maxBorrowLTV)
    const liquidationPrice = (debtValue.gt(0) && safeCollateralAmount && safeliquidationLTV)
        ? debtValue.div(num(safeCollateralAmount).times(safeliquidationLTV)).toNumber()
        : 0;
    const health = (ltv && safeliquidationLTV)
        ? 1 - (ltv / safeliquidationLTV)
        : 1;
    ///////////

    return {
        collateralAsset,
        collateralPrice,
        debtPrice,
        managedActionState,
        setManagedActionState,
        maxBalance,
        maxMultiplier,
        stickyPoints,
        selectedTab,
        actionLabels,
        handleSliderChange,
        handleMultiplierInput,
        handleTakeProfitChange,
        handleStopLossChange,
        handleCollateralAmountChange,
        handleTabChange,
        borrowAndBoost,
        debtAmount,
        collateralValue,
        ltv,
        liquidationPrice,
        health,
    };
};

export type ManagedMarketActionData = ReturnType<typeof useManagedMarketActionData>;

export default useManagedMarketActionData;
