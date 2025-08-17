import { Stack, Checkbox, useDisclosure } from '@chakra-ui/react'

import React, { useCallback, useEffect, useMemo, useState } from "react"
import useToaster from '@/hooks/useToaster'
import NeuroGuardCard from './NeuroGuardCard'
import useAppState from '../../persisted-state/useAppState'
import { HomeTitle } from './HomeTitle'
import { RulesModal } from '../MembersRules/RulesModal'
import useMembersRulesState from '../MembersRules/useRules'
import { set } from 'react-hook-form'
import PointsLeaderboard from './PointsLeaderboard'
import { useLeaderboardData } from '@/hooks/usePoints'
import AcquireCDTEntry from './AcquireCDTEntry'
import useWallet from '@/hooks/useWallet'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useBalanceByAsset } from '@/hooks/useBalance'
import { useBasket, useCollateralInterest } from '@/hooks/useCDP'
import { simpleBoundedAPRCalc, useBoundedCDTVaultTokenUnderlying, useBoundedTVL } from '@/hooks/useEarnQueries'
import { num } from '@/helpers/num'
import { shiftDigits } from '@/helpers/math'

// Memoize child components
// const MemoizedRangeBoundVisual = React.memo(RangeBoundVisual)
// const MemoizedRangeBoundLPCard = React.memo(RangeBoundLPCard)
// const MemoizedNeuroGuardCard = React.memo(NeuroGuardCard)

const Home = () => {
  //Remove persisted state, we can get rid of this over time
  useEffect(() => {
    localStorage.removeItem('basketState');
    localStorage.removeItem('pointsState');
    localStorage.removeItem('userIntentState');
    localStorage.removeItem('userPositionState');
    localStorage.removeItem('stakeState');
  }, []);


  console.log("Home")

  const { appState, setAppState } = useAppState(); useMemo(() => {
    if (appState.rpcUrl !== 'https://osmosis-rpc.polkachu.com/') {
      setAppState({ rpcUrl: 'https://osmosis-rpc.polkachu.com/' });
    }
  }, [appState.rpcUrl, setAppState]);
  const { rulesState } = useMembersRulesState()

  const [hasShownToast, setHasShownToast] = useState(false);
  const toaster = useToaster();

  // Memoize the toggle handler to prevent recreating on each render
  const handleToggle = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setAppState({ setCookie: event.target.checked });
  }, [setAppState]);

  // Memoize the toast content to prevent recreating on each render
  const toastContent = useMemo(() => ({
    title: 'Accept Cookies',
    message: (
      <Checkbox
        checked={appState?.setCookie}
        onChange={handleToggle}
        fontFamily="Inter"
      >
        Accept cookies to track profits & optimize load times
      </Checkbox>
    ),
    duration: null
  }), [appState?.setCookie, handleToggle]);

  // Show toast effect with proper dependencies
  useEffect(() => {
    if (!hasShownToast && appState?.setCookie === undefined && !rulesState.show) {
      toaster.message(toastContent);
      setHasShownToast(true);
    }
  }, [hasShownToast, appState?.setCookie, toastContent, toaster, rulesState.show]);

  // Handle toaster dismissal with proper effect
  useEffect(() => {
    if (appState?.setCookie) {
      toaster.dismiss();
    }
  }, [appState?.setCookie, toaster]);



  const { data: leaderboardData } = useLeaderboardData()

  const { address } = useWallet()
  const { appState } = useAppState()
  const { data: basket } = useBasket(appState.rpcUrl)
  const { data: TVL } = useBoundedTVL()
  const { data: interest } = useCollateralInterest()

  const usdcAsset = useAssetBySymbol('USDC')
  const usdcBalance = useBalanceByAsset(usdcAsset) ?? "0"

  const boundCDTAsset = useAssetBySymbol('range-bound-CDT')
  const boundCDTBalance = useBalanceByAsset(boundCDTAsset) ?? "1"
  const { data: underlyingData } = useBoundedCDTVaultTokenUnderlying(
    num(shiftDigits(boundCDTBalance, 6)).toFixed(0)
  )

  const calculatedRBYield = useMemo(() => {
    if (!basket || !interest || !TVL) return "0";
    return simpleBoundedAPRCalc(shiftDigits(basket.credit_asset.amount, -6).toNumber(), interest, TVL, 0);
  }, [basket, interest, TVL]);

  const underlyingCDT = useMemo(() =>
    shiftDigits(underlyingData, -6).toString() ?? "0"
    , [underlyingData])

  // Memoize the entire content to prevent unnecessary re-renders
  return (
    <Stack>
      {/* <RulesModal isOpen={isOpen} onClose={onClose} /> */}
      <HomeTitle />
      <AcquireCDTEntry usdcBalance={Number(usdcBalance)} RBYield={calculatedRBYield} rblpDeposit={Number(underlyingCDT)} address={address ?? ""} />
      {/* <PointsLeaderboard data={leaderboardData} /> */}
    </Stack>
  );

};

// Only use memo if this component's parent might cause unnecessary re-renders
export default Home;