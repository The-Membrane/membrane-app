import { Button, Grid, GridItem, Text, Stack, useBreakpointValue, Checkbox } from '@chakra-ui/react'
import { StatsCard } from '../StatsCard'
import SPCard from './QASPCard'
import EarnCard from './QAEarnCard'

import React, { useCallback, useEffect, useMemo, useState } from "react"
import RangeBoundLPCard from './RangeBoundLPCard'
import RangeBoundVisual from './RangeBoundVisual'
import { FaArrowDown, FaArrowUp } from 'react-icons/fa6'
import useVaultSummary from '../Mint/hooks/useVaultSummary'
import { colors, MAX_CDP_POSITIONS } from '@/config/defaults'
import { useUserPositions } from '@/hooks/useCDP'
import useToaster from '@/hooks/useToaster'
import { num } from '@/helpers/num'
import useMintState from '../Mint/hooks/useMintState'
import NeuroGuardCard from './NeuroGuardCard'
import { useUserBoundedIntents } from '../Earn/hooks/useEarnQueries'
import useNeuroState from './hooks/useNeuroState'
import useAppState from '../useAppState'


// Memoize child components
// const MemoizedRangeBoundVisual = React.memo(RangeBoundVisual)
// const MemoizedRangeBoundLPCard = React.memo(RangeBoundLPCard)
// const MemoizedNeuroGuardCard = React.memo(NeuroGuardCard)

const Home = () => {
  console.log("Home")
  const { appState, setAppState } = useAppState();
  // const [hasShownToast, setHasShownToast] = useState(false);
  // const toaster = useToaster();

  // Memoize the toggle handler to prevent recreating on each render
  // const handleToggle = useCallback((event) => {
  //   setAppState({ setCookie: event.target.checked });
  // }, [setAppState]);

  // // Memoize the toast content to prevent recreating on each render
  // const toastContent = useMemo(() => ({
  //   title: 'Accept Cookies',
  //   message: (
  //     <Checkbox
  //       checked={appState?.setCookie}
  //       onChange={handleToggle}
  //       fontFamily="Inter"
  //     >
  //       Accept cookies to track profits & optimize load times
  //     </Checkbox>
  //   ),
  //   duration: null
  // }), [appState?.setCookie, handleToggle]);

  // // Show toast effect with proper dependencies
  // useEffect(() => {
  //   if (!hasShownToast && appState?.setCookie === undefined) {
  //     toaster.message(toastContent);
  //     setHasShownToast(true);
  //   }
  // }, [hasShownToast, appState?.setCookie, toastContent, toaster]);

  // // Handle toaster dismissal with proper effect
  // useEffect(() => {
  //   if (appState?.setCookie) {
  //     toaster.dismiss();
  //   }
  // }, [appState?.setCookie, toaster]);

  // Memoize the entire content to prevent unnecessary re-renders
  const content = () => (
    <Stack>
      <StatsCard />
      <Stack>
        <NeuroGuardCard />
      </Stack>
    </Stack>
  );

  return content;
};

// Only use memo if this component's parent might cause unnecessary re-renders
export default Home;