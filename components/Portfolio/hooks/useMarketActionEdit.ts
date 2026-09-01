import React, { useState, useMemo } from 'react';
import { useChainRoute } from '@/hooks/useChainRoute';
import { useAssetBySymbol } from '@/hooks/useAssets';
import useManagedAction from '@/components/ManagedMarkets/hooks/useManagedMarketState';
import useWallet from '@/hooks/useWallet';
import { useUserUXBoosts } from '@/hooks/useManaged';
import { useBalanceByAsset } from '@/hooks/useBalance';
import useCloseAndEditBoostsTx from './useCloseAndEditBoostsTx';

export type MarketActionEditProps = {
  assetSymbol: string;
  position: any;
  marketAddress: string;
  collateralDenom: string;
  maxLTV: number;
  collateralPrice: number;
  currentLTV: number;
  initialLiquidationPrice: string;
  onClose: () => void;
};

export const useMarketActionEdit = ({ assetSymbol, position, marketAddress, collateralDenom, maxLTV, collateralPrice, currentLTV, initialLiquidationPrice, onClose }: MarketActionEditProps) => {
  const { chainName } = useChainRoute();
  const asset = useAssetBySymbol(assetSymbol, chainName);
  const { setManagedActionState, managedActionState } = useManagedAction();
  const { address: userAddress } = useWallet();
  const { data: uxBoosts } = useUserUXBoosts(marketAddress, collateralDenom, userAddress ?? '');
  const [spread, setSpread] = useState(0.01);

  // Middleman state variables for immediate input updates
  const [inputCollateralAmount, setInputCollateralAmount] = useState(managedActionState.collateralAmount || '');
  const [inputTakeProfit, setInputTakeProfit] = useState(managedActionState.takeProfit || '');
  const [inputStopLoss, setInputStopLoss] = useState(managedActionState.stopLoss || '');
  const [inputMultiplier, setInputMultiplier] = useState(managedActionState.multiplier || '');
  const [inputClosePercent, setInputClosePercent] = useState(managedActionState.closePercent || '');
  const [inputBorrowAmount, setInputBorrowAmount] = useState(managedActionState.borrowAmount || '');
  const [inputRepayAmount, setInputRepayAmount] = useState(managedActionState.repayAmount || '');

  // Max multiplier
  const maxMultiplier = 1 / (1 - (maxLTV - currentLTV));

  // User balance for deposit
  const userBalance = Number(useBalanceByAsset(asset));

  // Calculate dynamic liquidation price
  const inputCollateral = Number(inputCollateralAmount) || 0;
  const decimals = asset?.decimal || 6;
  const baseCollateral = Number(position.collateral_amount) / Math.pow(10, decimals);
  const totalCollateral = baseCollateral + inputCollateral;
  const debt = Number(position.debt_amount) / 1e6; // assuming 6 decimals for debt
  const debtPrice = Number(position.debtPrice) || 1; // fallback to 1 if not available
  let dynamicLiquidationPrice = '-';
  if (totalCollateral > 0 && maxLTV > 0) {
    dynamicLiquidationPrice = ((debt / (totalCollateral * maxLTV)) * debtPrice).toFixed(4);
  }

  // Handlers with 600ms delay
  const timeoutRefs = React.useRef<{ [key: string]: NodeJS.Timeout }>({});

  const handleCollateral = React.useCallback((v: string) => {
    // Update middleman state immediately
    setInputCollateralAmount(v);

    // Update managedActionState after 600ms delay
    if (timeoutRefs.current.collateral) {
      clearTimeout(timeoutRefs.current.collateral);
    }
    timeoutRefs.current.collateral = setTimeout(() => {
      setManagedActionState({ collateralAmount: v });
    }, 600);
  }, [setManagedActionState]);

  const handleTP = React.useCallback((v: string) => {
    // Update middleman state immediately
    setInputTakeProfit(v);

    // Update managedActionState after 600ms delay
    if (timeoutRefs.current.takeProfit) {
      clearTimeout(timeoutRefs.current.takeProfit);
    }
    timeoutRefs.current.takeProfit = setTimeout(() => {
      setManagedActionState({ takeProfit: v });
    }, 600);
  }, [setManagedActionState]);

  const handleSL = React.useCallback((v: string) => {
    // Update middleman state immediately
    setInputStopLoss(v);

    // Update managedActionState after 600ms delay
    if (timeoutRefs.current.stopLoss) {
      clearTimeout(timeoutRefs.current.stopLoss);
    }
    timeoutRefs.current.stopLoss = setTimeout(() => {
      setManagedActionState({ stopLoss: v });
    }, 600);
  }, [setManagedActionState]);

  const handleMultiplier = React.useCallback((v: number) => {
    // Update middleman state immediately
    setInputMultiplier(Math.min(v, maxMultiplier).toFixed(2));

    // Update managedActionState after 600ms delay
    if (timeoutRefs.current.multiplier) {
      clearTimeout(timeoutRefs.current.multiplier);
    }
    timeoutRefs.current.multiplier = setTimeout(() => {
      setManagedActionState({ multiplier: Math.min(v, maxMultiplier) });
    }, 600);
  }, [maxMultiplier, setManagedActionState]);

  const handleClosePercent = React.useCallback((v: number) => {
    // Update middleman state immediately
    setInputClosePercent(v.toString());

    // Update managedActionState after 600ms delay
    if (timeoutRefs.current.closePercent) {
      clearTimeout(timeoutRefs.current.closePercent);
    }
    timeoutRefs.current.closePercent = setTimeout(() => {
      setManagedActionState({ closePercent: v });
    }, 600);
  }, [setManagedActionState]);

  const handleBorrow = React.useCallback((v: string) => {
    setInputBorrowAmount(v);
    if (timeoutRefs.current.borrow) {
      clearTimeout(timeoutRefs.current.borrow);
    }
    timeoutRefs.current.borrow = setTimeout(() => {
      setManagedActionState({ borrowAmount: v });
    }, 600);
  }, [setManagedActionState]);

  const handleRepay = React.useCallback((v: string) => {
    setInputRepayAmount(v);
    if (timeoutRefs.current.repay) {
      clearTimeout(timeoutRefs.current.repay);
    }
    timeoutRefs.current.repay = setTimeout(() => {
      setManagedActionState({ repayAmount: v });
    }, 600);
  }, [setManagedActionState]);

  const handleMax = () => {
    setInputCollateralAmount(userBalance.toString());
    setManagedActionState({ collateralAmount: userBalance.toString() });
  };

  // Sync middleman state with managedActionState
  React.useEffect(() => {
    setInputCollateralAmount(managedActionState.collateralAmount || '');
    setInputTakeProfit(managedActionState.takeProfit || '');
    setInputStopLoss(managedActionState.stopLoss || '');
    setInputMultiplier(managedActionState.multiplier || '');
    setInputClosePercent(managedActionState.closePercent || '');
    setInputBorrowAmount(managedActionState.borrowAmount || '');
    setInputRepayAmount(managedActionState.repayAmount || '');
  }, [managedActionState]);

  // Build tx action
  const { action } = useCloseAndEditBoostsTx({
    marketContract: marketAddress,
    collateralDenom,
    managedActionState,
    collateralPrice: collateralPrice.toString(),
    currentLTV: currentLTV.toString(),
    maxSpread: spread.toString(),
    decimals: asset?.decimal || 6,
    run: !!(managedActionState.closePercent || managedActionState.collateralAmount || managedActionState.takeProfit || managedActionState.stopLoss || managedActionState.multiplier || managedActionState.borrowAmount || managedActionState.repayAmount),
  });

  React.useEffect(() => {
    if (action.tx?.isSuccess) {
      onClose();
    }
  }, [action.tx.isSuccess, onClose]);

  // console.log('action', action.simulate.error, action.simulate.errorMessage);
  //If slippage is too lwo & it errors, increase it by 1%
  //The slippage error contains "max spread assertion"
  useMemo(() => {
    if (action.simulate.error && (action.simulate.error.message.includes("max spread assertion") || action.simulate.error.message.includes("token amount calculated"))) {
      setSpread((prev) => prev + 0.01)
      console.log("Increasing spread to", spread + 0.01)
    }
  }, [action.simulate.error, spread])
  // Determine close type for radio
  const closeType = Number(managedActionState.closePercent) === 100 ? 'full' : 'partial';
  // console.log('closePercent:', managedActionState.closePercent, 'closeType:', closeType);

  // Multiplier placeholder logic
  let multiplierPlaceholder = "1";
  if (uxBoosts && uxBoosts.loop_ltv) {
    try {
      const loopLtv = Number(uxBoosts.loop_ltv);
      if (!isNaN(loopLtv) && loopLtv !== 0 && loopLtv !== 1) {
        multiplierPlaceholder = (1 / (1 - loopLtv)).toFixed(2);
      }
    } catch { }
  }

  return {
    asset,
    inputCollateralAmount,
    handleCollateral,
    userBalance,
    handleMax,
    inputTakeProfit,
    handleTP,
    inputStopLoss,
    handleSL,
    inputBorrowAmount,
    handleBorrow,
    inputRepayAmount,
    handleRepay,
    dynamicLiquidationPrice,
    maxMultiplier,
    inputMultiplier,
    handleMultiplier,
    multiplierPlaceholder,
    closeType,
    inputClosePercent,
    handleClosePercent,
    setInputClosePercent,
    setManagedActionState,
    action,
    managedActionState,
  };
};

export default useMarketActionEdit;
